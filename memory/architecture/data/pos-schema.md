# POS / Jualan Eceran — Struktur Data & Teknis (AI Context)

Konsep: `memory/domain/pos.md`. Naratif: `docs/architecture/pos-schema.md`. Migration: `supabase/migrations/0009_pos_schema.sql` (bentuk asal, sekarang historis), `0076_pos_unify_transactions.sql` + `0077_pos_permanently_delete_legacy_data.sql` (unifikasi ke `transactions`, bentuk final — `0076` sempat ter-apply versi draft "rename+bekukan" sebelum keputusan final "hapus permanen", `0077` yang menyelesaikan transisi; baca komentar migration itu buat kronologi lengkap kalau butuh histori).

Histori keputusan unifikasi lengkap ada di git log commit migration `0076`/`0077`. Rencana simplifikasi lanjutan yang ditunda (drop `pos_sales`/`pos_sale_lines`/`pos_sale_extra_credit_lines`, rely penuh ke `goods_issue_lines`+`transaction_lines`): `memory/scope-debt/pos-sales-simplify-rely-on-goods-issue.md`.

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `pos_sales` | **Bukan header transaksi** — cuma penanda tipis "transaksi ini lahir dari kasir POS" + pointer ke 3 baris yang harus di-reverse bareng kalau dibatalkan | `transactions` (PK = `transaction_id`), `goods_issues`, `payments`, `accounts` (`cash_account_id`, disalin buat display) |
| `pos_sale_lines` | Salinan item buat tampilan struk (unit_price/line_amount, BUKAN sumber kebenaran akuntansi) | `pos_sales` (via `transaction_id`), `items` |
| `pos_sale_extra_credit_lines` | Salinan baris kategori tambahan+PPN buat tampilan struk (BUKAN sumber kebenaran) | `pos_sales` (via `transaction_id`), `accounts` |
| `pos_settings` | Singleton (pola `tax_settings`) — nyimpen ID counterparty "Pelanggan Umum" (walk-in fallback) | `counterparties` |
| `transactions`/`transaction_lines` | **Sumber kebenaran finansial** — jurnal Piutang↔Pendapatan (+kategori tambahan+PPN) | lihat `transactions-schema.md` |
| `goods_issues`/`goods_issue_lines` | **Sumber kebenaran fisik** — konsumsi stok + jurnal HPP↔Persediaan | lihat `goods-issue-schema.md` |
| `payments` | **Sumber kebenaran pelunasan** — jurnal Kas↔Piutang, selalu lunas penuh seketika | lihat `payments-schema.md` |

## Konsep Inti — Unifikasi ke `transactions` (migration `0076`/`0077`)

**Kenapa diunifikasi**: struktur jurnal POS ("debit 1 akun kontrol, kredit N baris variabel + PPN opsional") identik `create_transaction`. Bedanya cuma POS *immediately-settled* (gak pernah nyisa outstanding), sedangkan `create_transaction` didesain buat piutang yang MEMANG bisa nyisa outstanding. `create_pos_sale` tetap 1 RPC dipanggil kasir (signature eksternal byte-identik, `apps/pos` nol perubahan alur create), tapi isinya sekarang ORKESTRASI 2 RPC yang udah ada, bukan insert langsung:

```
create_pos_sale(...)
  -> create_goods_issue(...)  -- transactions(OUTBOUND)+transaction_lines+goods_issues+
                                 goods_issue_lines, jurnal Piutang<->Pendapatan + jurnal HPP
  -> record_payment('OUTBOUND', p_transaction_id=<hasil di atas>, ...) -- lunasi PENUH seketika,
                                 jurnal Kas<->Piutang
```

**Konsekuensi konseptual**: POS sekarang SECARA TEKNIS lewat Piutang Usaha (akun `ar.receivable` dari `default_account_settings`) sesaat, langsung dilunasi RPC yang sama — beda dari desain lama (`0009`) yang debit langsung ke Kas tanpa numpang Piutang sama sekali. Efek akhir di neraca tetap sama (Piutang gak pernah kelihatan outstanding), tapi ini WAJIB diketahui kalau ada yang query `transactions` filter by akun/jurnal secara langsung.

**Keputusan desain kunci**:

- **`counterparty_id` tetap NOT NULL** (constraint `transactions.counterparty_id` gak dilonggarkan buat POS). **Fallback**: 1 baris `counterparties` sintetis **"Pelanggan Umum"** (role `customer`, diseed migration `0076` langsung lewat SQL, bukan `create_counterparty`, karena migration jalan di luar konteks `auth.uid()`), ID-nya disimpan `pos_settings.walk_in_customer_id`. Row ini **gak ada penanda spesial** (gak ada kolom `is_walk_in` — user eksplisit menolak nambah kolom flag) — murni row customer biasa. **Konsekuensi wajib disapu**: harus di-`.neq("id", walkInCustomerId)` di SEMUA dropdown "pilih customer" transaksi kredit sungguhan (`ar-invoices`, `ar-deposits`, `goods-issues`, `sales-orders`) — helper `apps/erp/src/lib/pos-settings/schema.ts` (`fetchWalkInCustomerId`). SENGAJA TIDAK di-exclude dari filter list `/pos-sales` (walk-in emang penjualan POS asli) atau `/customers` master list (tetap auditable). **Belum diimplementasi**: guard cegah row ini ke-arsip gak sengaja lewat `delete_counterparty` — worst-case sekarang tombol arsip gagal dengan error (FK banyak), bukan sukses, jadi non-fatal.
- **`origin` transaksi POS SELALU `'goods_movement'`** — `create_pos_sale` WAJIB pakai `create_goods_issue` (bukan konsumsi stok inline lagi), supaya baris `goods_issues`/`goods_issue_lines` beneran ada sebagai bukti fisik yang dibaca `recompute_transaction_status()`.
- **`cancel_ar_invoice` TIDAK BISA dipakai buat batalkan POS** (RPC itu `raise exception` kalau transaksi udah punya `payments` — POS SELALU punya). RPC baru: `void_pos_transaction`.
- **Gak ada kolom baru di `transactions` buat nandain asal POS** — `pos_sales` (bentuk baru) jadi tabel PENANDA tipis, bukan nambah kolom di `transactions`.

### `pos_settings` — singleton walk-in customer

```sql
create table pos_settings (
  id boolean primary key default true,
  walk_in_customer_id uuid not null references counterparties(id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  constraint pos_settings_singleton check (id)
);
```

RLS: `select` semua `authenticated`, `update` admin-only, **gak ada policy insert** (baris singleton diisi migration). Seed: 1 baris `counterparties` "Pelanggan Umum" (`counterparty_type_mapping.role='customer'`) + 1 baris `pos_settings` nunjuk ke situ, di-insert langsung di migration `0076`.

### `pos_sales`/`pos_sale_lines`/`pos_sale_extra_credit_lines` — penanda tipis, BUKAN sumber kebenaran

```sql
create table pos_sales (
  transaction_id uuid primary key references transactions(id),
  goods_issue_id uuid not null references goods_issues(id),
  payment_id uuid not null references payments(id),
  cash_account_id uuid not null references accounts(id), -- disalin buat display list, payments gak nyimpen ini sendiri
  created_at timestamptz not null default now()
);

create table pos_sale_lines ( -- salinan buat cetak struk, BUKAN dibaca RPC finansial manapun
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references pos_sales(transaction_id) on delete cascade,
  item_id uuid not null references items(id),
  qty_sold numeric(14,3) not null check (qty_sold > 0),
  unit_price numeric(14,2) not null check (unit_price >= 0),
  line_amount numeric(14,2) not null check (line_amount >= 0)
);

create table pos_sale_extra_credit_lines ( -- salinan kategori tambahan+PPN, buat struk juga
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references pos_sales(transaction_id) on delete cascade,
  account_id uuid not null references accounts(id),
  amount numeric(14,2) not null check (amount > 0),
  is_tax boolean not null default false
);
```

**Kenapa ada, kalau isinya duplikasi**: `goods_issue_lines` cuma nyimpen `qty_issued`+`total_cost` (HPP), gak pernah nyimpen harga jual per baris (`unit_price`/`line_amount`) — data itu dibutuhkan `apps/pos` buat cetak struk/kirim WA, dan gak ada tempat lain nyimpennya (beda dari AR Invoice fulfillment SO yang punya `order_lines.unit_price`). Sama buat kategori tambahan+PPN — 100% duplikat `transaction_lines`, cuma biar gampang di-query dari `apps/pos` tanpa join balik ke `transaction_lines`. **Ini persis alasan `pos-sales-simplify-rely-on-goods-issue.md` (ditunda) ngusulin drop ketiganya + tambah `goods_issue_lines.unit_price` nullable** — kalau itu dieksekusi, 3 tabel ini hilang total.

Ketiganya: RLS `select`-only buat `authenticated`, **gak ada policy/grant insert** (satu-satunya jalur nulis = `create_pos_sale`, `security definer`), trigger `block_edit_delete` (immutable).

### RPC `create_pos_sale` — sekarang orkestrator, bukan insert langsung

```sql
create function create_pos_sale(
  p_sale_date date, p_source_ref text, p_customer_id uuid,
  p_cash_account_id uuid, p_revenue_account_id uuid,
  p_hpp_account_id uuid, p_finished_good_account_id uuid,
  p_lines jsonb, -- array of {"item_id":uuid,"qty_sold":numeric,"unit_price":numeric}
  p_extra_credit_lines jsonb default '[]'::jsonb, -- array of {"account_id":uuid,"amount":numeric}
  p_apply_tax boolean default false
) returns uuid language plpgsql security definer set search_path = public, pg_temp as $$ ... $$;
```

**Signature EKSTERNAL byte-identik** ke versi lama (`apps/pos/src/app/page.tsx` nol perubahan buat alur checkout). Body sekarang:

1. Guard role manual (`admin`/`accountant`/`cashier`) — `security definer` PERTAMA di project ini, alasan sama versi lama (`cashier` gak dikasih akses RLS insert `journal_entries`).
2. `p_customer_id` null -> fallback `pos_settings.walk_in_customer_id`.
3. Akun Piutang diambil dari `default_account_settings` (`role_key='ar.receivable'`, SAMA persis dipakai AR Invoice) — bukan parameter baru, signature gak berubah.
4. Hitung `v_total_amount` server-side dari `p_lines` (anti-tamper, sama pola lama), susun `v_issue_lines` (format `goods_issue_lines`) + `v_credit_lines` (basket item + kategori tambahan mentah, PPN belum dihitung di sini).
5. `create_goods_issue(...)` -> hasilnya `v_transaction_id` (row `transactions` OUTBOUND + `transaction_lines` + `goods_issues`/`goods_issue_lines`, jurnal Piutang↔Pendapatan + HPP↔Persediaan, PPN dihitung SEKALI di dalam `create_transaction` dari `tax_settings` kalau `p_apply_tax`).
6. Baca `v_goods_issue_id` (`goods_issues.invoice_id = v_transaction_id`) dan `transactions.amount` (angka FINAL termasuk PPN, bukan `v_total_amount` mentah — 1 sumber kebenaran buat angka pajak).
7. `record_payment('OUTBOUND', ..., p_transaction_id=v_transaction_id)` -> lunasi PENUH seketika, jurnal Kas↔Piutang.
8. Insert `pos_sales` (penanda) + loop insert `pos_sale_lines` (dari `p_lines` asli, bukan `v_issue_lines`, karena butuh `unit_price`) + `pos_sale_extra_credit_lines` (baris manual dari `p_extra_credit_lines`, lalu baris PPN dibaca BALIK dari `transaction_lines where is_tax=true` — gak dihitung ulang, hindari 2 sumber kebenaran angka pajak).

### RPC `void_pos_transaction` — RPC BARU, bukan reuse `cancel_ar_invoice`

```sql
create function void_pos_transaction(
  p_transaction_id uuid, p_entry_date date, p_source_ref text
) returns uuid language plpgsql security invoker as $$ ... $$;
```

Cari 3 jurnal lewat `pos_sales` sebagai peta pointer (`transactions.journal_entry_id`, `goods_issues.journal_entry_id`, `payments.journal_entry_id`) — kalau `p_transaction_id` bukan POS sale (gak ada row `pos_sales`), `raise exception` suruh pakai `cancel_ar_invoice`. Guard "udah pernah dibatalkan" sama pola lain (`exists ... reverses_entry_id`, **TOCTOU race tanpa row lock, inherited risk sama kelasnya `cancel_ar_invoice`/`cancel_ap_bill`, sengaja gak diperbaiki di sini**). Reverse urutan: payment -> goods_issue -> transaction (independen, urutan ini paling gampang dibaca riwayat jurnal). Restore stok manual (`inventory_balances` agregat per `item_id` dulu, bukan `UPDATE...FROM` langsung ke banyak baris) **+ insert baris kompensasi ke `inventory_movements`** (per `goods_issue_lines`, kelas bug sama `0056` — tanpa ini Kartu Stok drift meski `inventory_balances` benar).

### RLS & Grant

Sama filosofi versi lama — **gak ada policy/grant insert** ke `authenticated` di `pos_sales`/`pos_sale_lines`/`pos_sale_extra_credit_lines`/`pos_settings`. Satu-satunya jalur nulis: `create_pos_sale` (`security definer`) buat 3 tabel pertama, migration langsung buat `pos_settings`. `select` terbuka semua `authenticated`.

### Fix silang yang ikut dibawa migration ini (bukan cuma POS)

- **`ar_invoice_remaining`/`ap_bill_remaining`** ditambah exists-check exclude `payments` yang jurnalnya udah di-reverse (pola sama `deposit_applications` di fungsi yang sama) — gap laten yang baru KENA gara-gara `void_pos_transaction` (RPC pertama yang reverse jurnal 1 `payments` doang tanpa hapus barisnya; `cancel_ar_invoice`/`cancel_ap_bill` gak pernah kena karena nolak jalan kalau transaksi udah punya `payments` sama sekali). Tanpa fix, `outstanding` abis void balik ke 0 (keliatan "lunas") padahal harusnya balik ke amount penuh.
- **`inventory_movements_with_source`** (dipakai laporan Kartu Stok SEMUA jenis mutasi, bukan cuma POS) dibikin ulang di `0077` — cabang `pos_sale_line_id` gak lagi JOIN ke `pos_sale_lines`/`pos_sales` lama (data pra-cutover udah dihapus permanen). Baris historis pra-cutover tetap dapet label "Penjualan (Kios/POS)" tapi `source_ref`-nya sekarang NULL. Penjualan POS BARU otomatis kebaca label generic "Penjualan (Kirim Barang)" (lewat `goods_issue_line_id`, bukan `pos_sale_line_id` lagi) — konsekuensi wajar unifikasi.

## Data Historis Pra-Cutover — DIHAPUS PERMANEN (bukan dibekukan)

Struktur jurnal POS lama (1 jurnal `Debit Kas / Kredit Pendapatan` + HPP terpisah) **berubah bentuk** di desain baru (2 jurnal: Piutang↔Pendapatan lewat `create_transaction`, lalu Kas↔Piutang lewat `record_payment`) — beda dari preseden `ar_invoices`/`ap_bills` (`0064`) yang backfill-nya aman karena struktur jurnal identik, cuma pindah tabel. `journal_entries`/`journal_lines` immutable — gak ada cara "mecah" 1 baris jurnal lama jadi pola 2-jurnal baru tanpa memalsukan riwayat. **Backfill gak mungkin, keputusan final user (2026-09-06): `pos_sales`/`pos_sale_lines`/`pos_sale_extra_credit_lines` lama di-`drop table cascade` permanen** (bukan rename ke `*_legacy` seperti draf awal `0076` yang sempat ter-apply lebih dulu — lihat komentar migration `0076`/`0077` buat kronologi lengkapnya).

Konsekuensi: `journal_entries`/`journal_lines` historis TIDAK kesentuh (GL/laporan keuangan aman) — yang HILANG selamanya cuma rincian per-item + nama customer penjualan kios lama, dan kemampuan "Batalkan" lewat UI buat transaksi lama (`void_pos_sale` di-drop total, koreksi harus manual lewat Journal Entry, gak otomatis balikin stok). `/pos-sales` di ERP sekarang single-source (cuma nampilin penjualan setelah migration ini, gak ada `UNION` legacy).

### `pos_sales_with_status` — view, single-source

```sql
create view pos_sales_with_status with (security_invoker = true) as
select
  t.id, t.date as sale_date, t.source_ref, t.journal_entry_id as revenue_journal_entry_id,
  t.amount as total,
  case when t.status = 'lunas' then 'normal' else t.status end as status,
  t.counterparty_id as customer_id, c.name as customer_name,
  ps.cash_account_id, ca.code as cash_account_code, ca.name as cash_account_name
from pos_sales ps
  join transactions t on t.id = ps.transaction_id
  left join counterparties c on c.id = t.counterparty_id
  left join accounts ca on ca.id = ps.cash_account_id;
```

Kolom FLAT (bukan PostgREST nested embed `counterparties(...)`/`cash_account:accounts(...)`) — `apps/erp/src/lib/pos-sales/{schema,queries}.ts` baca kolom ini langsung. **Catatan non-blocking** (`schema-reviewer`): asumsi "status POS cuma `normal`/`dibatalkan`" valid SEKARANG (bukan constraint) — `record_payment` selalu lunasin penuh di RPC yang sama dan formula "excess" di RPC retur otomatis reclassify ke `return_credits`, tapi kalau RPC retur/deposit berubah, status lain (`sebagian`/`belum`) bisa lolos diam-diam ke sini (frontend `PosSaleStatus` hardcode cuma 2 nilai).

## Glossary

- **`pos_sales`**: sejak `0076`/`0077`, penanda tipis (`transaction_id`+`goods_issue_id`+`payment_id`), BUKAN header transaksi lagi.
- **`create_pos_sale`**: orkestrator `create_goods_issue`+`record_payment`, signature eksternal gak berubah. `security definer` PERTAMA di project — guard role manual, bukan RLS.
- **`void_pos_transaction`**: RPC pembatalan POS pasca-unifikasi, reverse 3 jurnal (payment, goods_issue, transaction) + restore stok + kompensasi `inventory_movements`.
- **`void_pos_sale`**: LAMA, sudah di-`drop function` total di `0077` (data yang jadi targetnya udah gak ada).
- **Role `cashier`**: gak berubah — cuma bisa lewat `create_pos_sale`, gak punya akses insert `journal_entries` langsung.
- **"Pelanggan Umum"**: row `counterparties` sintetis, fallback wajib karena `transactions.counterparty_id not null` gak dilonggarkan buat POS. ID-nya di `pos_settings.walk_in_customer_id`.
