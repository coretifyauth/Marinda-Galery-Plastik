# POS / Jualan Eceran — Struktur Data & Teknis (AI Context)

Konsep: `memory/domain/pos.md`. Naratif: `docs/architecture/pos-schema.md`. Migration:
`0009_pos_schema.sql` (bentuk asal, historis) -> `0076`/`0077` (unifikasi ke `transactions`,
tabel penanda `pos_sales` tipis) -> `0078`/`0079` (**bentuk final**: tabel penanda dihapus
total, identitas POS jadi pure struktural, bug pelunasan dari `0076` diperbaiki).

Histori unifikasi lengkap ada di git log commit migration `0076`/`0077`. Histori simplifikasi
lanjutan (drop tabel penanda) ada di git log commit migration `0078`/`0079` + di file ini.

## Peta Data (ERD) — Ringkasan Semua Tabel

Gak ada tabel POS-khusus lagi sama sekali. Penjualan kios sekarang murni komposisi tabel
generic yang udah ada:

| Tabel | Fungsi buat POS | Terhubung ke |
|---|---|---|
| `transactions`/`transaction_lines` | Sumber kebenaran finansial — jurnal Piutang↔Pendapatan (+kategori tambahan+PPN) | lihat `transactions-schema.md` |
| `goods_issues`/`goods_issue_lines` | Sumber kebenaran fisik — konsumsi stok + jurnal HPP↔Persediaan. `goods_issue_lines.unit_price` (migration `0078`) nyimpen harga jual per baris | lihat `goods-issue-schema.md` |
| `payments` | Sumber kebenaran pelunasan — jurnal Kas↔Piutang, selalu lunas penuh seketika | lihat `payments-schema.md` |
| `pos_settings` | Singleton — ID counterparty "Pelanggan Umum" (walk-in fallback) | `counterparties` |

## Konsep Inti — Identitas POS Sekarang Pure Struktural (migration `0078`)

**Kenapa disederhanakan lebih lanjut dari `0076`/`0077`**: tabel penanda `pos_sales`/
`pos_sale_lines`/`pos_sale_extra_credit_lines` (bentuk pasca-`0076`) ternyata sebagian besar
isinya DUPLIKASI data yang udah ada di `goods_issue_lines`/`transaction_lines` — cuma dibikin
buat kebutuhan tampilan struk (`apps/pos`). Satu-satunya data GENUINELY baru (gak ada tempat
lain nyimpennya) adalah `unit_price` per baris item — itu dipindah ke `goods_issue_lines`
langsung, sisanya (item_id/qty, kategori tambahan, PPN) dibaca dari `goods_issue_lines`/
`transaction_lines` yang udah ada.

**Konsekuensi desain terpenting**: **gak ada lagi cara bedain "transaksi dari kasir POS" vs
"AR Invoice manual yang kebetulan bentuknya identik"** (walk-in counter sale tanpa Sales
Order, lunas seketika, gak pernah nyisa outstanding). User eksplisit memutuskan ini gak
masalah — sempat dipertimbangkan tabel generik `sales` + kolom `channel` buat nandain asal,
tapi dibatalkan, gak dianggap perlu. Identitas "ini penjualan kios" sekarang murni STRUKTURAL:
transaksi `OUTBOUND` + persis 1 `goods_issues` + persis 1 `payments` yang melunasi PENUH +
gak ada retur/DP nempel. Halaman `/pos-sales` (ERP) dan panel "Transaksi Terakhir" (`apps/pos`)
sama-sama query dengan kriteria ini — transaksi manual yang kebetulan match kriteria ini juga
ikut muncul, itu DISENGAJA (bukan bug).

### `pos_settings` — TIDAK BERUBAH dari `0076`

Tetap singleton nyimpen ID counterparty "Pelanggan Umum" (`walk_in_customer_id`), orthogonal
dari simplifikasi ini. Lihat detail constraint/RLS di git log migration `0076`.

### RPC `create_pos_sale` — signature eksternal byte-identik, body cuma orkestrasi

```sql
create function create_pos_sale(
  p_sale_date date, p_source_ref text, p_customer_id uuid,
  p_cash_account_id uuid, p_revenue_account_id uuid,
  p_hpp_account_id uuid, p_finished_good_account_id uuid,
  p_lines jsonb, -- array of {"item_id":uuid,"qty_sold":numeric,"unit_price":numeric}
  p_extra_credit_lines jsonb default '[]'::jsonb,
  p_apply_tax boolean default false
) returns uuid language plpgsql security definer set search_path = public, pg_temp as $$ ... $$;
```

Body (migration `0078`, dibetulkan `0079` — lihat submodule bug di bawah):

1. Guard role manual (`admin`/`accountant`/`cashier`) — `security definer` PERTAMA di project.
2. `p_customer_id` null -> fallback `pos_settings.walk_in_customer_id`.
3. Akun Piutang dari `default_account_settings` (`role_key='ar.receivable'`).
4. Hitung `v_total_amount` server-side dari `p_lines`, susun `v_issue_lines` (format
   `goods_issue_lines`, TERMASUK `unit_price` per baris — key baru yang diteruskan ke
   `create_goods_issue`).
5. `create_goods_issue(...)` -> insert `transactions`+`transaction_lines`+`goods_issues`+
   `goods_issue_lines` (dengan `unit_price`), jurnal Piutang↔Pendapatan+HPP↔Persediaan.
6. Lookup `invoice_id` dari `goods_issues` (lihat bug di bawah kenapa ini WAJIB, bukan pakai
   return value RPC langsung), baca `transactions.amount` (angka FINAL termasuk PPN).
7. `record_payment(...)` -> lunasi PENUH seketika, jurnal Kas↔Piutang.
8. **TIDAK ADA insert apa pun lagi** — beda dari `0076`, gak ada tabel penanda yang perlu diisi.
   Return `v_transaction_id` langsung.

#### Bug laten `0076` yang diperbaiki `0079`: return value `create_goods_issue` disalahartikan

`create_goods_issue` (definisi gak berubah sejak `0074`) **return `id` baris `goods_issues`
sendiri** (`v_issue_id`), **BUKAN** `invoice_id` (FK ke `transactions`) — lihat
`goods-issue-schema.md`. Versi `0076`/`0078` awal `create_pos_sale` salah nganggep return
value itu langsung id transaksi:

```sql
v_transaction_id := create_goods_issue(...);          -- padahal isinya goods_issue.id
select amount into v_settle_amount
  from transactions where id = v_transaction_id;       -- SELALU 0 baris ketemu
```

Semua caller LAIN `create_goods_issue` (modul goods-issues manual, Sales Order fulfillment)
gak pernah pakai return value-nya (cuma cek `{ error }` di frontend) — `create_pos_sale`
JUSTRU caller pertama yang bergantung padanya, dan salah pakai. Konsekuensi: `select ... into`
yang gak ketemu baris ninggalin `v_settle_amount` NULL (bukan error) -> `record_payment`
kebagian `p_amount` NULL -> `journal_lines` insert `coalesce(NULL,0)=0` di KEDUA sisi
debit/credit sekaligus -> **ngelanggar check constraint `journal_lines_check`** -> RPC
`raise exception` -> checkout kasir SELALU GAGAL TOTAL (no partial write, sesuai desain —
tapi gagal di titik yang salah). **0 transaksi POS nyata pernah lewat sejak `0076` live**
(diverifikasi query langsung ke DB sebelum `0078`/`0079` ditulis), jadi bug ini gak pernah
kena user sungguhan — ketauan lewat smoke-test manual (`supabase db query --linked`,
disimulasikan `auth.uid()` pakai `set_config('request.jwt.claim.sub', ...)`, dibungkus
transaksi yang di-`ROLLBACK` biar gak nyisa data test di DB live) yang dijalankan SETELAH
`0078` di-push, BUKAN ketauan dari review `schema-reviewer` (6 ronde review gabungan `0076`+
`0078` semuanya gak nangkep — efeknya cuma muncul kalau fungsi beneran dieksekusi
end-to-end). **Fix (`0079`)**: tangkep return value sebagai `v_goods_issue_id`, baru
`select invoice_id into v_transaction_id from goods_issues where id = v_goods_issue_id`.
Diverifikasi ulang smoke-test yang sama setelah fix — checkout+void full lifecycle jalan
normal (stok konsumsi/restore, jurnal, view status, semuanya konsisten).

**Pelajaran buat RPC lain**: kalau ada RPC baru yang mau MULAI pakai return value
`create_goods_issue`, jangan asumsikan itu id transaksi — selalu lookup `invoice_id` dari
`goods_issues` pakai id yang dikembalikan.

### RPC `void_pos_transaction` — cari goods_issue/payment LANGSUNG lewat FK, gak butuh tabel penanda

```sql
create function void_pos_transaction(
  p_transaction_id uuid, p_entry_date date, p_source_ref text
) returns uuid language plpgsql security invoker as $$ ... $$;
```

SENGAJA TIDAK generik (bukan `reverse_transaction` buat semua jenis transaksi — lihat
`memory/scope-debt/generic-transaction-reversal.md`). Guard eksplisit persis kriteria "pola
penjualan kios sederhana": `count(*)` dari `goods_issues where invoice_id=...` harus persis 1,
`count(*)` dari `payments where transaction_id=... and type='OUTBOUND'` harus persis 1 DAN
`amount`-nya harus sama persis dengan `transactions.amount` (melunasi PENUH, bukan sebagian),
`count(*)` dari `returns`/`deposit_applications` harus 0. Kalau gak match, `raise exception`
suruh pakai `cancel_ar_invoice`. Guard "udah pernah dibatalkan" pola sama RPC lain
(`exists ... reverses_entry_id`, **TOCTOU race tanpa row lock, inherited risk sama kelasnya
`cancel_ar_invoice`/`cancel_ap_bill`, sengaja gak diperbaiki**). Reverse urutan: payment ->
goods_issue -> transaction. Restore stok manual (agregat per `item_id`) + insert baris
kompensasi ke `inventory_movements` (kelas bug sama `0056` — tanpa ini Kartu Stok drift meski
`inventory_balances` benar).

### View `pos_sales_with_status` — single-source, PURE STRUKTURAL

```sql
create view pos_sales_with_status with (security_invoker = true) as
select
  t.id, t.date as sale_date, t.source_ref, t.journal_entry_id as revenue_journal_entry_id,
  t.amount as total,
  case when t.status = 'lunas' then 'normal' else t.status end as status,
  t.counterparty_id as customer_id, c.name as customer_name,
  cash_jl.account_id as cash_account_id, ca.code as cash_account_code, ca.name as cash_account_name
from transactions t
  join goods_issues gi on gi.invoice_id = t.id
  join payments pay on pay.transaction_id = t.id and pay.type = 'OUTBOUND' and pay.amount = t.amount
  left join journal_lines cash_jl on cash_jl.journal_entry_id = pay.journal_entry_id and cash_jl.debit > 0
  left join counterparties c on c.id = t.counterparty_id
  left join accounts ca on ca.id = cash_jl.account_id
where t.type = 'OUTBOUND'
  and not exists (select 1 from goods_issues gi2 where gi2.invoice_id = t.id and gi2.id <> gi.id)
  and not exists (select 1 from payments p2 where p2.transaction_id = t.id and p2.type = 'OUTBOUND' and p2.id <> pay.id)
  and not exists (select 1 from returns r where r.transaction_id = t.id)
  and not exists (select 1 from deposit_applications da where da.transaction_id = t.id);
```

Kolom publik TIDAK berubah dari `0076`/`0077` (`apps/erp/src/lib/pos-sales/*.ts` gak perlu
berubah) — bedanya cuma SUMBER kolom: `cash_account_id`/`code`/`name` sekarang dibaca dari
baris DEBIT jurnal `payments` (`record_payment` selalu tulis persis 2 baris: debit kas,
kredit kontrol — join `journal_lines` filter `debit > 0`), bukan kolom disalin `pos_sales`
(tabelnya udah gak ada). "Exactly one goods_issue/payment" ditegakkan lewat `NOT EXISTS`
self-join per baris (bukan `GROUP BY ... HAVING COUNT=1`, biar tetap bisa nampilin kolom
detail tanpa aggregate) — dikonfirmasi `schema-reviewer` gak ada bug "keambil row sembarang"
(tiap baris hasil join dicek ulang exclusivity-nya sendiri, bukan dicek sekali di level grup).

### `apps/pos` — riwayat struk baca `goods_issue_lines`/`transaction_lines` langsung

`fetchRecentSales` (`apps/pos/src/app/page.tsx`) query `transactions` + embed
`goods_issues!inner(goods_issue_lines(...))` (item+harga) + `payments!inner(...)` (buat
akun kas, lookup terpisah ke `journal_lines`) + `transaction_lines` (kategori tambahan+PPN).
Baris "basket item" (kredit ke akun pendapatan utama) dibedain dari baris "genuinely extra"
BUKAN lewat amount-matching (bisa kebetulan sama) tapi lewat **membership ke
`charge_categories` (`module='pos'`)** — akun basket item gak pernah ada di katalog itu
(dipilih lewat `LockedAccountField`/parameter tetap, bukan pilihan kasir) — pola sama
`ar-invoices/[id]/view.tsx` (`chargeLabelByAccountId`). `apps/erp/src/app/(app)/pos-sales/[id]/view.tsx`
pakai pola identik buat tab "Kategori Tambahan & PPN".

## Data Historis Pra-Unifikasi (Pra-`0076`) — TETAP Dihapus Permanen

Gak berubah dari `0077` — struktur jurnal POS lama (1 jurnal langsung, bukan 2 jurnal
Piutang↔Pendapatan+Kas↔Piutang) gak bisa dipetakan ke bentuk baru tanpa memalsukan
`journal_entries` immutable. GL/laporan keuangan gak kesentuh; yang hilang cuma rincian
per-item + kemampuan batalkan lewat UI buat data itu.

## Glossary

- **Identitas POS**: sejak `0078`, PURE STRUKTURAL — transaksi `OUTBOUND` + persis 1
  `goods_issues` + persis 1 `payments` lunas penuh + 0 retur/DP. Gak ada tabel penanda.
- **`create_pos_sale`**: orkestrator `create_goods_issue`+`record_payment`, signature
  eksternal gak berubah sejak `0076`. `security definer` PERTAMA di project.
- **`void_pos_transaction`**: cari goods_issue/payment lewat FK (`invoice_id`/`transaction_id`),
  guard "pola penjualan kios sederhana", reverse 3 jurnal + restore stok + kompensasi
  `inventory_movements`.
- **`goods_issue_lines.unit_price`**: harga jual per baris (migration `0078`), nullable,
  mutual exclusive sama `order_line_id`. Satu-satunya data POS yang genuinely gak ada
  tempat lain nyimpennya.
- **Role `cashier`**: gak berubah — cuma bisa lewat `create_pos_sale`.
- **"Pelanggan Umum"**: row `counterparties` sintetis, fallback wajib. ID di
  `pos_settings.walk_in_customer_id`. **Belum diimplementasi** (non-fatal): guard cegah
  row ini ke-arsip gak sengaja lewat `/customers` — worst-case tombol arsip gagal dengan
  error (FK banyak), bukan sukses.
