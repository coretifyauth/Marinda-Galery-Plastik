# Unifikasi POS Sale ke dalam `transactions` (OUTBOUND) + orkestrasi `payments` otomatis

**Modul asal:** cross-cutting (POS, AR/`transactions`, Inventory `goods_issues`, `payments`, `counterparties`). Hasil diskusi eksplorasi arsitektur dengan user (2026-09-06), lanjutan dari `ar-ap-unify-transactions.md` (closed). **Status: migration + frontend LENGKAP ditulis & direview, BELUM diapply ke live DB — nunggu eksekusi `supabase db push`.**

## Kasus

Setelah `ar_invoices`+`ap_bills` digabung jadi `transactions`, muncul pertanyaan: apakah `pos_sales` (penjualan kasir) bisa ikut dipetakan ke `transactions(type='OUTBOUND')`, supaya penjualan kios ikut kebaca sebagai bagian dari piutang/laporan AR yang sama, bukan sistem terpisah?

Kesimpulan eksplorasi: **struktur jurnalnya cocok** (POS = "debit 1 akun kontrol, kredit N baris variabel + PPN opsional", identik `create_transaction`) — tapi POS immediately-settled (gak pernah nyisa outstanding, gak pernah butuh `payments` menyusul belakangan kayak AR biasa), sedangkan `create_transaction` didesain buat piutang yang MEMANG bisa nyisa outstanding. Diputuskan: `create_pos_sale` tetap 1 RPC yang dipanggil kasir (workflow gak berubah), tapi isinya diganti jadi ORKESTRASI 3 RPC yang udah ada:

```
create_pos_sale(...)
  → create_goods_issue(...)     -- bikin transactions(OUTBOUND) + konsumsi stok + jurnal HPP + baris goods_issues
  → record_payment('OUTBOUND', p_transaction_id=<hasil di atas>, ...) -- lunasi seketika, jurnal Kas<->Piutang
```

## Keputusan (Fase 1)

1. **`counterparty_id` wajib diisi (`transactions.counterparty_id not null` TIDAK dilonggarkan)** — user eksplisit menolak melonggarkan constraint ini (resikonya: 1 guard fail-fast yang sekarang berlaku ke SEMUA pemanggil `create_transaction` jadi lemah buat semua modul, bukan cuma POS; subledger Piutang jadi punya baris "gak bertuan"). **Resolusi: 1 baris `counterparties` sintetis "Pelanggan Umum"** (role `customer`, dibuat sekali lewat `create_counterparty`), dipakai `create_pos_sale` sebagai fallback kalau kasir gak pilih customer. **User eksplisit menolak nambah kolom flag** (mis. `is_walk_in`) di `counterparties` buat menandai baris ini — jadi row ini murni row customer biasa, gak ada penanda spesial di levelnya sendiri.
2. **ID row "Pelanggan Umum" disimpan di 1 tabel singleton baru `pos_settings`** (pola identik `tax_settings`: `id boolean primary key default true, constraint pos_settings_singleton check (id)`), kolom `walk_in_customer_id uuid not null references counterparties(id)`. Dipilih ketimbang hardcode UUID literal di RPC/frontend, atau lookup by `name` (gak ada unique constraint di `counterparties.name`, rapuh).
3. **Konsekuensi operasional row sintetis ini yang WAJIB disapu bareng migration** (bukan didiamkan):
   - Row ini bakal nongol di SEMUA dropdown "pilih customer" existing (`ar-invoices`, `ar-deposits`, `ar-return-credits`, Sales Order — pola query `counterparty_type_mapping!inner(role).eq(...,'customer')`, cek `apps/erp/src/app/(app)/ar-invoices/page.tsx:116-118`) — **harus di-exclude eksplisit** (`.neq("id", walkInCustomerId)`) di SEMUA titik itu, supaya gak bisa kepilih gak sengaja buat invoice kredit sungguhan.
   - `/customers` list + `/customers/[id]` detail bakal nampilin row ini kayak customer biasa — detail page-nya bakal punya volume transaksi besar (tiap penjualan kios tanpa customer). Perlu exclude dari dropdown TAPI TETAP muncul apa adanya di list/detail (biar tetap auditable, bukan disembunyikan total).
   - Laporan apa pun ke depan yang agregat "top customer by revenue"/"piutang per customer" WAJIB exclude ID ini eksplisit, atau hasilnya menyesatkan (satu "customer" fiktif keliatan dominan).
   - Row ini gak boleh ke-arsip lewat `delete_counterparty` (bakal fallback arsip karena selalu punya banyak FK) — kalau ke-arsip gak sengaja lewat `/customers`, `create_pos_sale` bisa gagal cari fallback-nya. Belum diputuskan mekanisme cegahnya (cek `archived_at` di RPC sebelum insert? blokir tombol arsip di UI kalau id == walk-in?) — **ditunda ke Fase 2**, dicatat di sini biar gak lupa.
4. **`origin` WAJIB `'goods_movement'`, bukan `'financial_only'`** — `recompute_transaction_status()` nge-derive `origin` dari ada-gaknya baris `goods_issues` (bukan dari input manual), dan nilainya DITULIS ULANG tiap kali reducer lain (termasuk `payments`, yang otomatis dibuat 1 RPC call sama) memicu `recompute_transaction_status`. Kalau `create_pos_sale` konsumsi stok langsung (pola lama, inline) tanpa insert ke `goods_issues`, origin bakal SELALU balik ke `financial_only` meski ada barang fisik keluar — salah. **Resolusi: WAJIB pakai `create_goods_issue`** (bukan konsumsi inline lagi) supaya baris `goods_issues`+`goods_issue_lines` (dengan `order_line_id = NULL`, karena POS gak pernah dari Sales Order) beneran ada sebagai bukti fisik yang dibaca fungsi itu.
5. **`cancel_ar_invoice` TIDAK BISA dipakai buat batalkan POS** — RPC itu `raise exception` kalau invoice udah punya `payments` sama sekali (guard ini benar buat AR biasa: staff harus reverse payment dulu manual sebelum cancel invoice). POS SELALU punya `payments` (settle seketika di RPC yang sama) — kalau reuse `cancel_ar_invoice` apa adanya, tombol "Batalkan" di POS bakal SELALU gagal. **Resolusi: RPC baru `void_pos_transaction`** (bukan reuse), mirror `void_pos_sale` lama tapi tau cara reverse 3 jurnal (transaction, goods_issue, payment) + restore stok manual sama pola lama.
6. **Gak ada cara bedain "`transactions` row dari kasir POS" vs "dari form AR Invoice manual"** begitu digabung — keduanya sama-sama `type='OUTBOUND'`, `origin` bisa sama-sama `goods_movement` (AR manual buat walk-in counter sale tanpa SO juga origin-nya `goods_movement`). Ini dibutuhkan buat: (a) halaman `/pos-sales` list KHUSUS transaksi kasir, (b) nentuin tombol "Batalkan" mana yang muncul (`void_pos_transaction` vs `cancel_ar_invoice`). **Resolusi: `pos_sales` TIDAK dihapus total** — disusutkan jadi tabel PENANDA tipis (bukan nambah kolom baru di `transactions`, sesuai batasan user):
   ```sql
   create table pos_sales (
     transaction_id uuid primary key references transactions(id),
     goods_issue_id uuid not null references goods_issues(id),
     payment_id uuid not null references payments(id),
     created_at timestamptz not null default now()
   );
   ```
   Gak nyimpen data finansial apa pun (semua di `transactions`/`transaction_lines`/`goods_issues`/`payments`) — murni "cap resmi: transaksi ini lahir dari kasir" + pointer ke 3 baris yang harus di-reverse bareng kalau dibatalkan. `/pos-sales` list jadi `select ... from transactions join pos_sales using (transaction_id) join goods_issues ... join payments ...`.

## Yang BELUM diputuskan

- Mekanisme cegah row "Pelanggan Umum" ke-arsip gak sengaja (poin 3 di atas) — ditunda, gak fatal (lihat catatan di Fase 4).

## Temuan kritis (histori) — data historis `pos_sales` gak bisa di-backfill, DIPUTUSKAN DIHAPUS PERMANEN

Beda dari preseden `ar_invoices`/`ap_bills` (`0064`) yang backfill-nya aman karena struktur jurnal LAMA dan BARU identik (1 jurnal Piutang<->Pendapatan, cuma pindah tabel) — struktur jurnal POS **berubah bentuk**, bukan cuma pindah tabel:

- **Lama**: 1 jurnal langsung `Debit Kas / Kredit Pendapatan` (+HPP terpisah).
- **Baru**: WAJIB 2 jurnal (`Debit Piutang / Kredit Pendapatan` lewat `create_transaction`, lalu `Debit Kas / Kredit Piutang` lewat `record_payment`) — supaya bisa lewat mekanisme `create_goods_issue`+`record_payment` yang direncanakan.

`journal_entries`/`journal_lines` immutable (`block_edit_delete`) — gak ada cara "mecah" 1 baris jurnal lama jadi pola 2-jurnal baru tanpa mengubah/memalsukan riwayat pembukuan yang udah kejadian. **Backfill gak mungkin dilakukan, apa pun keputusannya soal data lama.**

**Rencana AWAL (SUDAH DIBATALKAN)**: `pos_sales`/`pos_sale_lines`/`pos_sale_extra_credit_lines` di-`rename` jadi `*_legacy`, dibekukan permanen sebagai arsip pra-cutover, `/pos-sales` baca UNION 2 sumber (legacy + baru). Sempat ditulis & lolos review `schema-reviewer` ronde 1-2.

**KEPUTUSAN FINAL user (2026-09-06)**: rencana rename dibatalkan — data lama **DIHAPUS PERMANEN** (`drop table pos_sales cascade`), bukan dibekukan. Alasan user: data itu "udah gak dipakai". Konsekuensi (dikonfirmasi eksplisit ke user sebelum eksekusi via `AskUserQuestion`, dipilih "Hapus permanen tabelnya"):
- `journal_entries`/`journal_lines` historis TIDAK ikut kehapus (tabel terpisah, gak ada FK dari situ ke `pos_sales`) — GL/laporan keuangan (Trial Balance, Laba Rugi, dst) sama sekali gak kesentuh.
- Yang HILANG selamanya: rincian per-item + nama customer penjualan kios lama, dan kemampuan "Batalkan" lewat UI (`void_pos_sale` ikut didrop, gak ada RPC pengganti buat data lama — koreksi kalau dibutuhkan harus manual lewat Journal Entry, gak otomatis balikin stok).
- `/pos-sales` di ERP cuma nampilin penjualan SETELAH migration ini — jadi single-source (gak ada UNION lagi), lebih simpel dari rencana awal.
- Migration disederhanakan: `journal_entries_sync_reversal_status` gak perlu cabang repoint ke `*_legacy` (dihapus total, bukan direpoint), `void_pos_sale` di-drop total (bukan disesuaikan), `pos_sales_with_status` jadi single-source (gak UNION), detail page `/pos-sales/[id]` gak perlu 2 jalur (`loadLegacy`/`loadNew`) lagi — cuma 1 model.

## Rencana Bertahap

```
Fase 1: Keputusan & Desain     -- SELESAI (dokumen ini)
Fase 2: RPC Layer + hapus lama -- SELESAI DITULIS, direview schema-reviewer 2 ronde, BELUM diapply ke live DB
Fase 3: Migrasi Struktural     -- TIDAK ADA (data lama dihapus, bukan dimigrasi -- lihat "Temuan kritis")
Fase 4: Sweep Permukaan        -- SELESAI DITULIS (apps/pos + apps/erp), tsc bersih, BELUM ditest end-to-end (belum bisa, migration belum live)
```

### Fase 4 — detail

- `apps/pos/src/app/page.tsx` (`fetchRecentSales`) -- direwrite total, sekarang query `pos_sales` (bentuk baru) join `transactions`+`pos_sale_lines`+`pos_sale_extra_credit_lines` (2 tabel terakhir dibikin ulang khusus buat ini, lihat temuan di atas). Alur `checkout()`/`create_pos_sale` sendiri NOL PERUBAHAN (signature byte-identik).
- `apps/erp/src/lib/pos-sales/{schema,queries}.ts` + `pos-sales/page.tsx` -- disesuaikan ke kolom flat view `pos_sales_with_status` yang baru (bukan lagi nested embed `counterparties(...)`/`cash_account:accounts(...)`).
- `apps/erp/src/app/(app)/pos-sales/[id]/view.tsx` -- direwrite total, sekarang single-source (gak ada lagi jalur `legacy` sejak data lama diputuskan dihapus permanen, bukan dibekukan). Tombol "Batalkan" cuma manggil `void_pos_transaction`. Tab baru "Kategori Tambahan & PPN" (dari `pos_sale_extra_credit_lines`) + HPP per baris item gak dipecah lagi (cuma agregat di Ringkasan, dari `goods_issue_lines.total_cost`).
- **Sweep dropdown "Pelanggan Umum"** -- helper baru `apps/erp/src/lib/pos-settings/schema.ts` (`fetchWalkInCustomerId`), di-exclude (`.neq("id", walkInCustomerId)`) dari dropdown pilih customer di 4 form: `ar-invoices`, `ar-deposits`, `goods-issues`, `sales-orders` (tempat customer dipilih buat kredit/DP/SO/goods-issue manual sungguhan). SENGAJA GAK di-exclude dari `pos-sales/page.tsx` (filter list POS -- walk-in emang penjualan POS asli, wajar muncul di filter itu) dan `customers/page.tsx` (master list, harus tetap auditable).
- `tsc --noEmit` bersih di `apps/erp` dan `apps/pos` setelah semua perubahan di atas.
- **BELUM dikerjakan**: mekanisme cegah row "Pelanggan Umum" ke-arsip gak sengaja lewat `/customers` (item lama dari Fase 1, masih ditunda) -- gak fatal buat rilis awal (fallback arsip `delete_counterparty` gak akan pernah SUKSES buat row ini karena FK-nya jelas banyak, jadi worst-case tombol hapus di UI gagal dengan error, bukan sukses).

### Fase 2 — `supabase/migrations/0076_pos_unify_transactions.sql`, direview `schema-reviewer` 2 ronde + direvisi setelah keputusan hapus-permanen

Riwayat penulisan (draft awal pakai rename+bekukan, direvisi total setelah keputusan final user):

1. **Draft awal** (rename `pos_sales`→`pos_sales_legacy` dkk, `void_pos_sale` direpoint) — 2 temuan review ronde 1: **(a)** trigger `journal_entries_sync_reversal_status` kehapus cabang `pos_sales_legacy` yang masih dibutuhkan `void_pos_sale`, fix: direpoint bukan dihapus; **(b)** `ar_invoice_remaining`/`ap_bill_remaining` gak nge-exclude `payments` yang jurnalnya udah di-reverse — gap laten yang baru kena gara-gara `void_pos_transaction` (RPC pertama yang reverse jurnal 1 payment doang tanpa hapus barisnya), fix: tambah exists-check pola `deposit_applications`.
2. **Temuan tambahan** (nulis frontend, sebelum ronde 2): `apps/pos` `fetchRecentSales` butuh `unit_price`/`line_amount` per item buat cetak struk — data itu cuma pernah ada di `pos_sale_lines`, `goods_issue_lines` (pengganti generic) cuma nyimpen `qty_issued`+`total_cost` (HPP). Fix: tambah 2 tabel kecil khusus tampilan struk (`pos_sale_lines`+`pos_sale_extra_credit_lines`, bukan sumber kebenaran akuntansi), diisi `create_pos_sale` bareng insert `pos_sales`.
3. **Ronde 2** (setelah nambah 2 tabel + view `pos_sales_with_status` UNION legacy+baru) — 1 blocker: `CREATE OR REPLACE VIEW` gak boleh ubah urutan/nama kolom existing atau ngapus kolom, definisi lama (`customer_id` posisi ke-2, ada `created_at`) beda total dari definisi baru (kolom flat) — migration bakal ERROR total kalau dipaksa `or replace`. Fix: `drop view if exists` + `create view` biasa. Plus 1 catatan non-blocking (ditambahin sebagai komentar SQL): asumsi "status POS cuma `lunas`/`dibatalkan`" itu valid sekarang tapi gak dijamin constraint — kalau RPC retur/deposit berubah, status lain bisa lolos diam-diam ke view ini.
4. **REVISI TOTAL setelah keputusan user "hapus permanen"** (bukan rename+bekukan) — disederhanakan banyak dari draft ronde 2: `drop table pos_sales cascade` (bukan rename, otomatis nyabut anak tabel + view lama sekalian), cabang `journal_entries_sync_reversal_status` buat legacy DIHAPUS TOTAL (bukan direpoint — gak ada lagi tabel buat direpoint), `void_pos_sale` DI-DROP TOTAL (`drop function`, bukan disesuaikan), `pos_sales_with_status` jadi single-source (`pos_sales` join `transactions`, gak ada `UNION` lagi). Fix (1) dan (b)/exists-check `ar_invoice_remaining` di atas TETAP DIPERTAHANKAN (masih relevan, gak tersentuh keputusan ini).

**Catatan non-blocking, SENGAJA GAK DIPERBAIKI** (inherited risk, bukan baru): `void_pos_transaction` punya TOCTOU race di guard "udah pernah dibatalkan" (gak ada row lock) — kelas risiko yang sama persis yang udah didokumentasikan buat `cancel_ar_invoice`/`cancel_ap_bill` di `transactions-schema.md`. Codebase ini udah tolerir kelas risiko ini di 2 RPC lain, jadi gak dianggap blocker baru.

**Ronde 3** (verifikasi revisi hapus-permanen) — 3 temuan, SEMUA DIPERBAIKI, lebih serius dari ronde sebelumnya karena blast radius-nya nyentuh SEMUA modul inventory, bukan cuma POS:
1. **Blocker**: `drop table pos_sales cascade` DIKIRA bakal nyabut `pos_sale_lines`/`pos_sale_extra_credit_lines` lama juga (asumsi salah soal `on delete cascade` di FK — itu cuma governs row-level delete, bukan `DROP TABLE`). Tanpa fix, `create table pos_sale_lines` di bagian 3 gagal "relation already exists" — migration gagal apply total. Fix: `drop table` eksplisit buat 2 tabel anak SEBELUM `drop table pos_sales cascade`.
2. **Blocker**: `drop table pos_sales cascade` diam-diam ikut nyabut view `inventory_movements_with_source` (dipakai laporan Kartu Stok buat SEMUA jenis mutasi — pembelian, produksi, retur, stock opname, dst, bukan cuma POS) karena view itu JOIN ke `pos_sales`. Draft awal gak nyadar ini bahkan gak nge-list-nya sebagai dependency. Tanpa fix, SELURUH laporan Kartu Stok 500 buat SEMUA item begitu migration ini live. Fix: view dibikin ulang (bagian 9 baru), copy definisi asli `0075` persis, cabang `pos_sale_line_id` gak lagi coba JOIN ke `pos_sale_lines`/`pos_sales` (datanya udah kehapus, gak ada yang bisa disambungin) — baris historis tetap dapet label "Penjualan (Kios/POS)" tapi `source_ref`-nya sekarang NULL. Penjualan POS BARU otomatis kebaca label generic "Penjualan (Kirim Barang)" (sama kayak goods issue manapun) karena emang gak lewat kolom `pos_sale_line_id` lagi (lewat `goods_issue_line_id`) — konsekuensi wajar unifikasi, bukan bug.
3. **Blocker**: `void_pos_transaction` cuma balikin `inventory_balances.qty_on_hand`, lupa nulis baris kompensasi ke `inventory_movements` — bug kelas SAMA PERSIS yang migration `0056` perbaiki buat `void_pos_sale` versi lama (tanpa ini, ledger drift permanen dari saldo real). Fix: tambah loop insert kompensasi per `goods_issue_lines`, pola sama `0056` tapi pakai `goods_issue_line_id` (bukan `pos_sale_line_id` lagi).

**Ronde 4** (verifikasi 3 fix ronde 3) — 2 dari 3 fix dikonfirmasi benar (view `inventory_movements_with_source` + compensating insert `void_pos_transaction`), tapi ketemu **1 blocker baru** di fix pertama:
- **Blocker**: `drop table pos_sale_lines` (tanpa CASCADE) bakal ERROR "other objects depend on it" — `inventory_movements` (migration `0042`) punya composite FK AKTIF `foreign key (pos_sale_line_id, item_id) references pos_sale_lines(id, item_id)` yang gak pernah dicabut migration manapun sebelum ini. Beda dari `pos_sale_extra_credit_lines` (dikonfirmasi gak ada tabel lain yang FK ke situ, plain drop aman). Fix: tambah `cascade` khusus di drop `pos_sale_lines` — aman, yang ke-drop cuma constraint FK-nya (bukan data `inventory_movements`), kolom `pos_sale_line_id` + nilai historisnya tetap utuh sebagai penunjuk mati.

**Ronde 5** (verifikasi sempit fix ronde 4 + baca ulang full file) — **gak ada blocker baru**. 1 catatan kosmetik: 2 fungsi trigger standalone dari `0053` (`pos_sales_block_edit_delete_or_sync`, `pos_sale_lines_sync_total`) jadi dead code (badannya baca kolom tabel lama) karena `DROP TABLE CASCADE` cuma nyabut trigger yang NEMPEL ke tabel, bukan fungsi standalone-nya — ditambahin `drop function if exists` buat keduanya, non-blocking tapi beresin sekalian.

**Status akhir: migration SIAP diapply — 5 ronde review (`schema-reviewer`), total 7 blocker + 1 warning + 1 catatan kosmetik ditemukan sepanjang proses, SEMUA sudah diperbaiki.** Fase 4 (frontend `apps/pos`+`apps/erp`) sudah ditulis lengkap, `tsc --noEmit` bersih di kedua app. Nunggu keputusan user kapan/siapa yang jalanin `supabase db push`.

## Referensi

- `memory/architecture/data/pos-schema.md` — desain `pos_sales` lama (jadi acuan histori sebelum disusutkan).
- `memory/architecture/data/transactions-schema.md` — `create_transaction`, `recompute_transaction_status`, vocabulary `origin`.
- `memory/architecture/data/goods-issue-schema.md` — `create_goods_issue` (RPC yang bakal dipanggil dari dalam `create_pos_sale` baru).
- `memory/architecture/data/payments-schema.md` — `record_payment` (dipanggil buat settle seketika).
- `memory/architecture/data/counterparty-schema.md` — `create_counterparty`, `counterparty_role_guard` (toleran NULL, tapi gak dipakai di sini karena `not null` dipertahankan).
- `memory/scope-debt/ar-ap-unify-transactions.md` (closed) — preseden pola kerja bertahap yang diikuti di sini.
