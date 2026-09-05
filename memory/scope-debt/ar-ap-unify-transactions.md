# Gabung `ar_invoices`+`ap_bills` jadi 1 tabel `transactions` (`type` INBOUND/OUTBOUND)

**Modul asal:** cross-cutting (AR, AP, dan pemanggilnya di Inventory — `create_goods_issue`/`create_goods_receipt`). Hasil diskusi eksplorasi arsitektur dengan user (2026-09-05), bukan gap yang ketemu pas bangun fitur. **Status: Fase 1-4 selesai & LIVE (2026-09-05)** — `transactions`+`transaction_lines` sekarang sumber kebenaran aktif buat AR+AP, semua pemanggil (RPC internal + 2 form frontend) udah dialihkan, sweep permukaan (~20 file) kelar, diverifikasi lewat query DB langsung + PostgREST REST API + `tsc --noEmit`. **Sisa 1 langkah** (drop tabel lama `ar_invoices`/`ap_bills`/`ar_invoice_credit_lines`/`ap_bill_debit_lines`/`ar_bad_debt_writeoffs`, sekarang cuma dibekukan) ditunda sengaja — jeda observasi dulu, lihat "Sisa Pekerjaan" di bawah.

Menggantikan draft awal (`journal-account-determination.md`, ide "tabel journal template" generik) — setelah `create_ar_invoice`/`create_ap_bill` dibaca langsung side-by-side, ternyata bentuknya JAUH lebih dekat buat digabung daripada draft awal ngira. Ide "journal template" sendiri gak dilanjutkan sebagai item terpisah — kebutuhannya udah kejawab jadi bagian desain RPC `create_transaction` di bawah.

## Kasus

Diskusi bermula dari pertanyaan kenapa `ar_invoices`+`ap_bills` gak bisa digeneralisasi kayak `purchase_orders`+`sales_orders` jadi `orders` (`memory/architecture/data/inventory-schema.md` submodule "Purchase Order & Sales Order"). Klaim awal (dari eksplorasi pertama): AR dan AP beda substansi akuntansi, gak mungkin digabung. Setelah dibedah lebih dalam pakai kode aktual (`create_ar_invoice`/`create_ap_bill`, `supabase/migrations/0059_counterparty_schema.sql:241-461`), klaim itu ternyata KELIRU di 1 poin penting:

**Perbandingan struktur jurnal langsung dari kode:**

```
create_ar_invoice:                          create_ap_bill:
  1 baris FIXED:   Debit Piutang (total)       1 baris FIXED:   Kredit Utang (total)
  N baris VARIABEL: Kredit kategori...         N baris VARIABEL: Debit kategori...
  1 baris opsional: Kredit PPN Keluaran        1 baris opsional: Debit PPN Masukan
```

Ini cermin sempurna — cuma beda arah debit/kredit, bisa digenericin lewat 1 kolom `type`.

**Klaim lama soal "AR bikin 2 jurnal, AP cuma 1" itu SALAH ATRIBUSI** — jurnal ganda (HPP/Persediaan) itu punya `create_goods_issue`, BUKAN `create_ar_invoice`. `create_goods_issue` **MEMANGGIL** `create_ar_invoice(...)` di dalamnya, baru abis itu bikin 1 jurnal HPP terpisah sendiri — persis pola `create_goods_receipt` yang **MEMANGGIL** `create_ap_bill(...)` di dalamnya. Di level `ar_invoices`/`ap_bills` sendiri (bukan level pemanggilnya), jurnalnya SUDAH simetris (1 masing-masing).

**Sisa asimetri nyata, cuma 2:**
1. **Credit Hold** (`create_ar_invoice` doang) — query outstanding semua invoice customer + cek `counterparties.credit_limit`/`overdue_threshold_days`, `raise exception` kalau kelewat. `create_ap_bill` gak punya sama sekali.
2. **`ap_bills.supplier_document_ref`** — 1 kolom nullable ekstra (nomor nota asli supplier), gak ada padanan di `ar_invoices`. Kecil, gampang ditoleransi sebagai kolom nullable yang cuma keisi kalau `type='OUTBOUND'`.

## Kenapa awalnya ditunda (histori — semua sudah dieksekusi 2026-09-05, lihat "Rencana Bertahap" di bawah buat status final)

1. ~~Prasyarat: keputusan owner soal Credit Hold belum ada.~~ **Selesai 2026-09-05 — owner putuskan SINGKIRKAN.** Fitur `ar_bad_debt_writeoffs` + `counterparties.credit_limit`/`overdue_threshold_days` + check di `create_ar_invoice` akan disingkirkan (eksekusi teknisnya nunggu Fase 2/3 di bawah, gak langsung dieksekusi di sesi keputusan ini — ini keputusan produk yang bukanya jalur teknis mendesak).
2. **Blast radius migrasi LEBIH GEDE dari `orders`** — `orders` cuma punya sedikit dependent (karena PO/SO dulu belum ada jurnal). `ar_invoices`/`ap_bills` udah ada jurnal DAN udah punya **11 tabel turunan** yang FK ke situ: `ar_payments`, `ar_credit_notes`, `ar_deposits`, `ar_return_credits`, `ar_invoice_credit_lines` (+ `ar_bad_debt_writeoffs`, sekarang PASTI ikut disingkirkan bukan lagi kondisional) di sisi AR; `ap_payments`, `ap_credit_notes`, `ap_deposits`, `ap_return_credits`, `ap_bill_debit_lines` di sisi AP. Semua butuh repoint FK + trigger + view disesuaikan — pola teknisnya udah ada (`_repoint_fk_to_counterparties`/`_repoint_fk`, `0059`/`0060`), tapi jumlah tabel yang kena jauh lebih banyak.
3. **Belum ada tekanan kebutuhan konkret** — murni ide eksplorasi arsitektur, belum ada bug/duplikasi yang beneran mengganggu development sehari-hari. Fase 1 (keputusan + desain schema) dikerjakan sekarang biar gak nunggu tekanan itu buat mikirin bentuknya, tapi eksekusi migration beneran (Fase 2 ke bawah) tetap nunggu ada alasan konkret.

## Rencana Bertahap (dieksekusi 2026-09-05 — dibiarkan corat-coret asli + koreksi inline, biar kelihatan mana yang meleset dari rencana pas beneran dikerjain)

Dikelompokkan jadi fase yang bisa di-batch, urutan ada dependency (fase belakang butuh fase sebelumnya kelar) — pola sama `order-generalization.md` (sudah closed, jadi preseden format). **Ternyata Fase 2 langkah 4 s/d Fase 4 gak bisa di-batch terpisah kayak rencana awal** — begitu dibongkar pas eksekusi, semua saling gantung (lihat koreksi di tiap langkah) dan akhirnya dikerjain 1 sesi penuh.

```
Fase 1: Keputusan & Desain     -- prasyarat non-teknis + rancangan schema, belum ada kode jalan
Fase 2: RPC Layer              -- RPC baru dibikin & pemanggil internal diganti, BELUM sentuh data lama
Fase 3: Migrasi Struktural     -- tabel/FK/trigger/view lama diganti beneran, paling berisiko
Fase 4: Sweep Permukaan        -- frontend + laporan, mekanis tapi lebar
```

### Fase 1 — Keputusan & Desain

1. ~~**Keputusan owner: singkirkan Credit Hold**~~ **SELESAI 2026-09-05 — SINGKIRKAN.** `ar_bad_debt_writeoffs`, `counterparties.credit_limit`/`overdue_threshold_days`, dan check-nya di `create_ar_invoice` akan hilang total pas migrasi struktural (Fase 3) / gak dibawa ke `create_transaction` baru (Fase 2). Eksekusi drop-nya sendiri belum jalan sekarang (nunggu fase teknisnya), keputusan produknya yang sudah final.

2. **Desain schema `transactions`+`transaction_lines`** — SELESAI, mirror `orders`+`order_lines`. Union kolom `ar_invoices`+`ap_bills`, ketauan **2 asimetri tambahan** pas nulis desain ini (di luar Credit Hold & `supplier_document_ref` yang udah kecatat sebelumnya) — dicatat di bawah, belum diputuskan resolusinya, jadi bukan blocker (bisa jalan `NULL`-able) tapi butuh keputusan desain kecil pas Fase 2 beneran ditulis:

   - **Kolom `returned`** — cuma ada di `ar_invoices` (dipakai `invoiceStatus()` buat bedain retur murni dari sebagian/write-off, lihat submodule "AR Invoice" `ar-schema.md` migration `0053`). `ap_bills` gak punya padanan — AP gak punya konsep write-off utang (gak ada `ap_bad_debt_writeoffs`), jadi status AP cuma butuh `outstanding`. Opsi: (a) kolom `returned` tetap ada di `transactions`, `NULL`/`0` selalu buat `type='OUTBOUND'`; (b) pindahin ke tabel terpisah `transaction_returns` cuma buat `INBOUND`. Cenderung (a) — lebih murah, konsisten sama pola `supplier_document_ref` (nullable-cuma-1-arah) yang udah diterima duluan.
   - **Vocabulary `origin` beda istilah AR vs AP** — AR pakai `financial_only`/`sales_order`/`goods_issue`, AP pakai `langsung`/`grn` (`ap_bills_with_status`, migration `0038`/`0032`). Union butuh 1 vocabulary bersama sebelum `origin` bisa jadi kolom generik yang enak dibaca laporan — bukan cuma soal tipe kolom, istilahnya beneran beda kata. Belum diputuskan: unifikasi ke istilah AR (lebih deskriptif), istilah AP (lebih singkat), atau istilah baru netral (mis. `financial_only`/`order`/`goods_movement`). Ini keputusan kecil, bisa ditunda sampai Fase 2 beneran ditulis (gak butuh keputusan owner terpisah kayak Credit Hold — murni penamaan teknis).

   **Rancangan DDL** (union, belum final — ditulis ulang sekali lagi pas Fase 2 kalau ada yang kelewat):

   ```sql
   create table transactions (
     id uuid primary key default gen_random_uuid(),
     type text not null check (type in ('INBOUND', 'OUTBOUND')), -- INBOUND=piutang(dulu ar_invoices), OUTBOUND=utang(dulu ap_bills)
     counterparty_id uuid not null references counterparties(id),
     date date not null,               -- dulu invoice_date / bill_date
     due_date date not null,           -- snapshot pas dibuat, sama pola lama
     description text,
     source_ref text not null,
     amount numeric(14,2) not null check (amount > 0),
     outstanding numeric(14,2) not null,        -- denormalized (0053), dijaga trigger recompute gabungan
     returned numeric(14,2),                    -- cuma keisi type='INBOUND', lihat asimetri di atas
     status text not null,                      -- vocabulary beda per type (AR punya 'dihapusbukukan', AP enggak)
     origin text,                               -- vocabulary belum diunifikasi, lihat asimetri di atas
     supplier_document_ref text,                -- cuma keisi type='OUTBOUND' (nomor nota asli supplier)
     journal_entry_id uuid not null references journal_entries(id),
     created_by uuid references auth.users(id),
     created_at timestamptz not null default now()
   );

   create index transactions_counterparty_id_idx on transactions(counterparty_id);
   create index transactions_journal_entry_id_idx on transactions(journal_entry_id);
   create index transactions_type_idx on transactions(type);

   create table transaction_lines (
     id uuid primary key default gen_random_uuid(),
     transaction_id uuid not null references transactions(id),
     account_id uuid not null references accounts(id),
     amount numeric(14,2) not null check (amount > 0),
     is_tax boolean not null default false
   );

   create index transaction_lines_transaction_id_idx on transaction_lines(transaction_id);
   ```

   Arah baris `transaction_lines` (debit vs kredit) gak disimpan sebagai kolom — ditentuin runtime dari `transactions.type` pas `create_transaction` nyusun `p_journal_lines` buat `create_journal_entry`, persis pola rancangan RPC di Fase 2 langkah 3 (mirror `create_order(p_direction,...)`). Immutability + RLS + trigger `block_edit_delete_or_sync` (pola `0053`) ngikutin persis apa yang udah ada di `ar_invoices`/`ap_bills` — gak diulang di sini, lihat referensi `ar-schema.md`/`ap-schema.md`.

### Fase 2 — RPC Layer

3. ~~**RPC `create_transaction(...)`**~~ **SELESAI — migration `0063_transactions_schema.sql`, LIVE.** Lolos review `schema-reviewer`: 1 blocker + 2 warning ditemukan & dibenerin (guard `counterparty_role_guard` INBOUND/OUTBOUND yang kelewat dari desain awal, `p_lines` gak divalidasi kosong/≤0, `returned`/`origin` nullable tanpa default).
4. ~~**Update pemanggil**~~ **SELESAI, digabung jalan bareng Fase 3 (migration `0064`)** — sesuai temuan sebelum eksekusi: gak aman dipisah, karena `ar_payments`/dst bakal gagal FK ke invoice/bill baru kalau caller dialihkan sebelum repoint. `create_goods_issue`/`create_goods_receipt` (signature eksternal gak berubah) DAN 2 form frontend (`/ar-invoices`, `/ap-bills`) yang manggil RPC create langsung — semua dialihkan ke `create_transaction` di sesi yang sama.

### Fase 3 — Migrasi Struktural — **SELESAI, migration `0064_transactions_backfill_and_repoint.sql`, LIVE (2026-09-05)**

5. ~~**Backfill**~~ SELESAI — `transactions`/`transaction_lines` dari `ar_invoices`+`ap_bills`+`ar_invoice_credit_lines`+`ap_bill_debit_lines` PAKAI ID ASLI. Diverifikasi: row count cocok persis (10 AR + 8 AP + 27 line), spot-check `status`/`outstanding` semua baris (termasuk kasus `dibatalkan` dan histori `dihapusbukukan`) cocok byte-persis sama sumber.
6. ~~**Repoint FK**~~ SELESAI — **koreksi penting ketauan pas eksekusi**: daftar "11 tabel turunan" di draf rencana ini SALAH nama & GAK LENGKAP (`ar_deposits`/`ap_deposits`/`ar_return_credits`/`ap_return_credits` gak punya FK langsung ke invoice/bill sama sekali — itu cuma nama tabel induk dari tabel yang beneran punya FK; sebaliknya `goods_issues.invoice_id`/`goods_receipt_notes.bill_id` — yang justru paling kritis, itu yang diisi `create_goods_issue`/`create_goods_receipt` — malah gak ketulis). Daftar FINAL yang beneran di-repoint (11 tabel, by verifikasi grep `references ar_invoices(id)`/`references ap_bills(id)` di seluruh migration file):
   - **AR (5):** `ar_payments.invoice_id`, `ar_credit_notes.invoice_id`, `ar_deposit_applications.invoice_id`, `warranty_replacements.invoice_id`, `goods_issues.invoice_id`
   - **AP (6):** `ap_payments.bill_id`, `ap_credit_notes.bill_id`, `ap_deposit_applications.bill_id`, `purchase_replacements.bill_id`, `purchase_writeoffs.bill_id`, `goods_receipt_notes.bill_id`
   - `ar_invoice_credit_lines`/`ap_bill_debit_lines` GAK di-repoint (datanya udah pindah ke `transaction_lines`, tabelnya jadi leaf yang gak dipakai lagi — dibekukan, bukan didrop, lihat "Sisa Pekerjaan").
7. ~~**Trigger gabungan + 2 view terpisah**~~ SELESAI — `recompute_transaction_status(p_transaction_id)` gantiin `recompute_ar_invoice_status`+`recompute_ap_bill_status` (cabang `'dihapusbukukan'` DIHAPUS dari status baru — write-off gak lagi fitur aktif — tapi **reducer write-off TETAP dipertahankan** di `ar_invoice_remaining()`/guard `cancel_ar_invoice`, ketauan review: tabel `ar_bad_debt_writeoffs` cuma dibekukan bukan didrop, kalau reducer dicabut 2 baris histori demo yang udah di-write-off bakal "hidup lagi" outstanding-nya). `ar_invoices_with_status`/`ap_bills_with_status` di-`CREATE OR REPLACE VIEW` filter `type` di atas `transactions` — kolom `outstanding`/`returned` wajib di-cast `::numeric` (bukan `numeric(14,2)`) biar cocok typmod kolom lama, ketauan pas nulis (bukan pas review).
8. **Drop `ar_invoices`+`ap_bills` (+ `ar_invoice_credit_lines`/`ap_bill_debit_lines`/`ar_bad_debt_writeoffs`) — BELUM dikerjakan, sengaja.** Sama pola `0062` (jeda observasi). Lihat "Sisa Pekerjaan" di bawah.

### Fase 4 — Sweep Permukaan — **SELESAI, digabung 1 sesi sama Fase 3 (bukan fase terpisah kayak draf awal)**

9. ~~**Sweep frontend**~~ SELESAI, ~20 file. Ketauan pas eksekusi: draf awal cuma nyebut 2 pemanggil (`create_goods_issue`/`create_goods_receipt`) — ternyata ada 2 form frontend (`/ar-invoices`, `/ap-bills`) yang manggil `create_ar_invoice`/`create_ap_bill` LANGSUNG, plus ~15 halaman lain yang nested-embed `ar_invoices(...)`/`ap_bills(...)` dari tabel yang di-repoint (PostgREST resolve embed lewat FK constraint — begitu FK direpoint, embed ke nama tabel lama bakal 400 error, bukan cuma data basi). Strategi: pakai PostgREST embed alias (`ar_invoices:transactions(...)`/`ap_bills:transactions(...)`) — bentuk data & kode consuming (`grn.ap_bills.source_ref` dst) TETAP SAMA, cuma string query yang disentuh. Fitur "Piutang Tak Tertagih" (write-off) dicabut total dari UI (`ar-invoices/[id]/view.tsx`: state/tab/modal/query, `ar-invoices/schema.ts`: `invoiceStatus()`, file `lib/ar-bad-debt-writeoffs/schema.ts` dihapus). Diverifikasi: `tsc --noEmit` bersih, sweep grep ulang 0 sisa referensi tabel/RPC lama, PostgREST REST API live dites langsung (embed alias + RPC `create_transaction`) return sesuai ekspektasi (200 kosong karena RLS anon, bukan 400 skema).
10. ~~**Update laporan keuangan**~~ TERNYATA GAK PERLU — dicek: gak ada halaman di `reports/` (balance-sheet, cash-flow, income-statement, trial-balance, period-closing) yang reference `ar_invoices`/`ap_bills` langsung (semua GL-level via `journal_entries`). Gak ada laporan "Aging AR/AP" terpisah di codebase ini — riwayat invoice/bill per customer/supplier ada di halaman detail (`customers/[id]`, `suppliers/[id]`), yang UDAH ikut disweep di poin 9.

## Sisa Pekerjaan (belum dikerjakan, sengaja ditunda)

1. **Drop tabel lama** (`ar_invoices`, `ap_bills`, `ar_invoice_credit_lines`, `ap_bill_debit_lines`, `ar_bad_debt_writeoffs`) + RPC lama yang jadi dead code (`create_ar_invoice`, `create_ap_bill`, `write_off_ar_invoice` — RPC ini 3 udah gak dipanggil siapa pun tapi belum di-`drop function`). Nunggu jeda observasi (pola `0062`), migration terpisah.
2. **`counterparties.credit_limit`/`overdue_threshold_days`** — kolom masih ada, UI edit-nya (`customers/[id]/view.tsx`) masih ada, tapi gak ada lagi yang enforce (Credit Hold check cuma ada di `create_ar_invoice` lama yang udah gak dipanggil). Bukan bug (gak ada yang crash), tapi UX menyesatkan (kelihatan kayak masih aktif). Dirapiin bareng langkah 1 di atas.
3. **Vocabulary `origin` beda istilah AR vs AP** (`financial_only`/`sales_order`/`goods_issue` vs `langsung`/`grn`) — dicatat dari Fase 1, belum diputuskan unifikasinya. Murni penamaan, gak mendesak.

## Referensi

- `memory/architecture/data/ar-schema.md` — `create_ar_invoice` (definisi terkini: `supabase/migrations/0059_counterparty_schema.sql:241-364`), `ar_invoice_remaining()`, Credit Hold.
- `memory/architecture/data/ap-schema.md` — `create_ap_bill` (definisi terkini: `supabase/migrations/0059_counterparty_schema.sql:371-461`), `ap_bill_remaining()`.
- `memory/architecture/data/inventory-schema.md` submodule "Purchase Order & Sales Order (`orders`)" — preseden generalisasi PO+SO, pola `_repoint_fk`, dan deviasi "2 view tetap terpisah" yang jadi rujukan langkah 6 di atas. Juga tempat `create_goods_issue`/`create_goods_receipt` (pemanggil `create_ar_invoice`/`create_ap_bill`) didefinisikan.
