# Accounts Payable — Schema (Finalized)

Fase 4 roadmap. Ref konsep bisnis: `docs/domain/accounts-payable.md` + `memory/domain/accounts-payable.md`. Ref schema yang di-reuse: `memory/architecture/data/journal-entry-schema.md` (RPC `create_journal_entry`+`reverse_journal_entry`, fungsi `set_updated_at()`+`block_edit_delete()`). Ref pola yang di-mirror: `memory/architecture/data/ar-schema.md` — struktur DDL identik, cuma arah kebalik (kita berutang, bukan piutang).

Struktur module → submodule di file ini SAMA urutannya dengan `docs/architecture/ap-schema.md` dan `memory/domain/accounts-payable.md` (lihat `AGENTS.md` > "Format Baku: Struktur Module → Submodule"). Submodule yang lahir sebagai konsekuensi langsung dari submodule lain (AP Return Credit dari Retur Barang, pencabutan `apply_ap_return_credit` dari Retur Barang juga, "AP Payment — Selaras AR" dari Konsep Inti) digabung ke submodule induknya.

## Konsep Inti

**`ap_bills` DIGABUNG ke `transactions` (kolom `type='OUTBOUND'`), migration `0063`-`0067` (2026-09-05)** — DDL/RPC `create_ap_bill`/RLS/Grant tabel bill itu sendiri sekarang didokumentasikan di `memory/architecture/data/transactions-schema.md`, GAK DIULANG di sini (pola sama `counterparty-schema.md`). Submodule di bawah ini (Retur Barang ke Supplier, Uang Muka/DP AP, RPC `ap_payments`/`ap_credit_notes`/dst yang TETAP tabel terpisah) masih di sini apa adanya — cuma kolom `bill_id`-nya sekarang FK ke `transactions(id)`, bukan `ap_bills(id)` lagi.

### Keputusan

- **Struktur DDL mirror persis AR** — `suppliers` ganti `customers`, `ap_bills` ganti `ar_invoices` (keduanya sekarang gabung jadi `transactions`), `ap_payments` ganti `ar_payments`. Alasan yang sama semua berlaku (immutability, due_date snapshot, status derived, anti overpay) — gak diulang detail di sini, cuma bagian yang beda yang dijelasin. `ap_payment_allocations` (tabel jembatan many-to-many) sempat ada dari desain awal, **dicabut migration `0011_ap_payment_single_bill.sql`** — lihat bagian "AP Payment — Selaras AR (0011)" di bawah.
- **`payment_term_days` di `suppliers` maknanya kebalik dari `customers`** — di AR itu syarat yang KITA tetapkan; di AP itu syarat yang KITA TERIMA dari supplier. Kolom & mekanisme snapshot `due_date`-nya identik, cuma konteks bisnisnya beda (ref `docs/domain/accounts-payable.md`).
- **`create_ap_bill` terima kategori debit sebagai parameter, gak di-hardcode ke 1 kategori** — beda dari AR yang debit-nya selalu ke akun Piutang Usaha (fixed secara konsep), bill di AP bisa debit ke Persediaan (beli bahan baku) ATAU Beban (beli jasa/sewa/utility) tergantung jenis pembelian, sama pola `create_journal_entry`. Sejak migration `0025`, ini bahkan bisa lebih dari 1 kategori sekaligus dalam 1 nota (`p_debit_lines` array) — lihat submodule "Compounding & PPN" di bawah.
- **Cancellation guard (`cancel_ap_bill`) diterapkan dari awal**, bukan ditambah belakangan — beda dari AR yang nambahnya belakangan setelah kebukti perlu lewat diskusi. Di AP langsung include karena polanya udah teruji.
- Money pakai `numeric(14,2)`, bukan float (invariant `AGENT.md`).

### DDL

#### `counterparties` (dulu `suppliers`) — master data pihak yang CV Barokah berutang

**Migration `0059_counterparty_schema.sql` (2026-09-03)**: `suppliers` digabung dengan `customers` (AR) jadi 1 tabel `counterparties` — Fase 1 order-generalization (keputusan owner, closed 2026-09-04). Detail lengkap DDL, trigger type-safety (`counterparty_role_guard`), dan dampak lintas modul: `memory/architecture/data/counterparty-schema.md`. `ap_bills.supplier_id`/`ap_payments.supplier_id`/dst FK-nya sekarang nunjuk `counterparties(id)` — kolom & nama tetap `supplier_id`, cuma target FK yang berubah. Makna `payment_term_days` tetap kebalik dari sisi AR (syarat yang KITA TERIMA dari supplier, bukan yang kita tetapkan) — cuma sumber tabelnya sekarang gabungan, bukan berarti maknanya ikut gabung.

**`credit_limit`/`overdue_threshold_days` (kolom AR, dulu gak dipakai sisi supplier) SUDAH DIDROP total migration `0065`** — bagian dari pencabutan fitur Credit Hold di sisi AR, lihat `ar-schema.md` + `transactions-schema.md` > "Keputusan". Gak pernah relevan buat AP sejak awal, sekarang bahkan gak ada lagi di `counterparties`.

`set_updated_at()` di-reuse dari `coa-schema.md`. DDL final `counterparties` (bentuk sekarang, pasca `0065`): `memory/architecture/data/counterparty-schema.md`.

#### `ap_payments` DIGABUNG ke `payments` (kolom `type='OUTBOUND'`), migration `0069` (2026-09-05)

**Fase 1** dari unifikasi tabel anak AR/AP — mirror pola `transactions`, lihat
`memory/architecture/data/payments-schema.md` buat DDL/RPC/RLS lengkap, GAK DIULANG di
sini. `bill_id` sekarang `transaction_id`, `supplier_id` sekarang `counterparty_id`. RPC
`record_ap_payment` **DIDROP total**, gantinya `record_payment('OUTBOUND', ...)`.

Ringkasan histori yang masih relevan (detail lengkap: "AP Payment — Selaras AR (0011)" di
bawah): identik `ar_payments`, arah kebalik (Debit Utang Usaha, Kredit Kas/Bank). Tabel
jembatan `ap_payment_allocations` (many-to-many payment↔bill) sempat ada — **dicabut
total migration `0011_ap_payment_single_bill.sql`**.

### RPC (financial write — atomik, reuse `create_journal_entry`/`reverse_journal_entry`)

`create_ap_bill` (dulu ada di sini) UDAH DIDROP total migration `0065`, gantinya `create_transaction('OUTBOUND', ...)` — signature & body baru didokumentasikan di `transactions-schema.md`, gak diulang di sini. Rincian PPN/kategori tambahan yang dulu dijelasin di submodule "Compounding & PPN" bawah ini TETAP RELEVAN (`ap_bill_expense_categories` masih ada, cuma tabel `ap_bill_debit_lines` yang digantikan `transaction_lines` generic) — baca terus di bawah.

### Compounding & PPN — migration `0025_compound_transactional_entries_schema.sql` (histori), diserap `create_transaction` migration `0063`

Menutup `memory/scope-debt/compound-transactional-entries.md` (sudah dihapus). Sisi debit `create_ap_bill` (dulu) `p_debit_lines jsonb`, sekarang (`create_transaction`) `p_lines jsonb` (array `{account_id, amount}`), bisa dipecah kategori (mis. Rp750rb Persediaan + Rp50rb Beban Ongkir dalam 1 nota supplier). Sisi kredit (Utang Usaha, `p_control_account_id`) TETAP 1 baris.

- **`transaction_lines`** (dulu `ap_bill_debit_lines`, digabung sisi AR juga sejak `0064`) — 1 baris per elemen `p_lines` + 1 baris `is_tax=true` kalau `p_apply_tax`. Immutable, FK `transaction_id`. DDL lengkap: `transactions-schema.md`.
- **`ap_bill_expense_categories`** — katalog master data buat UI (dropdown kategori di form AP Bill), TETAP ADA gak kesentuh migrasi ini, struktur identik `ar_invoice_charge_types` (lihat `ar-schema.md` submodule "Compounding & PPN" buat detail penuh pola ini + `tax_settings`) — `account_id` di sini biasanya nunjuk akun kategori `expense` (bukan `revenue`).
- **PPN Masukan** — `p_apply_tax=true` baca `tax_settings.ppn_masukan_account_id`/`ppn_rate` (tabel singleton didefinisikan penuh di `ar-schema.md`, dipakai bareng `create_transaction` OUTBOUND dan `create_pos_sale`), dihitung server-side dari `v_subtotal`, **ditambahkan ke `p_control_account_id`** (utang ke supplier termasuk pajak yang bisa dikreditkan). Beda dari `p_lines` yang tetap dipercaya dari klien.
- **`create_goods_receipt`** (`memory/architecture/data/inventory-schema.md`) manggil `create_transaction('OUTBOUND', ...)` di dalamnya sejak `0064` (dulu `create_ap_bill`) — signature eksternal `create_goods_receipt` sendiri gak berubah. Riwayat `p_extra_debit_lines`/`p_apply_tax` (migration `0012_grn_compound_ppn.sql`) tetap berlaku apa adanya.

#### `record_ap_payment` DIGABUNG ke `record_payment('OUTBOUND', ...)`, migration `0069` (2026-09-05)

RPC lama **DIDROP total**, gantinya RPC generic `record_payment` — signature & body
lengkap: `memory/architecture/data/payments-schema.md`. Guard overpay gak berubah
perilakunya, cuma sekarang di 1 RPC yang nge-branch jurnal (Debit Utang Usaha/Kredit Kas)
berdasar `p_type`.

#### `cancel_ap_bill` — batalkan bill salah input (reversing entry, dengan guard) (terakhir didefinisi `0069`, target `payments`)

Identik `cancel_ar_invoice`. Diterapkan dari awal (bukan ditambah belakangan kayak AR), karena guard-nya udah kebukti perlu. Guard payment sekarang cek `payments` (filter `type='OUTBOUND'`). Diperluas lagi lewat migration `0035` (guard retur) dan `0013` (auto-unwind DP) — SQL final ada di submodule "Retur Barang ke Supplier" dan "Uang Muka / DP ke Supplier" di bawah.

```sql
create or replace function cancel_ap_bill(
  p_bill_id uuid,
  p_entry_date date,
  p_source_ref text
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_allocated_count int;
  v_credit_note_count int;
  v_original_entry_id uuid;
  v_new_entry_id uuid;
  v_bill_ref text;
begin
  select count(*) into v_allocated_count
  from payments where transaction_id = p_bill_id and type = 'OUTBOUND';

  if v_allocated_count > 0 then
    select source_ref into v_bill_ref from transactions where id = p_bill_id;
    raise exception 'Bill % udah punya % payment -- gak bisa dibatalkan lewat jalur ini', v_bill_ref, v_allocated_count;
  end if;

  select count(*) into v_credit_note_count
  from ap_credit_notes where bill_id = p_bill_id;

  if v_credit_note_count > 0 then
    select source_ref into v_bill_ref from transactions where id = p_bill_id;
    raise exception 'Bill % udah punya % retur (credit note) -- gak bisa dibatalkan lewat jalur ini', v_bill_ref, v_credit_note_count;
  end if;

  select journal_entry_id into v_original_entry_id from transactions where id = p_bill_id;

  v_new_entry_id := reverse_journal_entry(v_original_entry_id, p_entry_date, p_source_ref);

  return v_new_entry_id;
end;
$$;
```

### RLS Policy & Grant

RLS/Grant `payments` (dulu `ar_payments`/`ap_payments`) sekarang di `payments-schema.md` — gak diulang di sini. RLS `transactions` (dulu `ap_bills`) di `transactions-schema.md`, RLS `counterparties`/`counterparty_type_mapping` (dulu `suppliers`) di `counterparty-schema.md`.

### AP Payment — Selaras AR (0011) — migration `0011_ap_payment_single_bill.sql`

Menyusul migration `0010_ar_allow_partial_payment.sql` (AR boleh cicil tapi tetap gak boleh overpay/bayar gabungan), keputusan bisnis (2026-08-08) minta AP disamakan filosofinya: **payment boleh cicil, tapi wajib fokus nunjuk 1 bill tertentu** — gak boleh "bebas nyebar ke bill mana pun sesukanya" dalam 1 transaksi. Sebelum ini AP justru **lebih longgar** dari AR — tabel jembatan `ap_payment_allocations` (many-to-many, ada dari desain awal Fase 4) ngizinin 1 payment dipecah ke banyak bill sekaligus ("bayar gabungan"). Itu yang dicabut di sini, bukan cicilnya (cicil per 1 bill tetap boleh, gak berubah).

**Beda dari pencabutan `apply_ap_return_credit` (`0009`, lihat submodule "Retur Barang ke Supplier") yang murni soal kesederhanaan**: pencabutan `ap_payment_allocations` ini soal **konsistensi filosofi antar-modul** — AR dan AP sekarang sama-sama nganut "payment taat ke 1 obligasi spesifik, boleh kurang (cicil) gak boleh lebih (overpay), gak pernah disebar ke banyak obligasi dalam 1 transaksi".

**Verifikasi sebelum drop**: `ap_payments` dan `ap_payment_allocations` di database live sama-sama 0 baris (`supabase db query --linked`) — pencabutan bersih, gak ada data yang hilang.

Perubahan:
- `drop function if exists record_ap_payment(uuid, date, numeric, text, uuid, uuid, jsonb);` — signature lama (param terakhir `p_allocations jsonb`) di-drop duluan karena signature barunya beda tipe (`p_bill_id uuid`), kalau gak di-drop bakal jadi overload berbahaya (pelajaran dari bug `record_ar_payment` di `0027` pra-squash).
- `drop table if exists ap_payment_allocations;` — cascade trigger `ap_payment_allocations_no_over_allocation_trigger`, 2 index, trigger `block_edit_delete`, RLS policies, grant.
- `drop function if exists ap_payment_allocations_no_over_allocation();` — fungsi trigger yang jadi orphan setelah tabelnya hilang.
- `alter table ap_payments add column bill_id uuid not null references ap_bills(id);` + `create index ap_payments_bill_id_idx on ap_payments(bill_id);` — FK langsung, gak `unique` (1 bill boleh punya banyak baris payment buat cicil, mirror persis `ar_payments.invoice_id` pasca-`0010`). `not null` tanpa `default` aman langsung karena tabelnya 0 baris.
- `ap_bill_remaining()` reducer #1: `sum(amount) from ap_payment_allocations` jadi `sum(amount) from ap_payments` langsung.
- `record_ap_payment(...)` signature baru: `p_bill_id uuid` gantiin `p_allocations jsonb`. Guard sama persis pola `record_ar_payment` pasca-`0010` — `if p_amount > v_remaining then raise exception` (cuma tolak overpay).
- `cancel_ap_bill`: guard payment-count balik ke `ap_payments` langsung.

Direview `schema-reviewer` sebelum apply — gak ada blocker. UI (`/ap-payments` form + list + detail, `/ap-bills/[id]` tabel "Pembayaran", `/suppliers/[id]` tabel "AP Payments") disederhanakan bareng di sesi yang sama — pilih 1 bill langsung (bukan lagi form multi-baris alokasi), field `ApBill.ap_payment_allocations` di `src/lib/ap-bills/schema.ts` diganti `ap_payments`.

## Retur Barang ke Supplier

Ditutup 2026-08-13. `p_payable_account_id` terkunci ke `default_account_settings["ap.payable"]` lewat `LockedAccountField` (bukan dropdown bebas lagi — resolusi ini datang dari fitur Default Akun, `0017_default_account_settings_schema.sql`, sebelum sesi ini). `p_credit_account_id` jalur financial-only (`!goodsReceipt`) di UI difilter buang akun yang ada di `items.inventory_account_id` (`ap-bills/[id]/view.tsx`, fungsi `returCreditAccountOptions()`) — dan `create_ap_credit_note` sendiri sekarang menolak (`raise exception`) kalau jalur financial-only tetap mencoba pakai akun Persediaan, migration `0019_ap_credit_note_financial_only_inventory_guard.sql`. Retur akun Persediaan sekarang wajib lewat jalur fisik (`p_lines` terisi, bill wajib punya `goods_receipt_notes`).

Ref bisnis: `docs/domain/accounts-payable.md` bagian "Retur Barang ke Supplier". Ref DDL yang di-reuse: `journal-entry-schema.md` (`create_journal_entry`, `block_edit_delete`), `inventory-schema.md` (`consume_weighted_average`, `goods_receipt_notes`/`goods_receipt_lines`). 0 perubahan struktur ke `ap_bills`/`ap_payments`/`suppliers` (gak ada kolom baru) — tapi 2 fungsi existing dari `0010 pra-squash` diperluas (`create or replace`): `ap_payment_allocations_no_over_allocation` (fungsi ini sendiri sudah di-drop total migration `0011`, lihat submodule "Konsep Inti") dan `cancel_ap_bill`, lihat bagian `ap_bill_remaining` di bawah. Migration `0035_ap_credit_notes_schema.sql` (skema awal) + `0036_seed_demo_ap_credit_notes.sql` (seed) + `0009_ap_remove_return_credit_apply.sql` (pencabutan disposisi kedua, digabung ke submodule ini karena lahir langsung dari fitur retur).

**Beda mendasar dari AR Credit Note (`ar-schema.md`)**: 2 resolusi retur yang **saling eksklusif**, dipilih manual, bukan additive kayak AR. Ketauan lewat proses ngajarin fitur ini bahwa `warranty_replacement` di AR justru punya cacat desain (kompensasi ganda) — sudah diperbaiki lewat migration `0037_ar_warranty_replacement_discount_reversal.sql` (`warranty_replacement` sekarang wajib membalikkan diskon retur proporsional, bukan jadi saling eksklusif seperti AP), lihat `ar-schema.md`.

Akun baru: `1350` **Piutang Retur Supplier** (asset) — di-insert di migration **seed** (`0036_seed_demo_ap_credit_notes.sql`), bukan di migration schema, pola sama semua akun baru lain (`2400`/`2500` dst) — bukan bagian dari `0035_ap_credit_notes_schema.sql` itu sendiri. Sengaja terpisah dari akun `Uang Muka Pembelian` (`1360`, dibangun belakangan lewat migration `0013_ap_deposits_schema.sql` — lihat submodule "Uang Muka / DP ke Supplier" di bawah), beda asal jurnal (DP = bayar duluan sebelum barang datang; return credit = kelebihan setelah retur pada bill yang udah lunas).

**Ketahuan lewat `schema-reviewer` sebelum diapply** (2 blocker + 1 warning, sudah diperbaiki di file final): (1) `ap_bill_remaining()` awalnya cuma 2 reducer, kelewat `ap_return_credit_applications` — bisa bikin over-allocation nyata (bill yang udah "dibayar" pakai saldo kredit retur masih bisa dialokasikan payment lagi ngelebihin sisa riil); (2) `cancel_ap_bill` (0010) awalnya gak diperbarui sama sekali buat 2 reducer baru — sekarang diperluas; (3) `create_ap_credit_note` jalur full awalnya nerima `p_amount` independen dari cost fisik yang dihitung `consume_weighted_average` — bisa divergen tanpa ketauan. Detail perbaikan di masing-masing bagian di bawah.

Cuma nanganin item Weighted Average — bukan lagi "sementara": FIFO sudah dihapus total dari sistem (migration `0038_remove_fifo_costing.sql`), jadi Weighted Average sekarang satu-satunya jalur yang ada, 0 dampak balik ke fitur ini. **Batas waktu retur** sengaja gak termasuk dan gak akan digarap (bukan scope-debt, keputusan final) — AR sendiri sempat punya validasi serupa (`return_window_days`) tapi udah dicabut total (migration `0039`), jadi gak ada lagi padanan buat di-mirror.

**Opsi C (`purchase_writeoffs`/`create_purchase_writeoff`, "barang rusak yang pemasok tolak ganti sama sekali") DICABUT TOTAL migration `0068`** (2026-09-05, keputusan owner) — demi simetri AR/AP (AR cuma punya 2 jalur resolusi retur: kurangi piutang / ganti barang; Opsi C bikin AP punya 3). Barang rusak yang supplier tolak kompensasi sekarang dialihkan ke `stock_opname` generic (`record_stock_opname`, `inventory-schema.md`) — trade-off yang disadari: kehilangan traceability ke bill/GRN spesifik + guard qty gabungan lintas opsi, demi kesederhanaan struktur. Sisa fitur ini sekarang cuma **Opsi A + Opsi B** (2 jalur, persis simetris sama AR: kredit note / ganti barang).

### `ap_credit_notes` — Opsi A, selalu dibuat kalau resolusinya "kurangi utang"

Struktur identik `ar_credit_notes`, field `invoice_id` diganti `bill_id`.

```sql
create table ap_credit_notes (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references transactions(id), -- dulu references ap_bills(id), repoint migration 0064
  credit_note_date date not null,
  source_ref text not null,
  amount numeric(14,2) not null check (amount > 0),
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
```

Guard `ap_credit_notes_no_over_return` — cap ke `ap_bills.amount` (bukan sisa outstanding, karena retur independen dari status bayar), pola identik `ar_credit_notes_no_over_return`.

### `purchase_return_lines` — rincian item Opsi A (cuma jalur full, ada `goods_receipt_notes`)

Beda dari `inventory_returns`/`inventory_return_lines` di AR: **gak butuh tabel header terpisah** — `inventory_returns` di AR eksis karena `warranty_replacement` butuh nunjuk balik ke situ (bukti fisik). Opsi B di AP berdiri sendiri, gak pernah nunjuk ke sini, jadi `purchase_return_lines` cukup FK langsung ke `ap_credit_notes`.

```sql
create table purchase_return_lines (
  id uuid primary key default gen_random_uuid(),
  credit_note_id uuid not null references ap_credit_notes(id) on delete cascade,
  item_id uuid not null references items(id),
  qty_returned numeric(14,3) not null check (qty_returned > 0),
  total_cost numeric(14,2) not null check (total_cost > 0)
);
```

### `purchase_replacements` + `purchase_replacement_lines` — Opsi B, berdiri sendiri

**Gak pernah nunjuk ke `ap_credit_notes`** — berbeda dari `warranty_replacements` AR yang wajib punya `credit_note_id`. Jurnalnya Debit Persediaan (barang baru) / Kredit Persediaan (barang rusak) — **akun yang sama di 2 baris**, net nol, dokumentasi/audit trail doang.

```sql
create table purchase_replacements (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references transactions(id), -- dulu references ap_bills(id), repoint migration 0064
  replacement_date date not null,
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table purchase_replacement_lines (
  id uuid primary key default gen_random_uuid(),
  purchase_replacement_id uuid not null references purchase_replacements(id) on delete cascade,
  item_id uuid not null references items(id),
  qty_replaced numeric(14,3) not null check (qty_replaced > 0),
  total_cost numeric(14,2) not null check (total_cost > 0)
);
```

### `purchase_writeoffs` + `purchase_writeoff_lines` — Opsi C, DICABUT TOTAL migration `0068` (2026-09-05)

Dulu ada di sini: tabel berdiri sendiri (gak nunjuk `ap_credit_notes`, mirror struktur `purchase_replacements`), RPC `create_purchase_writeoff` (jurnal BUKAN net-nol, beda dari Opsi B). Dicabut demi simetri AR/AP — lihat "Keputusan" di submodule "Retur Barang ke Supplier" di atas. Barang rusak yang supplier tolak kompensasi sekarang lewat `stock_opname` generic (`record_stock_opname`, `inventory-schema.md`), bukan RPC khusus AP — kehilangan traceability ke bill/GRN spesifik + guard qty gabungan, trade-off yang disadari.

### `purchase_returned_qty(bill_id, item_id)` — guard qty gabungan Opsi A + B (disederhanakan `0068`, sebelumnya A+B+C)

Item Weighted Average gak punya proteksi otomatis per-lot (beda dari zaman FIFO masih ada — dulu ada `inventory_lot_consumptions_no_over_consumption`, sudah dihapus bareng FIFO di migration `0038`) — stoknya udah nyampur begitu diterima. Guard ini jumlahin klaim dari **2 tabel** (`purchase_return_lines` via `ap_credit_notes.bill_id`, `purchase_replacement_lines` via `purchase_replacements.bill_id` — reducer ke-3, `purchase_writeoff_lines`, dicabut `0068` bareng tabelnya) dan dibandingin ke `goods_receipt_lines.qty_received` — fisiknya cuma ada 1 pool qty yang bisa diklaim, mau lewat jalur mana pun. `create or replace` — signature gak berubah, jadi 2 trigger existing (`purchase_return_lines_no_over_return_trigger`, `purchase_replacement_lines_no_over_return_trigger`) otomatis kepake definisi baru tanpa perlu di-drop/recreate. Ini yang bikin Opsi A/B partial-capable "gratis" (batasnya di level fisik qty diterima, bukan per-mekanisme) — gak butuh fungsi `*_remaining()` terpisah kayak `ap_deposit_remaining()`.

```sql
create or replace function purchase_returned_qty(p_bill_id uuid, p_item_id uuid) returns numeric as $$
  select
    coalesce((
      select sum(prl.qty_returned) from purchase_return_lines prl
      join ap_credit_notes acn on acn.id = prl.credit_note_id
      where acn.bill_id = p_bill_id and prl.item_id = p_item_id
    ), 0)
    +
    coalesce((
      select sum(prpl.qty_replaced) from purchase_replacement_lines prpl
      join purchase_replacements prp on prp.id = prpl.purchase_replacement_id
      where prp.bill_id = p_bill_id and prpl.item_id = p_item_id
    ), 0);
$$ language sql stable;
```

Dipakai 2 trigger insert (`purchase_return_lines_no_over_return_trigger`, `purchase_replacement_lines_no_over_return_trigger`) yang semuanya juga nge-lookup `goods_receipt_lines.qty_received` lewat `goods_receipt_notes.bill_id`.

### `ap_return_credits` + `ap_return_credit_refunds`

Mirror `ar_return_credits` (0031) persis, arah asset kebalik (di AR liability kita ke customer, di sini asset kita ke supplier). Tabel jembatan ketiga (`ap_return_credit_applications`, disposisi "dipakai motong bill lain") sempat ada dari desain awal fitur ini, **dicabut total migration `0009_ap_remove_return_credit_apply.sql`** — lihat bagian "Pencabutan `apply_ap_return_credit`" di bawah.

```sql
create table ap_return_credits (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references counterparties(id), -- dulu references suppliers(id), repoint migration 0059
  credit_note_id uuid not null references ap_credit_notes(id),
  amount numeric(14,2) not null check (amount > 0),
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table ap_return_credit_refunds (
  id uuid primary key default gen_random_uuid(),
  credit_id uuid not null references ap_return_credits(id),
  amount numeric(14,2) not null check (amount > 0),
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
```

Guard `ap_return_credit_refunds_guard` cek amount ≤ `ap_return_credit_remaining(credit_id)`. Pola identik `ar_return_credit_refunds_guard`.

### `ap_bill_remaining(bill_id)` — disentralisasi dari AWAL, sekarang 2 reducer (terakhir didefinisi `0009`)

Beda dari AR yang baru disentralisasi belakangan (0031, setelah bug over-allocation berulang kebukti) — di AP langsung dibangun dari awal karena polanya udah kenal. **2 reducer**: `ap_payments` (langsung, bukan lewat tabel jembatan lagi sejak `0011`) + `ap_credit_notes`. Sempat ada reducer ke-3 (`ap_return_credit_applications` aktif) dari desain awal fitur retur (0035 pra-squash) — dicabut `0009` bareng tabelnya.

```sql
create function ap_bill_remaining(p_bill_id uuid) returns numeric as $$
  select ab.amount
    - coalesce((select sum(amount) from ap_payments where bill_id = p_bill_id), 0)
    - coalesce((select sum(amount) from ap_credit_notes where bill_id = p_bill_id), 0)
  from ap_bills ab
  where ab.id = p_bill_id;
$$ language sql stable;
```

**`record_ap_payment` (`0011`)** pakai fungsi ini alih-alih ngecek langsung ke `ap_bills.amount`, mirror `record_ar_payment` pasca-`0010`. **`cancel_ap_bill`** hard-block tambahan kalau bill udah punya `ap_credit_notes` (pola sama guard payment: bill udah "kesentuh" transaksi lain) — sempat juga punya auto-reverse loop buat `ap_return_credit_applications` aktif, dihapus `0009` bareng tabelnya (gak ada lagi apa pun buat di-unwind di sisi itu).

### `ap_bills_with_status` view — migration `0032_ap_bill_status_view.sql`

Nutup scope-debt filter status di list `/ap-bills`. Reuse `ap_bill_remaining()` di atas buat `outstanding` (via `cross join lateral`, sekali per baris), tapi status BUKAN cuma "outstanding vs amount" — `billStatus()` (`apps/erp/src/lib/ap-bills/schema.ts`) sengaja bedakan retur (`ap_credit_notes`, doang gak dianggap "sebagian") dari payment/DP aktif, jadi view punya lateral subquery kePisah buat `allocated` (SUM `ap_payments`) dan `deposit_applied` (SUM `ap_deposit_applications` exclude ter-reverse) dipakai threshold `sebagian`. `is_cancelled` cek `journal_entries.reverses_entry_id = journal_entry_id`. Pola sama persis `ap_deposits_with_status` (0031, pattern pertama).

**Kolom `origin` ditambah migration `0038_ap_bill_ar_invoice_origin_filter.sql`** (`CREATE OR REPLACE VIEW`, nambah 1 kolom di akhir tanpa drop view/grant) — nutup filter "Tipe" di list yang sama (`grn` kalau `exists` baris `goods_receipt_notes.bill_id = ab.id`, else `langsung`), gantiin fungsi client `billOrigin()` yang sebelumnya dihitung dari embed `goods_receipt_notes(id)` nested (sekarang dihapus dari select list, gak dipakai lagi).

**Denormalisasi ke kolom asli — migration `0053_denormalize_transactional_status.sql`** (2026-08-17, sudah di-push & diverifikasi user lewat testing UI; mekanisme lengkap & rationale ada di `ar-schema.md` submodule AR Invoice, ini mirror-nya): `outstanding`/`status`/`origin` sekarang KOLOM ASLI di `ap_bills`, dijaga `recompute_ap_bill_status()` (`security definer`, reuse `ap_bill_remaining()` apa adanya) lewat trigger `AFTER INSERT` di `ap_payments`/`ap_credit_notes`/`ap_deposit_applications`/`ap_return_credits`/`goods_receipt_notes` + trigger gabungan `journal_entries_sync_reversal_status`. View `ap_bills_with_status` MASIH ADA (nama & kolom sama) tapi sekarang cuma `select` polos. `ap_bills_block_edit_delete` (trigger immutability generik) diganti selective — kolom bisnis asli tetap immutable, `outstanding`/`status`/`origin` boleh diubah trigger.

### RPC `create_ap_credit_note` (Opsi A)

`p_lines` null/kosong → financial-only (1 jurnal, gak nyentuh inventory, `p_amount` dipakai apa adanya). `p_lines` terisi → full, bill wajib punya `goods_receipt_notes`, **`p_amount` DIABAIKAN dan DIGANTI** hasil penjumlahan cost fisik tiap baris (`consume_weighted_average`, dikumpulin ke `v_total_cost_returned` lewat loop yang jalan DULUAN sebelum jurnal dibikin). **Gak ada akun kontra** — beda dari `create_ar_credit_note`, karena Persediaan itu akun neraca.

Kenapa `p_amount` diabaikan di jalur full (beda dari desain awal yang nerima 2 angka independen, ketauan `schema-reviewer` sebagai warning): `create_ar_credit_note` sengaja punya 2 jurnal beda angka (kontra-revenue di harga jual, reversal HPP di cost) karena emang beda konsep. `create_ap_credit_note` cuma punya **1 jurnal** yang langsung ngeKredit Persediaan — nominalnya HARUS sama persis nilai barang yang beneran keluar dari stok, kalau dibiarkan independen Persediaan di GL bisa menyimpang dari `inventory_balances` tanpa ketauan trigger mana pun. Konsekuensi urutan kerja: konsumsi stok jalan duluan (buat tau total cost), baru jurnal + insert `ap_credit_notes` + insert `purchase_return_lines`, baru terakhir hitung excess.

Excess handling: `v_remaining_before` dihitung dari `ap_bill_remaining()` SEBELUM proses apa pun, `v_excess := greatest(0, v_effective_amount - greatest(0, v_remaining_before))`, kalau > 0 wajib isi `p_return_credit_asset_account_id` atau `raise exception`.

Full body: `supabase/migrations/0035_ap_credit_notes_schema.sql`.

### RPC `create_purchase_replacement` (Opsi B)

Konsumsi barang rusak pakai `consume_weighted_average` (fungsi yang sama dipakai jalur full Opsi A), lalu "terima" barang baru pakai `avg_cost` yang identik (`v_line_cost / v_qty`) — karena unit cost-nya sama persis, hitung ulang rata-rata otomatis balik ke `avg_cost` semula (murni aljabar: `((qty_before - qty)*avg + qty*avg) / qty_before = avg`), konsisten sama klaim "net nol" di dokumentasi bisnis.

Full body: `supabase/migrations/0035_ap_credit_notes_schema.sql`.

### RPC `refund_ap_return_credit`

Mirror `refund_ar_return_credit` (0031) persis, arah jurnal kebalik (Debit Kas/Bank / Kredit Piutang Retur Supplier). Sempat ada pasangan `apply_ap_return_credit` (Debit Utang Usaha / Kredit Piutang Retur Supplier, motong bill lain) — dicabut `0009`, lihat bagian "Pencabutan `apply_ap_return_credit`" di bawah.

Full body (definisi terkini): `supabase/migrations/0006_ap_schema.sql`.

### RLS Policy

Pola identik semua tabel transaksional AP/AR lain: `select` terbuka semua `authenticated`, `insert` cuma `admin`/`accountant`, gak ada `update`/`delete` di tabel baru (RLS default-deny + `block_edit_delete` jaring kedua).

### Seed demo

`supabase/migrations/0036_seed_demo_ap_credit_notes.sql` — seed skenario retur AP demo, lanjutan cross-modul dari seed inventory (bill Toko Gula Sejahtera Tahap 3 `GRN-GULA-001` & Tahap 5 `GRN-GULA-002`).

### Pencabutan `apply_ap_return_credit` (dipakai motong bill lain) — migration `0009_ap_remove_return_credit_apply.sql`

Sempat ada disposisi kedua buat `ap_return_credits`: **dipakai motong bill lain** ke supplier yang sama (`ap_return_credit_applications` + RPC `apply_ap_return_credit`, opsional & gak terikat urutan bill — bisa ke bill mana pun milik supplier yang sama, bukan cuma "bill berikutnya"). Dicabut total lewat keputusan bisnis (2026-08-08, dibahas interaktif — bukan diusulkan agent): mekanisme ini **bukan fondasi AP** — `ap_return_credits` tetap tertelusuri & terselesaikan penuh lewat 1 disposisi yang tersisa (refund tunai, `refund_ap_return_credit`, gak berubah).

**Beda dari alasan AR mencabut mekanisme setara** (`apply_ar_return_credit`, dicabut `0041` — lihat `ar-schema.md` bagian "AR Return Credit"): AR mencabutnya demi konsistensi kebijakan penagihan yang lebih ketat (`0040`, larangan overpay-jadi-saldo-ngambang — bukan larangan cicil, itu bagian yang belakangan dikoreksi lagi lewat `0010`). AP **gak** pernah ikut kebijakan overpay-jadi-saldo-ngambang itu ke `ap_return_credits` (mekanismenya beda: excess di AP otomatis jadi asset "Piutang Retur Supplier", bukan hasil overpay customer), jadi pencabutan `ap_return_credit_applications` di sini murni soal kesederhanaan/gak ada bukti kebutuhan — bukan konsistensi kebijakan. *(Catatan historis: pas paragraf ini ditulis, `ap_payment_allocations` many-to-many masih ada dari awal, jadi perbandingannya waktu itu valid — tabel itu sendiri belakangan ikut dicabut migration `0011`, lihat submodule "Konsep Inti" > "AP Payment — Selaras AR (0011)", tapi alasannya beda: bukan soal return-credit, melainkan soal payment "bayar gabungan".)*

**Verifikasi sebelum drop**: tabel `ap_return_credit_applications` di database live berisi 0 baris (`supabase db query --linked`), gak ada seed/demo data yang manggil `apply_ap_return_credit` — pencabutan bersih, gak ada data yang hilang.

Perubahan: drop RPC `apply_ap_return_credit`, drop tabel `ap_return_credit_applications` (cascade trigger/index/RLS/grant), drop fungsi guard `ap_return_credit_applications_guard`, `create or replace` 3 fungsi (`ap_bill_remaining`, `ap_return_credit_remaining`, `cancel_ap_bill`) buang reducer/loop yang nunjuk ke tabel itu — signature ketiganya gak berubah, jadi gak perlu `drop function` duluan. Direview `schema-reviewer` sebelum apply (blocker awal: UI/type di `src/` masih query tabel yang mau di-drop — diperbaiki bareng di PR yang sama sebelum migration di-push).

Full body: `supabase/migrations/0006_ap_schema.sql` (migration history 0001-0025 disquash jadi 9 file per modul 2026-08-10 — riwayat evolusi lengkap tetap ada di git log).

## Uang Muka / DP ke Supplier — migration `0013_ap_deposits_schema.sql` + `0014_seed_ap_deposit_accounts.sql`

Mirror `ar_deposits` (arah kebalik — asset `Uang Muka Pembelian`, bukan liability, karena supplier yang "berutang" balik ke kita). Beda dari AR: dibangun **partial-capable DAN dengan 2 disposisi (refund + hangus) dari AWAL** — bukan retrofit belakangan kayak AR (`0012`) — karena kebijakan refund-tidaknya DP ke supplier itu **supplier** yang nentuin (bukan kita), beda dari kebijakan DP ke customer yang kita sendiri tetapkan (default non-refundable). Rationale bisnis: `docs/domain/accounts-payable.md` bagian "Uang Muka / DP ke Supplier".

### `ap_deposits` — DP dibayar (selalu dibuat)

Satu baris = satu kejadian bayar uang muka ke supplier. `journal_entry_id` nunjuk jurnal Debit Uang Muka Pembelian / Kredit Kas/Bank (`create_journal_entry`, reuse). Immutable, pola sama `ap_bills`/`ap_payments`.

```sql
create table ap_deposits (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references counterparties(id), -- dulu references suppliers(id), repoint migration 0059
  deposit_date date not null,
  source_ref text not null,
  amount numeric(14,2) not null check (amount > 0),
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
```

### `ap_deposit_applications` — DP diterapkan ke bill

Jurnal: Debit Utang Usaha / Kredit Uang Muka Pembelian (reklasifikasi). Struktur identik `ar_deposit_applications`, field `invoice_id` diganti `bill_id`.

```sql
create table ap_deposit_applications (
  id uuid primary key default gen_random_uuid(),
  deposit_id uuid not null references ap_deposits(id),
  bill_id uuid not null references transactions(id), -- dulu references ap_bills(id), repoint migration 0064
  amount numeric(14,2) not null check (amount > 0),
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
```

### `ap_deposit_refunds` + `ap_deposit_forfeitures` — 2 disposisi lain, keduanya partial-capable dari awal

`ap_deposit_refunds`: Debit Kas/Bank / Kredit Uang Muka Pembelian — supplier balikin uangnya, **gak ada dampak Laba Rugi**. `ap_deposit_forfeitures`: Debit **Beban Kerugian Uang Muka** (akun baru `5800`, expense) / Kredit Uang Muka Pembelian — supplier gak mau/gak bisa balikin, **ada dampak Laba Rugi**. Struktur identik `ar_deposit_refunds`/`ar_deposit_forfeitures` pasca-`0012` (keduanya udah punya kolom `amount` dari awal, gak perlu `alter table` belakangan kayak AR).

```sql
create table ap_deposit_refunds (
  id uuid primary key default gen_random_uuid(),
  deposit_id uuid not null references ap_deposits(id),
  amount numeric(14,2) not null check (amount > 0),
  refund_date date not null,
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table ap_deposit_forfeitures (
  id uuid primary key default gen_random_uuid(),
  deposit_id uuid not null references ap_deposits(id),
  amount numeric(14,2) not null check (amount > 0),
  forfeiture_date date not null,
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
```

### `ap_deposit_remaining(deposit_id)` — sumber kebenaran tunggal, mirror `ar_deposit_remaining()` (`0012`)

Gak ada aturan "1 disposisi aktif" sama sekali — beda dari AR yang punya riwayat itu sebelum `0012`. Dari awal, ketiga jalur (applications/refunds/forfeitures) boleh dicampur bebas:

```sql
create function ap_deposit_remaining(p_deposit_id uuid) returns numeric as $$
  select ad.amount
    - coalesce((
        select sum(ada.amount) from ap_deposit_applications ada
        where ada.deposit_id = p_deposit_id
          and not exists (
            select 1 from journal_entries je where je.reverses_entry_id = ada.journal_entry_id
          )
      ), 0)
    - coalesce((select sum(amount) from ap_deposit_refunds where deposit_id = p_deposit_id), 0)
    - coalesce((select sum(amount) from ap_deposit_forfeitures where deposit_id = p_deposit_id), 0)
  from ap_deposits ad
  where ad.id = p_deposit_id;
$$ language sql stable;
```

Guard tiap tabel transaksional (`ap_deposit_applications_guard`, `ap_deposit_refunds_guard`, `ap_deposit_forfeitures_guard`) semuanya cek `new.amount > ap_deposit_remaining(new.deposit_id)`. `ap_deposit_applications_guard` juga cek supplier match (deposit vs bill), bill belum dibatalkan, dan `ap_bill_remaining(new.bill_id)` — pola identik `ar_deposit_applications_guard`.

### `ap_deposits_with_status` view — migration `0031_ap_deposit_status_view.sql`

View pertama di project ini. Nutup scope-debt filter status di list `/ap-deposits` (sebelumnya status cuma dihitung client-side lewat `depositStatus()` dari data nested, gak bisa di-`WHERE`-kan). Reuse `ap_deposit_remaining()` di atas lewat `cross join lateral` (biar dievaluasi sekali per baris, bukan 3x), lalu derive `status` (`belum_dipakai | sebagian | selesai`) dengan threshold yang identik dengan `depositStatus()` di `apps/erp/src/lib/ap-deposits/schema.ts`. `security_invoker = true` wajib supaya RLS `ap_deposits_select` (`auth.role() = 'authenticated'`) tetap ke-enforce lewat view, bukan lari ke privilege pemilik view. `grant select ... to authenticated` eksplisit, pola sama semua relasi baru lain di project ini.

List page (`apps/erp/src/lib/ap-deposits/queries.ts`) query langsung ke view ini, bukan tabel `ap_deposits` — jadi gak perlu lagi fetch nested `ap_deposit_applications`/`refunds`/`forfeitures` cuma buat dihitung ulang di client. Halaman detail (`[id]/view.tsx`) tetap pakai tabel dasar + `depositStatus()` client-side (butuh breakdown applied/refunded/forfeited per baris, bukan cuma status ringkasan).

**Denormalisasi ke kolom asli — migration `0053_denormalize_transactional_status.sql`** (mekanisme lengkap di `ar-schema.md` submodule AR Invoice, ini mirror-nya): `remaining`/`status` sekarang kolom asli di `ap_deposits`, dijaga `recompute_ap_deposit_status()` (`security definer`) lewat trigger `AFTER INSERT` di `ap_deposit_applications`/`ap_deposit_refunds`/`ap_deposit_forfeitures` + trigger gabungan `journal_entries_sync_reversal_status`. `ap_deposit_applications` insert juga mancing recompute `ap_bills` (reducer `deposit_applied`) — 1 trigger gabungan, gak dobel-hitung. View sekarang `select` polos, `ap_deposits_block_edit_delete` diganti selective.

### 2 fungsi existing yang diperluas (`create or replace` di `0013`, bukan tabel baru)

- **`ap_bill_remaining()`** — reducer ke-3 (`ap_deposit_applications` aktif), mirror `ar_invoice_remaining()` yang udah punya reducer ini dari awal. Guard soundness: dipanggil dari `ap_deposit_applications_guard()` di dalam trigger `BEFORE INSERT` — baris baru belum ke-commit pas fungsi ini jalan, jadi gak ada double-count, pola yang sama persis kayak `ar_deposit_applications_guard()` → `ar_invoice_remaining()` yang udah lama jalan di AR.
- **`cancel_ap_bill()`** — auto-unwind loop `ap_deposit_applications` aktif, mirror `cancel_ar_invoice`. **Bukan regresi** dari sisa loop lama (`0006` versi awal sempat punya loop unwind buat `ap_return_credit_applications`, tapi itu udah dihapus total di `0009` bareng tabelnya, dan `0011` juga udah nyederhanain `cancel_ap_bill` jadi cuma 2 guard tanpa loop apa pun) — jadi loop `ap_deposit_applications` di `0013` murni tambahan baru.

### RPC: `create_ap_deposit`, `apply_ap_deposit`, `refund_ap_deposit`, `forfeit_ap_deposit`

`security invoker`, pola sama RPC AP lain — semua reuse `create_journal_entry`. Ke-4 RPC dibangun bareng dari awal (beda dari AR yang `refund_ar_deposit` nyusul belakangan lewat `0012`). Nominal selalu diinput eksplisit dari caller.

Full body: `supabase/migrations/0006_ap_schema.sql`.

### Akun baru — migration seed `0014_seed_ap_deposit_accounts.sql`

`1360` **Uang Muka Pembelian** (asset) dan `5800` **Beban Kerugian Uang Muka** (expense) — pola sama semua akun baru lain (di migration seed terpisah, bukan migration schema).

### RLS & Grant

Pola identik AP/AR lain — `select` semua `authenticated`, `insert` cuma `admin`/`accountant`, **gak ada** policy `update`/`delete` (default deny + `block_edit_delete`) di keempat tabel baru.

**Catatan non-blocker dari `schema-reviewer`** (pre-existing, bukan diperkenalkan `0013`): `cancel_ap_bill` (dan `cancel_ar_invoice`) gak ngecek apakah `journal_entry_id` bill/invoice-nya udah pernah di-reverse sebelumnya — kalau RPC ini dipanggil 2x buat bill/invoice yang sama, bisa double-reversal. Gap lama sejak `0006`/`0005`, ikut kewarisin ke loop unwind deposit juga — di luar scope migration ini, dicatat sebagai potensi scope-debt kalau belum ada.
