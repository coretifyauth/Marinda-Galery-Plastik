# Document Numbering — Schema

Padanan naratif: `docs/architecture/document-numbering-schema.md`. Domain context: `memory/domain/document-numbering.md`.

## Generate Nomor Otomatis

**`document_number_types`** — master jenis dokumen. `doc_type` sengaja sama persis dengan nama tabel transaksionalnya (bukan singkatan/enum terpisah) supaya gak ada 2 sumber kebenaran soal "apa nama jenis dokumen ini" — kalau ada tabel baru butuh nomor, `doc_type`-nya otomatis jelas.

```sql
create table document_number_types (
  doc_type text primary key,
  prefix text not null unique,
  label text not null
);
```

Seed 29 baris (1 per tabel transaksional yang punya kolom `source_ref`, hasil audit lengkap seluruh migration) + 1 baris ke-30 tambahan belakangan (`item_unit_barcodes`, migration `0022_item_unit_barcode_reuse_document_numbering.sql`, lihat catatan pengecualian di bawah tabel):

| doc_type | prefix | label |
|---|---|---|
| ap_bills | APB | AP Bill |
| ap_payments | APP | AP Payment |
| ap_credit_notes | APC | Retur AP — Kurangi Utang |
| purchase_replacements | APX | Retur AP — Tukar Barang |
| purchase_writeoffs | APW | Retur AP — Tulis-jadi-Beban |
| ap_return_credit_refunds | APF | Refund Piutang Retur Supplier |
| ap_deposits | APD | AP Deposit (DP ke Supplier) |
| ap_deposit_applications | ADA | Penerapan DP AP |
| ap_deposit_refunds | ADR | Refund DP AP |
| ap_deposit_forfeitures | ADF | DP AP Hangus |
| ar_invoices | ARI | AR Invoice |
| ar_payments | ARP | AR Payment |
| ar_credit_notes | ARC | Retur AR |
| ar_return_credit_refunds | ARF | Refund Saldo Kredit Retur AR |
| warranty_replacements | AWR | Ganti Barang Garansi AR |
| ar_deposits | ARD | AR Deposit (DP dari Customer) |
| ar_deposit_applications | RDA | Penerapan DP AR |
| ar_deposit_refunds | RDR | Refund DP AR |
| ar_deposit_forfeitures | RDF | DP AR Hangus |
| ar_bad_debt_writeoffs | ARW | Write-off Piutang Tak Tertagih |
| purchase_orders | PO | Purchase Order |
| sales_orders | SO | Sales Order |
| goods_issues | GI | Goods Issue |
| production_orders | PRD | Production Order |
| stock_opnames | SOP | Stock Opname |
| pos_sales | POS | POS Sale |
| journal_entries | JE | Journal Entry (manual) |
| period_closings | CLS | Tutup Buku |
| depreciation_entries | DEPR | Posting Penyusutan |
| item_unit_barcodes | SKU | Kode Scan Barang (item_units.barcode) |

**Baris ke-30, `item_unit_barcodes`, PENGECUALIAN dari aturan "`doc_type` = nama tabel transaksional" di atas** — gak ada tabel `item_unit_barcodes` beneran (`memory/architecture/data/inventory-schema.md` submodule "Kode Scan Barang"). Kode ini nempel ke SEBAGIAN baris `item_units` yang user pilih generate satu-satu (tombol "Buat Kode" di `/items/[id]`), bukan otomatis 1 nomor per baris kayak 29 doc_type lain di atas yang selalu digenerate barengan tiap row transaksi baru diinsert. Aman dipakai walau bukan nama tabel — `generate_document_number()` di bawah cuma butuh `doc_type` buat lookup `prefix` + upsert counter, gak ada dynamic SQL yang mengasumsikan tabel bernama itu exist (dikonfirmasi eksplisit lewat `schema-reviewer` sebelum migration `0022` diterapkan).

**`document_number_counters`** — penghitung urutan per `(doc_type, year)`. Composite PK memaksa uniqueness + jadi kunci upsert atomik; `year` bukan kolom generated dari tanggal transaksi manapun — dihitung dari `extract(year from now())` (waktu server saat nomor digenerate), bukan tanggal dokumen yang mungkin di-backdate.

```sql
create table document_number_counters (
  doc_type text not null references document_number_types(doc_type),
  year int not null,
  last_number int not null default 0,
  primary key (doc_type, year)
);
```

**Fungsi `generate_document_number`** — satu-satunya cara resmi dapat nomor baru. `security definer` (bukan `invoker`) — `document_number_counters` sengaja gak ada grant/policy write sama sekali buat `authenticated` (lihat di bawah), jadi fungsi ini butuh jalan pakai privilege pemilik fungsi buat bisa insert/update ke situ, sama pola `create_pos_sale` (`memory/architecture/data/pos-schema.md`). `set search_path = public, pg_temp` wajib di tiap `security definer` function (anti search_path hijacking, konvensi project ini).

```sql
create or replace function generate_document_number(p_doc_type text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_year int := extract(year from now())::int;
  v_prefix text;
  v_seq int;
begin
  select prefix into v_prefix from document_number_types where doc_type = p_doc_type;
  if v_prefix is null then
    raise exception 'Unknown doc_type: %', p_doc_type;
  end if;

  insert into document_number_counters (doc_type, year, last_number)
  values (p_doc_type, v_year, 1)
  on conflict (doc_type, year)
    do update set last_number = document_number_counters.last_number + 1
  returning last_number into v_seq;

  return v_prefix || '-' || v_year || '-' || lpad(v_seq::text, 5, '0');
end;
$$;

grant execute on function generate_document_number(text) to authenticated;
```

**Kenapa gak digabung ke tiap RPC create (`create_ap_bill`, dst) jadi 1 transaksi**: akan berarti ubah signature/body 28 RPC yang sudah ada dan sudah dipakai di production. Sebagai gantinya, frontend panggil `generate_document_number(doc_type)` sendiri tepat sebelum panggil RPC create yang sudah ada, hasilnya dioper sebagai `p_source_ref` — persis kayak dulu user ketik manual, cuma sekarang string-nya dari sini. Trade-off: nomor bisa "kepakai tapi gak ada dokumennya" kalau call kedua (create) gagal setelah call pertama (generate) sukses — diterima, lihat `memory/domain/document-numbering.md` submodule "Kapan Nomor Ditentukan".

**RLS**: gak ada policy sama sekali (bukan cuma insert/update) untuk role `authenticated` di `document_number_counters` maupun `document_number_types` — satu-satunya jalur nulis adalah lewat fungsi `generate_document_number`, yang `security definer` (jalan pakai privilege pemilik fungsi, bypass RLS table-level sebagai owner) — client gak pernah dapat akses langsung ke tabelnya sama sekali, cuma lewat `grant execute` ke fungsinya. `document_number_types` tambahan dapat `grant select` eksplisit ke `authenticated` (dropdown/label kalau dibutuhkan UI) karena "Automatically expose new tables" dimatikan di project settings — grant eksplisit wajib walau sudah ada select policy, konvensi sama semua tabel lain (lihat `tax_settings` di `memory/architecture/data/ar-schema.md`). `document_number_counters` gak dapat grant select apa pun — client gak pernah perlu baca counter mentah.

## AP Bill — Nomor Nota Supplier

**Kolom baru** — `ap_bills.supplier_document_ref text null`. Nullable karena gak semua transaksi punya nota fisik resmi (ambil barang informal, dsb) — beda dari `source_ref` yang `not null` karena sekarang selalu ada (auto-generate).

```sql
alter table ap_bills add column supplier_document_ref text;
```

**RPC `create_ap_bill`** — dapat 1 parameter baru di akhir signature (additive, gak breaking): `p_supplier_document_ref text default null`. Disimpan apa adanya ke kolom baru, gak ada validasi format/uniqueness.

Referensi RPC lengkap (signature sebelumnya): `memory/architecture/data/ap-schema.md` submodule "Kategori Campur & PPN".

## Data Lama — Gak Dibackfill

**Peta Data (ERD)**
- Gak ada tabel baru. `source_ref` di semua tabel transaksional yang sudah punya data SEBELUM migration ini tetap berisi teks manual asli, gak pernah ditulis ulang.

**Alur Teknis**
- Backfill data lama (2026-08-13) sempat disiapkan sebagai migration data terpisah (rencana: `UPDATE ... SET source_ref = ...` per 27 tabel, urut per tanggal transaksi asli per `(doc_type, year)`, lanjut dari `document_number_counters` yang ada) — GAGAL karena setiap tabel transaksional punya trigger `<table>_block_edit_delete` (pola sama dengan `journal_entries_block_edit_delete` di `0003_journal_entry_schema.sql`) yang me-raise exception untuk SEMUA `before update or delete`, tanpa syarat periode closed — penegakan level-DB dari invariant "no editing posted entries, reversing entry only", bukan cuma level aplikasi.
- Opsi disable trigger sementara (1 transaksi atomik: `alter table ... disable trigger ...` → backfill → `enable trigger ...`) diajukan ke owner untuk 27 tabel yang bukan `journal_entries`/`depreciation_entries` (dua itu udah duluan dikecualikan karena nomornya cuma bisa ditulis ke `journal_entries.source_ref`, yang juga kena trigger sama). **Ditolak** — keputusan: gak ada backfill sama sekali, migration data-nya gak jadi dibuat/dijalankan.

**Aturan Bisnis → RPC**
- Trigger `block_edit_delete` yang menjaga invariant "Tiap journal entry: ... No edit posted/closed period — hanya reversing entry" (`AGENTS.md` Core Invariants) ternyata diterapkan lebih luas dari sekadar `journal_entries` — melindungi SEMUA kolom di SEMUA tabel transaksional termasuk `source_ref`, gak dibatasi ke nominal/debit-kredit atau ke periode yang sudah closed.

**Interaksi Antar Tabel**
- Gak ada perubahan skema/RPC. UI (list & detail) menampilkan `source_ref` apa adanya — teks manual lama untuk dokumen pre-`0011_document_numbering.sql`, format `PREFIX-TAHUN-URUTAN` untuk dokumen post-migration. Keputusan tampilan: `memory/preferences/ui/document-number-display.md`.
