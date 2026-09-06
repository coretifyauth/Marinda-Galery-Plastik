# Sederhanakan `pos_sales`/`pos_sale_lines`/`pos_sale_extra_credit_lines` — Rely ke `goods_issue_lines`+`transaction_lines`

**Modul asal:** POS, lanjutan unifikasi `pos-unify-transactions.md` (migration `0076`/`0077`, sudah live). **Status:** Ditunda.

## Kasus

Diskusi eksplorasi arsitektur (2026-09-06) menemukan bahwa `pos_sales`/`pos_sale_lines`/`pos_sale_extra_credit_lines` (bentuk pasca-`0076`) sebagian besar isinya **duplikasi data yang sudah ada di tempat lain**, bukan data genuinely baru:

- `pos_sale_lines.item_id`/`qty_sold` duplikat persis `goods_issue_lines.item_id`/`qty_issued` — keduanya diisi di 2 insert loop terpisah dalam `create_pos_sale` (satu lewat `create_goods_issue`, satu manual), padahal angkanya harus selalu sama. Cuma `unit_price`/`line_amount` yang genuinely baru (gak ada di `goods_issue_lines`, yang cuma nyimpen `total_cost`/HPP, bukan harga jual).
- `pos_sale_extra_credit_lines` (`account_id`, `amount`, `is_tax`) **100% duplikat** baris kategori-tambahan+PPN yang sudah ditulis `create_transaction` (dipanggil lewat `create_goods_issue`) ke `transaction_lines` — gak ada kolom baru sama sekali, cuma disalin ulang biar gampang di-query dari `apps/pos`.

Preseden pembanding: `apps/erp/src/app/(app)/ar-invoices/[id]/view.tsx` sudah nunjukin pola yang lebih bersih — item+qty dibaca dari `goods_issues`→`goods_issue_lines`→`items`, dan harga per item (kalau ada) dari `order_lines.unit_price` (cuma keisi kalau invoice-nya fulfillment Sales Order). POS gak pernah lewat Sales Order, jadi gak punya `order_lines` — itu satu-satunya alasan `pos_sale_lines` dibikin: buat nampung `unit_price` yang di alur AR Invoice biasa udah ada tempatnya (`order_lines`).

## Kenapa ditunda

Ini keputusan desain yang cukup besar (drop 3 tabel yang baru live `0076`/`0077`, ubah 2 RPC (`create_pos_sale`, `create_goods_issue`) + 1 RPC baru buat pembatalan, ubah halaman `/pos-sales` di 2 app) — user eksplisit minta dicatat dulu sebagai tech debt, belum dieksekusi sekarang.

## Rencana teknis (hasil rekap sebelum ditunda)

1. **Drop total** `pos_sales`, `pos_sale_lines`, `pos_sale_extra_credit_lines` — gak ada tabel pengganti (sempat dipertimbangkan rename jadi `sales` generik + kolom `channel`, tapi dibatalkan — user memutuskan gak perlu bedain asal transaksi POS vs manual sama sekali).
2. **Drop kolom mati** `inventory_movements.pos_sale_line_id` — FK-nya udah orphan sejak `0077` (POS baru pakai `goods_issue_line_id`), makin gak relevan begitu `pos_sale_lines` hilang. Konsekuensi: `memory/scope-debt/inventory-movements-exactly-one-source-constraint.md` perlu diupdate (9 kolom polymorphic jadi 8) begitu ini dieksekusi.
3. **Tambah kolom** `goods_issue_lines.unit_price numeric(14,2)` nullable — keisi kalau `order_line_id` null (jalur POS/walk-in), tetap null kalau ada `order_line_id` (harga tetap bersumber dari `order_lines.unit_price`, biar gak 2 sumber kebenaran buat kasus yang sama).
4. `pos_settings` **tidak berubah** — tetap dipakai murni buat walk-in customer default, orthogonal dari masalah duplikasi di atas.
5. `create_pos_sale` disederhanakan — tetap orkestrasi `create_goods_issue`+`record_payment` (signature level function sama persis), tapi hapus SEMUA insert ke 3 tabel yang di-drop.
6. `create_goods_issue` — body terima `unit_price` opsional per baris di `p_lines` (jsonb shape nambah 1 key, param level function gak berubah), tulis ke kolom baru poin 3.
7. **RPC baru** buat pembatalan (nama diusulkan tetap `void_pos_transaction`, TAPI SENGAJA TIDAK generik — cuma buat kasus "invoice + persis 1 `goods_issues` + persis 1 `payments` yang melunasi penuh, gak ada retur/DP nempel"): cari goods_issue lewat `goods_issues.invoice_id = p_transaction_id`, cari payment lewat `payments.transaction_id = p_transaction_id` — FK yang **SUDAH ADA** sekarang, gak butuh tabel penanda apa pun (beda dari `void_pos_transaction` versi `0076`/`0077` yang masih baca lewat `pos_sales`). Reverse 3 jurnal (payment, goods_issue, transaction) + balikin stok (`inventory_balances` + compensating `inventory_movements`), mekanisme sama versi lama. Kalau kriteria gak match, `raise exception` suruh pakai `cancel_ar_invoice` biasa.
8. Halaman ERP `/pos-sales` (list) **tetap ada**, tapi query-nya diganti jadi filter struktural langsung ke `transactions` (punya `goods_issues` + persis 1 `payments` yang melunasi penuh) — bukan join ke tabel penanda lagi.
9. Frontend:
   - `apps/pos/src/app/page.tsx` — `fetchRecentSales` baca item dari `goods_issues`→`goods_issue_lines`+`items`, kategori tambahan/PPN dari `transaction_lines` langsung (gantiin query ke `pos_sale_lines`/`pos_sale_extra_credit_lines`). `checkout()`/pemanggilan RPC gak berubah — cart udah kirim `unit_price` per baris.
   - `apps/erp/src/lib/pos-sales/*` + `page.tsx` + `[id]/view.tsx` — disesuaikan ke query struktural poin 8, tab item/kategori-tambahan baca `goods_issue_lines`/`transaction_lines` (pola sama `ar-invoices/[id]/view.tsx`), tombol "Batalkan" panggil RPC poin 7.

Diskusi terkait yang MUNCUL dari sini tapi scope-nya lebih besar (mekanisme reverse generik buat SEMUA jenis transaksi, bukan cuma POS) dicatat terpisah di `memory/scope-debt/generic-transaction-reversal.md`.

## Referensi

- `supabase/migrations/0076_pos_unify_transactions.sql`, `0077_pos_permanently_delete_legacy_data.sql` — bentuk `pos_sales`/`pos_sale_lines`/`pos_sale_extra_credit_lines` yang mau disederhanakan lebih lanjut di sini.
- `memory/architecture/data/pos-schema.md` — schema doc (perlu diupdate menyeluruh begitu rencana ini dieksekusi, saat ini masih mendeskripsikan bentuk pra-`0076`).
- `memory/scope-debt/pos-unify-transactions.md` — histori keputusan unifikasi sebelumnya (closed, tapi konteksnya relevan).
- `apps/erp/src/app/(app)/ar-invoices/[id]/view.tsx` — pola pembanding cara baca item+harga dari `goods_issue_lines`+`order_lines.unit_price`.
- `memory/scope-debt/generic-transaction-reversal.md` — ide lanjutan yang muncul dari diskusi ini.
