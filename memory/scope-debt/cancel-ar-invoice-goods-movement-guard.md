# Guard goods-movement & retur di cancel_ar_invoice

**Modul asal:** Accounts Receivable / Transactions spine. **Status:** Ditunda.

## Kasus

Invoice AR yang berasal dari Goods Issue nyata (barang fisik sudah keluar ke customer, `inventory_movements`/`inventory_balances` sudah berkurang lewat `create_goods_issue`) masih bisa dibatalkan langsung lewat `cancel_ar_invoice` tanpa penolakan apa pun selain cek jumlah payment. Begitu dibatalkan, jurnal pembalik menghapus efek Dr HPP/Cr Persediaan dari GL, tapi pengurangan stok fisiknya TETAP ada — hasil akhirnya sama seperti bug AP yang baru diperbaiki di `cancel_ap_bill`, cuma arah kebalikannya: buku bilang "belum ada penjualan ini", tapi stok gudang sudah berkurang seolah barangnya beneran keluar.

`cancel_ar_invoice` juga TIDAK punya guard jumlah retur sama sekali (`cancel_ap_bill` sudah punya ini sejak awal) — jadi invoice yang sudah ada retur pun masih lolos dibatalkan lewat jalur ini, harusnya ditolak dan diarahkan ke jalur retur yang sudah ada.

`void_pos_transaction` (`0024_pos_schema.sql`) AMAN dari bug ini — sudah benar membalik goods issue + restock inventory, tapi cuma berlaku untuk pola POS ketat (persis 1 goods issue + 1 payment lunas penuh + 0 retur/DP) dan secara eksplisit mengarahkan transaksi di luar pola itu ke `cancel_ar_invoice`. Artinya invoice non-POS (mis. dari Sales Order → Goods Issue manual) tetap kena bug ini.

Referensi kode: `supabase/migrations/0015_transactions_schema.sql` baris 241-269 (`cancel_ar_invoice`) dibanding `cancel_ap_bill` di file yang sama (sudah termasuk guard goods-receipt).

## Kenapa ditunda

Ditemukan (2026-09-13) sebagai efek samping saat mengimplementasikan guard analog di `cancel_ap_bill` (dipicu laporan bug spesifik sisi AP). User cuma minta perbaikan sisi AP dulu — perbaikan sisi AR ini butuh keputusan/konfirmasi terpisah sebelum digarap (pola perbaikannya identik: tambah guard `goods_notes(type='OUTBOUND')` + guard jumlah retur ke `cancel_ar_invoice`, mengikuti pola persis yang sudah ada di `cancel_ap_bill`).

## Referensi

- `docs/architecture/transactions-schema.md` — baris "Batalkan piutang yang salah input" (RPC `cancel_ar_invoice`).
- `supabase/migrations/0015_transactions_schema.sql` — `cancel_ap_bill` di file yang sama, pola fix yang sudah diterapkan di sisi AP, jadi acuan kalau ini digarap.
