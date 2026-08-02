# Inventory — Struktur Data

Fase 5. Konsep bisnisnya ada di `docs/domain/inventory.md`. Skenario nyata: `docs/story/inventory.md`. Detail teknis: `memory/architecture/data/inventory-schema.md`. Modul ini paling banyak tabelnya karena mencakup 3 alur sekaligus: beli bahan baku (procurement), produksi (mengubah bahan baku jadi barang jadi), dan jual (goods issue).

## Peta Data (ERD)

```mermaid
erDiagram
  ITEMS ||--o| INVENTORY_BALANCES : "khusus item Rata-Rata Bergerak"
  ITEMS ||--o{ INVENTORY_LOTS : "khusus item FIFO"
  ITEMS ||--o{ PURCHASE_ORDER_LINES : dipesan
  ITEMS ||--o{ GOODS_RECEIPT_LINES : diterima
  ITEMS ||--o{ BOM_LINES : "jadi bahan resep"
  ITEMS ||--o| BOM_HEADERS : "jadi hasil resep"
  ITEMS ||--o{ PRODUCTION_ORDER_LINES : dikonsumsi
  ITEMS ||--o{ GOODS_ISSUE_LINES : keluar

  SUPPLIERS ||--o{ PURCHASE_ORDERS : ""

  PURCHASE_ORDERS ||--|{ PURCHASE_ORDER_LINES : ""
  PURCHASE_ORDERS ||--o{ GOODS_RECEIPT_NOTES : ""
  PURCHASE_ORDER_LINES ||--o{ GOODS_RECEIPT_LINES : "dicocokkan ke"

  AP_BILLS ||--|| GOODS_RECEIPT_NOTES : "dibuat bersamaan"
  GOODS_RECEIPT_NOTES ||--|{ GOODS_RECEIPT_LINES : ""

  INVENTORY_LOTS ||--o{ INVENTORY_LOT_CONSUMPTIONS : ""

  BOM_HEADERS ||--|{ BOM_LINES : ""
  BOM_HEADERS ||--o{ PRODUCTION_ORDERS : ""
  PRODUCTION_ORDERS ||--|{ PRODUCTION_ORDER_LINES : ""

  AR_INVOICES ||--|| GOODS_ISSUES : "dibuat bersamaan"
  GOODS_ISSUES ||--|{ GOODS_ISSUE_LINES : ""
```

## Tabel Master Data

| Tabel | Fungsi |
|---|---|
| `items` | Daftar barang yang dilacak — bisa bahan baku atau barang jadi. Tiap barang punya metode hitung biaya sendiri: **FIFO** (masuk duluan, keluar duluan) atau **Rata-Rata Bergerak** — boleh beda-beda per barang dalam sistem yang sama. |
| `bom_headers` + `bom_lines` | Resep produksi: 1 barang jadi butuh bahan baku apa saja, berapa takarannya per 1 batch. Boleh direvisi kapan saja — resep yang direvisi tidak mengubah histori produksi yang sudah terjadi, karena tiap produksi menyimpan salinan angkanya sendiri. |

## Alur Pembelian: Purchase Order → Penerimaan Barang + Bill

| Tabel | Fungsi |
|---|---|
| `purchase_orders` + baris pesanan | Komitmen pesan ke pemasok. Belum ada transaksi jurnal — ini baru rencana, belum ada pertukaran aset. |
| `goods_receipt_notes` + baris penerimaan | Bukti barang benar-benar diterima. **Dibuat bersamaan dengan bill (tagihan) pemasok** — dalam sistem ini, nota penerimaan barang dianggap sama waktunya dengan tagihan resmi, jadi tidak perlu akun perantara "barang diterima belum ditagih". |

Penerimaan barang inilah yang **memicu** penambahan stok — begitu baris penerimaan dicatat, sistem otomatis menambah stok lewat salah satu dari dua mekanisme di bawah, tergantung metode costing barangnya.

**Pengaman otomatis:** sistem menolak penerimaan yang jumlahnya melebihi sisa yang masih dipesan di Purchase Order — mencegah salah input jumlah terima yang tidak sesuai pesanan.

## Dua Cara Sistem Melacak Nilai Stok

Ini bagian yang paling gampang bikin bingung, jadi penting dipahami dulu sebelum baca detail tabel:

| Metode | Cara kerja | Tabel yang dipakai |
|---|---|---|
| **FIFO** (masuk duluan, keluar duluan) | Setiap penerimaan barang dicatat sebagai "lapisan" (lot) terpisah dengan harganya masing-masing. Saat barang keluar, sistem mengambil dari lapisan tertua dulu. | `inventory_lots` (lapisan yang masuk) + `inventory_lot_consumptions` (pemakaian dari lapisan) |
| **Rata-Rata Bergerak** | Sistem menyimpan satu angka "harga rata-rata berjalan" per barang, yang diperbarui setiap ada penerimaan baru. Saat barang keluar, harga rata-rata ini yang dipakai, dan tidak berubah karena pemakaian (hanya berubah karena penerimaan baru). | `inventory_balances` (saldo & harga rata-rata saat ini) |

Satu barang cuma pakai salah satu metode, ditentukan sejak barang itu didaftarkan.

**Kenapa nama tabelnya mirip-mirip:** `inventory_lots` mencatat stok yang **masuk** (lahir), `inventory_lot_consumptions` mencatat stok yang **keluar** (dipakai/terjual). Keduanya bisa sama-sama berasal dari kejadian "produksi" — supaya tidak rancu, sistem membedakan dengan jelas:

| Kejadian | Tabel yang tersentuh | Artinya |
|---|---|---|
| Bahan baku diterima dari pemasok | `inventory_lots` | Lapisan baru **lahir** dari pembelian |
| Barang jadi selesai diproduksi | `inventory_lots` | Lapisan baru **lahir** dari hasil produksi |
| Bahan baku dipakai untuk produksi | `inventory_lot_consumptions` | Stok **berkurang** karena jadi bahan produksi |
| Barang jadi terjual | `inventory_lot_consumptions` | Stok **berkurang** karena terjual |

**Pengaman otomatis:** sistem menolak pemakaian stok dari satu lapisan yang melebihi jumlah yang tersedia di lapisan itu.

## Alur Produksi

| Tabel | Fungsi |
|---|---|
| `production_orders` + baris konsumsi | Satu kejadian produksi nyata: mengonsumsi bahan baku sesuai resep, menghasilkan barang jadi. Setiap baris menyimpan salinan angka bahan baku & biaya yang benar-benar dipakai saat itu (bukan mengacu ulang ke resep, supaya resep boleh direvisi tanpa mengubah histori). |

Setiap produksi otomatis membuat transaksi jurnal: Debit Persediaan Barang Jadi, Kredit Persediaan Bahan Baku, sebesar total biaya bahan baku yang dikonsumsi (dihitung dari FIFO atau Rata-Rata Bergerak, tergantung metode masing-masing bahan).

## Alur Penjualan: Goods Issue → HPP

| Tabel | Fungsi |
|---|---|
| `goods_issues` + baris keluar | Kebalikan dari penerimaan barang — barang jadi keluar karena terjual. **Dibuat bersamaan dengan invoice penjualan.** |

Setiap penjualan barang jadi menghasilkan **dua** transaksi jurnal sekaligus: satu untuk pendapatan (Debit Piutang, Kredit Pendapatan — dari modul Piutang Usaha), dan satu lagi khusus untuk mengakui Harga Pokok Penjualan (Debit HPP, Kredit Persediaan Barang Jadi) sebesar biaya barang yang keluar. Titik inilah HPP benar-benar diakui sebagai beban.

## Aturan Otomatis yang Dijaga Sistem (ringkasan)

1. Penerimaan barang tidak boleh melebihi jumlah yang dipesan di Purchase Order.
2. Pemakaian stok dari satu lapisan (lot) tidak boleh melebihi jumlah yang tersedia di lapisan itu.
3. Purchase Order, penerimaan barang, produksi, dan penjualan barang tidak pernah bisa diedit atau dihapus setelah tercatat — koreksi harus lewat pencatatan baru.
4. Data master (daftar barang, resep) tetap boleh diubah kapan saja — hanya catatan transaksi yang bersifat permanen.

## Cara Kerja Tiap Aksi

Empat aksi utama di modul ini, dan apa yang sistem lakukan otomatis di baliknya tiap kali aksi itu dijalankan:

- **Buat Purchase Order** — cuma menyimpan rencana pesanan (barang, jumlah, harga perkiraan). Tidak ada dampak keuangan atau stok sama sekali di langkah ini — ini baru komitmen, belum ada barang atau uang yang benar-benar berpindah.

- **Catat Penerimaan Barang** — satu aksi ini otomatis melakukan beberapa hal sekaligus, semua-atau-tidak-sama-sekali:
  1. Membuat tagihan pemasok (bill) yang sepadan.
  2. Mencatat transaksi jurnal Debit Persediaan, Kredit Utang Usaha.
  3. Menambah stok barang — sebagai lapisan baru (kalau barangnya FIFO) atau memperbarui harga rata-rata berjalan (kalau Rata-Rata Bergerak).
  4. Mengecek jumlah yang diterima tidak melebihi sisa pesanan di Purchase Order (lihat "Aturan Otomatis" #1).

- **Jalankan Produksi** — satu aksi ini otomatis:
  1. Mengambil resep (BOM) dan menghitung total bahan baku yang perlu dikonsumsi sesuai jumlah yang mau diproduksi.
  2. Mengurangi stok tiap bahan baku — mengambil dari lapisan tertua dulu (kalau FIFO) atau dari saldo rata-rata (kalau Rata-Rata Bergerak) — sekaligus mengecek stoknya cukup (lihat "Aturan Otomatis" #2).
  3. Menambah stok barang jadi sebagai hasil produksi.
  4. Mencatat transaksi jurnal Debit Persediaan Barang Jadi, Kredit Persediaan Bahan Baku sebesar total biaya bahan baku yang dikonsumsi.

- **Catat Penjualan (Goods Issue)** — dibuat bersamaan dengan invoice penjualan, satu aksi ini otomatis:
  1. Menerbitkan invoice (Debit Piutang, Kredit Pendapatan).
  2. Mengurangi stok barang jadi yang terjual — sekaligus mengecek stoknya cukup.
  3. Mencatat transaksi jurnal kedua khusus untuk mengakui HPP (Debit HPP, Kredit Persediaan Barang Jadi) — titik ini HPP benar-benar diakui sebagai beban.

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat semua data (barang, resep, pesanan, penerimaan, produksi, penjualan) | Semua user yang sudah login |
| Mengubah data barang & resep | Role `admin` atau `accountant` |
| Membuat Purchase Order, mencatat penerimaan, mencatat produksi, mencatat penjualan | Role `admin` atau `accountant` |
| Mengedit/menghapus transaksi yang sudah tercatat | **Tidak ada seorang pun** |

## Belum Termasuk

- **Akun perantara "barang diterima belum ditagih"** — dibutuhkan kalau nanti barang bisa datang lebih dulu sebelum tagihan resminya datang (saat ini keduanya selalu dicatat bersamaan).
- **Sales Order** — pencocokan tiga arah (pesanan-penerimaan-tagihan) di sisi jual, cerminan dari Purchase Order di sisi beli. Saat ini pencocokan tiga arah baru ada di sisi pembelian.
- **Laporan selisih harga pembelian** — laporan pembanding antara harga di Purchase Order vs harga aktual saat diterima.
- **Biaya tenaga kerja & overhead pabrik dalam produksi** — saat ini biaya produksi hanya menghitung bahan baku, belum termasuk komponen biaya lain.
