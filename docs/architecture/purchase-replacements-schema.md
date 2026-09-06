# Retur Barang ke Supplier (Opsi B — Tukar Barang) — Struktur Data

Konsep bisnisnya ada di `docs/domain/accounts-payable.md` bagian "Retur Barang ke Supplier" — salah satu dari 2 resolusi retur ke supplier: bahan baku yang diterima ternyata rusak, dan supplier setuju mengirim barang pengganti (bukan mengurangi utang). File ini fokus ke bagaimana datanya disimpan dan aturan apa yang dijaga otomatis oleh sistem. Detail teknis (SQL, nama fungsi persis) ada di `memory/architecture/data/purchase-replacements-schema.md`. Ini sisi AP — mirror sisi AR-nya ada di `warranty-replacements-schema.md` (dua-duanya tabel fisik terpisah). Resolusi retur satunya lagi (Opsi A — kurangi utang) ada di `credit-notes-schema.md`.

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `purchase_replacements` | Header 1 kejadian penukaran barang ke supplier | `transactions` (bill), `journal_entries` |
| `purchase_replacement_lines` | Rincian barang & qty yang ditukar per kejadian | `purchase_replacements`, `items` |

## Konsep Inti

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `purchase_replacements` | 1 baris = 1 kejadian penukaran barang ke supplier | `transactions.id` (bill), `journal_entries.id` |
| `purchase_replacement_lines` | Barang & qty yang ditukar di 1 kejadian | `purchase_replacements`, `items` |

**Struktur (kolom yang penting buat dipahami)**

| Kolom | Isinya | Catatan |
|---|---|---|
| `bill_id` | Bill asal barang yang cacat | Rujukan utama — Opsi B berdiri sendiri, **gak pernah** menunjuk ke `credit_notes` sama sekali (beda dari sisi AR yang masih punya kolom histori) |
| `journal_entry_id` | Jurnal Debit Persediaan (barang baru) / Kredit Persediaan (barang rusak) | Akun yang sama dipakai di 2 baris, net nol — murni reklasifikasi fisik demi jejak audit, bukan mengakui untung/rugi |
| `qty_replaced`, `total_cost` (di `_lines`) | Qty barang ditukar & nilai costingnya | Dihitung dari harga rata-rata berjalan (Weighted Average) saat kejadian, bukan harga saat barang diterima |

**Kenapa Berdiri Sendiri (Independen dari Retur)**

Opsi B **berlaku sama persis di semua status bayar bill** — Utang Usaha gak pernah kesentuh, mau bill-nya lunas, sebagian, atau belum dibayar. Opsi B gak menempel ke retur yang sudah tercatat — kalau menempel tanpa penyeimbang, supplier bisa jadi memberi 2 kompensasi sekaligus (kurangi utang DAN kirim barang pengganti) untuk 1 kejadian rusak yang sama, makanya desainnya berdiri sendiri sejak awal (sejalan dengan pola yang sama di sisi AR, lihat `warranty-replacements-schema.md`).

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Catat penukaran barang ke supplier | `create_purchase_replacement` | Konsumsi barang rusak (Weighted Average) lalu "terima" barang baru dengan `avg_cost` yang identik — karena unit cost sama persis, rata-rata berjalan otomatis balik ke nilai semula (net nol, konsisten sama klaim dokumentasi bisnis) | Trigger `purchase_replacement_lines_no_over_return_trigger` mencegah qty ditukar melebihi sisa yang belum "diklaim" |
| Cek sisa qty yang masih bisa diklaim (Opsi A + Opsi B gabungan) | Fungsi bantu `purchase_returned_qty(bill_id, item_id)` | Menjumlah qty yang sudah diklaim lewat retur (Opsi A, `purchase_return_lines`) DAN ganti barang (Opsi B, `purchase_replacement_lines`), dibandingkan ke qty yang benar-benar diterima (`goods_receipt_lines`) | Dipakai 2 trigger insert (retur & ganti barang), bukan dipanggil user langsung |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Opsi A dan Opsi B saling eksklusif per porsi barang — 1 unit barang cuma bisa diklaim lewat salah satu, gak boleh jalan bareng untuk porsi yang sama | Fungsi `purchase_returned_qty` menjumlah klaim dari 2 tabel sekaligus (Opsi A + Opsi B), dipakai kedua trigger insert |
| Total qty yang diklaim lewat Opsi A + Opsi B, buat 1 item di 1 bill, gak boleh melebihi qty yang benar-benar diterima | Trigger `purchase_replacement_lines_no_over_return_trigger` (dan pasangannya di sisi retur), dibandingkan ke `goods_receipt_lines.qty_received` |
| Utang Usaha gak pernah tersentuh oleh Opsi B, di status bayar bill apa pun | RPC `create_purchase_replacement` cuma bikin 1 jurnal (Persediaan/Persediaan), gak pernah menyentuh akun utang |
| Porsi berbeda dalam 1 bill yang sama boleh pakai opsi berbeda (campuran) | Guard qty di level fisik per item (bukan per-mekanisme atau per-bill), jadi Opsi A dan B bisa hidup berdampingan selama total gabungannya masih di bawah qty diterima |
| Barang rusak yang supplier tolak kompensasi sama sekali ditangani lewat Stock Opname generic, bukan mekanisme retur/tukar barang khusus | Tidak ada tabel/RPC khusus untuk jalur ini — lihat `stock-opname-schema.md` |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `purchase_replacements.bill_id` | banyak-ke-satu | `transactions` (bill) |
| `purchase_replacements.journal_entry_id` | banyak-ke-satu | `journal_entries` |
| `purchase_replacement_lines.purchase_replacement_id` | banyak-ke-satu | `purchase_replacements` |
| `purchase_replacement_lines.item_id` | banyak-ke-satu | `items` |
| `purchase_replacement_lines` (via `purchase_returned_qty`) | dibandingkan dengan | `purchase_return_lines` (Opsi A, lihat `credit-notes-schema.md`) dan `goods_receipt_lines` (lihat `goods-receipt-schema.md`) |

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat daftar penukaran barang ke supplier | Semua user yang sudah login |
| Mencatat penukaran barang baru | Role `admin` atau `accountant` |
| Mengubah/menghapus penukaran barang yang sudah tercatat | **Tidak ada seorang pun** — immutable, kalau salah input dikoreksi lewat kejadian baru, bukan mengedit yang lama |
