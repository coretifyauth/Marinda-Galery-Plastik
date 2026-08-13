# Story — Inventory & HPP: Toko Plastik Makmur Jaya

Konteks bisnis: `docs/story/company-profile.md`. Konsep: `docs/domain/inventory.md`. ERD & DDL: `memory/architecture/data/inventory-schema.md` (**costing Weighted Average doang — FIFO sudah dihapus total**, migration `0038_remove_fifo_costing.sql`). Aturan UI: `memory/preferences/ui/admin-shell-design.md` (list cuma klik-baris, semua aksi transaksional hidup di halaman detail `[id]`).

Beda dari versi lama file ini: sekarang ditulis sebagai **tutorial klik-per-klik di browser beneran** — tiap langkah nyebut menu sidebar mana, buka URL apa, isi field apa, klik tombol apa, dan apa yang harus muncul. Login dulu sebagai Pak Herman (`admin`) sebelum mulai — role `cashier` (Mbak Rina) gak punya akses ke `apps/erp` sama sekali, cuma ke kios POS.

Timeline cerita: **Agustus–September 2026** (persis sekitar "hari ini", 11 Agustus 2026, di dunia nyata sesi ini — dipilih sengaja biar kerasa "baru terjadi").

**Peta menu.** Sidebar kiri, grup **Inventory** (ikon `Boxes`, klik label buat expand kalau collapsed): `Items`, `Stock Position`, `Purchase Orders`, `Goods Receipts`, `BOM`, `Production Orders`, `Sales Orders`, `Goods Issues`, `Stock Opname`. Semua di bawah ini urut sesuai alur bisnis, bukan urutan sidebar.

**Catatan desain penting (kenapa item dikelompokkan gini):** `items.item_type` cuma 2 pilihan — `RAW_MATERIAL` (muncul di dropdown Purchase Order & jadi komponen BOM) dan `FINISHED_GOOD` (muncul di dropdown Sales Order & Goods Issue, jadi output BOM). Ini desain lama warisan skenario pabrik roti (beli bahan mentah → olah → jual barang jadi). Karena itu, semua barang plastik yang **dibeli dari supplier apa adanya** (Ember, Kursi, Rak, Piring, Gelas, Sendok-Garpu, Toples) diklasifikasikan `RAW_MATERIAL` — biar bisa muncul di form Purchase Order. Yang beneran **dirakit** (Paket Alat Makan, lewat BOM+Production Order) satu-satunya `FINISHED_GOOD` — makanya cuma Paket Alat Makan yang bisa dijual lewat Sales Order/Goods Issue di walkthrough ini. Penjualan langsung Ember/Piring/dkk ke pelanggan grosir (di luar bundling) dicatat lewat AR Invoice financial-only (lihat `docs/story/accounts-receivable.md`), bukan lewat modul ini.

## Item Master Data (target akhir setelah Tahap 1)

| Item | Tipe | Satuan Dasar | Akun Persediaan | Supplier |
|---|---|---|---|---|
| Ember Plastik 10L | RAW_MATERIAL | pcs | 1400 Persediaan Bahan Baku | PT Plastindo Jaya |
| Kursi Plastik Lipat | RAW_MATERIAL | pcs | 1400 Persediaan Bahan Baku | PT Plastindo Jaya |
| Rak Plastik Serbaguna | RAW_MATERIAL | pcs | 1400 Persediaan Bahan Baku | PT Plastindo Jaya |
| Piring Plastik | RAW_MATERIAL | pcs | 1400 Persediaan Bahan Baku | CV Sumber Plastik |
| Gelas Plastik | RAW_MATERIAL | pcs | 1400 Persediaan Bahan Baku | CV Sumber Plastik |
| Sendok-Garpu Plastik | RAW_MATERIAL | pack (isi 12) | 1400 Persediaan Bahan Baku | CV Sumber Plastik |
| Toples Plastik | RAW_MATERIAL | pcs | 1400 Persediaan Bahan Baku | CV Sumber Plastik |
| **Paket Alat Makan** | **FINISHED_GOOD** | pcs | 1420 Persediaan Barang Jadi | — (dirakit, BOM) |

Semua Weighted Average — gak ada pilihan metode lain di form.

## Tahap 1 — Bikin Item Master + Satuan Jual (Items)

**Menu:** Inventory → **Items** (`/items`). Halaman ini sekarang punya 3 tab: **Items**, **Kategori**, **Brand**.

**Kategori & Brand dulu (opsional, tapi lebih enak diisi sebelum bikin item).** Klik tab **Kategori** → **+ New** → isi **Nama Kategori** `Alat Makan` → **Simpan Kategori**. Ulangi buat kategori `Perlengkapan Rumah Tangga`. Pindah ke tab **Brand** → **+ New** → isi **Nama Brand** `Lion Star` → **Simpan Brand**, ulangi buat `Maspion`. Klik baris kategori/brand mana pun di tabelnya → masuk `/item-categories/[id]` atau `/item-brands/[id]`, nunjukin daftar barang yang tergolong ke situ (masih kosong sampai Tahap 1 lanjut isi item).

Balik ke tab **Items**, klik **+ New** di pojok kanan atas toolbar tabel → form "Tambah Item" muncul di bawah tabel. Isi (untuk **Ember Plastik 10L**):
- **Nama**: `Ember Plastik 10L`
- **Tipe**: pilih `RAW_MATERIAL` (dropdown cuma `RAW_MATERIAL`/`FINISHED_GOOD`)
- **Satuan Dasar (UOM)**: `pcs` (atau `pack` khusus Sendok-Garpu Plastik)
- **Kategori (opsional)**: `Perlengkapan Rumah Tangga`
- **Brand (opsional)**: `Lion Star`
- **Akun Persediaan**: pilih `1400 — Persediaan Bahan Baku` dari dropdown akun leaf

Klik **Simpan Item**. Baris baru langsung muncul di tabel list (kolom Nama/Tipe/Satuan Dasar/Satuan Jual/Kategori/Brand/Akun Persediaan). Ulangi buat ketujuh item RAW_MATERIAL (Piring Plastik & Gelas Plastik dikategorikan `Alat Makan`, brand `Maspion` — sisanya boleh dibiarkan tanpa kategori/brand), lalu sekali lagi buat **Paket Alat Makan** dengan Tipe `FINISHED_GOOD`, UOM `pcs`, Akun Persediaan `1420 — Persediaan Barang Jadi`.

**Lupa isi Kategori/Brand pas create, atau salah tipe/satuan dasar?** Klik baris item di tabel → masuk `/items/[id]` → tombol **Edit** di pojok kanan atas header. Form yang sama (Nama/Tipe/UOM/Kategori/Brand/Akun Persediaan) muncul, bisa diubah kapan saja — sebelumnya field-field ini cuma bisa diisi sekali pas create, sekarang bisa diedit belakangan.

**Satuan jual & harga (multi-unit) — di halaman detail item, bukan di form create.** Klik baris **Ember Plastik 10L** di tabel (row-nya clickable, bukan tombol) → masuk `/items/[id]`. Di section "Satuan Jual & Harga", klik **+ Tambah Satuan**:
- Baris pertama dipaksa jadi satuan dasar: field **Nama Satuan** & **Faktor Konversi** otomatis terkunci ke `pcs`/`1` (gak bisa diedit) — cuma **Harga (opsional)** yang bisa diisi. Kosongkan (Ember gak dijual per pcs langsung di walkthrough ini) → klik **Simpan Satuan**.
- Klik **+ Tambah Satuan** lagi buat baris kedua: **Nama Satuan** = `lusin`, **Faktor Konversi (ke pcs)** = `12`, **Harga (opsional)** = `200000`. Klik **Simpan Satuan** → tabel Satuan Jual & Harga sekarang punya 2 baris: `pcs (dasar)` dan `lusin — faktor 12 — harga 200.000`.

Ulangi pola yang sama (base + 1-2 satuan tambahan) buat **Piring Plastik** (base `pcs`, + `lusin` faktor 12 harga 18.000, + `pack` faktor 6 harga 10.000) dan **Gelas Plastik** (base `pcs`, + `lusin` faktor 12 harga 14.000, + `pack` faktor 6 harga 8.000) — sekadar demo CRUD `item_units`, gak dipakai transaksi di walkthrough ini karena keduanya `RAW_MATERIAL` (gak muncul di dropdown Goods Issue).

Untuk **Paket Alat Makan** (dipakai transaksi Goods Issue nanti, jadi satuannya penting): base `pcs` harga `6000`, tambah satuan `paket besar` faktor `5` harga `28000` ("paket besar isi 5" — buat pesanan acara/grosir, harga per unitnya didiskon dari 5×6.000=30.000 jadi 28.000).

Kursi Plastik Lipat, Rak Plastik Serbaguna, Sendok-Garpu Plastik, Toples Plastik: **gak perlu** ditambah satuan jual (dijual/dipakai langsung di satuan dasarnya, atau gak pernah keluar lewat modul ini).

**Kode Scan (barcode/QR) — opsional per satuan jual.** Tabel Satuan Jual & Harga sekarang punya kolom tambahan **Kode Scan** per baris. Baris yang dibiarkan kosong tetap bisa dijual manual dari katalog kios (`apps/pos`) seperti biasa — gak wajib diisi:
- Di baris **Piring Plastik — pack (faktor 6, harga 10.000)**, klik **Buat Kode** → sistem generate `SKU-2026-00001` langsung tersimpan di baris itu (gak ada barcode dari CV Sumber Plastik buat kemasan pack ini — format sama kayak nomor dokumen lain di sistem ini, mis. `ARI-2026-00001`). Klik **Cetak Label** di sebelahnya → tab baru muncul otomatis buka dialog print browser, isinya QR + nama barang "Piring Plastik" + teks "pack — Rp10.000" di bawah QR, siap ditempel ke kemasan pack begitu selesai print.
- Baris **pcs** dan **lusin** Piring Plastik dibiarkan kosong (gak dikasih kode) — kedua satuan itu tetap dijual manual dari katalog seperti sebelumnya, jarang discan.
- Di baris **Ember Plastik 10L — lusin (faktor 12, harga 200.000)**, sama — PT Plastindo Jaya gak nyertain barcode pabrik di kardus ember, klik **Buat Kode** → `SKU-2026-00002`, cetak & tempel ke kardus.

Di halaman detail item juga keliatan **Qty On Hand** & **Avg Cost** (dari `inventory_balances`) — masih 0 buat semua item karena belum ada penerimaan barang.

## Tahap 2 — Purchase Order ke PT Plastindo Jaya (3 Agustus 2026)

**Menu:** Inventory → **Purchase Orders** (`/purchase-orders`). Klik **+ New**.

- **Supplier**: `PT Plastindo Jaya`
- **Tanggal PO**: `2026-08-03`
- **Estimasi Tiba**: `2026-08-05`
- **Rujukan dokumen (source_ref)**: `PO-PLASTINDO-014`
- Baris item (klik **+ Tambah item** buat nambah baris):
  1. Ember Plastik 10L — Qty Pesan `40` — Harga/Unit `18000`
  2. Kursi Plastik Lipat — Qty Pesan `10` — Harga/Unit `45000`
  3. Rak Plastik Serbaguna — Qty Pesan `8` — Harga/Unit `60000`

Klik **Simpan PO**. Baris baru muncul di list dengan badge status **OPEN** (abu-abu). Klik baris itu → masuk `/purchase-orders/[id]`, keliatan detail: tanggal, rujukan, tabel "Item Dipesan" (Qty Pesan vs Qty Diterima — masih 0 — vs Harga/Unit), dan section "Goods Receipts" (masih kosong). **Belum ada jurnal apa pun** — PO cuma komitmen.

## Tahap 3 — Terima Barang + Bikin Bill (Goods Receipt, 5 Agustus 2026)

**Menu:** Inventory → **Goods Receipts** (`/goods-receipts`). Klik **+ New**.

- **Purchase Order**: pilih `PO-PLASTINDO-014 — PT Plastindo Jaya` → begitu dipilih, baris "Item (sisa PO)" otomatis muncul, qty & harga ter-prefill dari PO
- **Tanggal Terima**: `2026-08-05`
- **No. Surat Jalan**: `SJ-PLASTINDO-014`
- **Rujukan Bill (source_ref)**: `GRN-PLASTINDO-014`
- **Deskripsi Bill**: `Terima ember/kursi/rak dari PT Plastindo Jaya`
- **Akun Persediaan (debit)**: `1400 — Persediaan Bahan Baku`
- **Akun Utang Usaha (kredit)**: `2100 — Utang Usaha`
- Baris qty terima & harga riil dibiarkan sama persis dengan PO (gak ada selisih kali ini)

Klik **Simpan Penerimaan**. List Goods Receipts nambah 1 baris (Supplier, PO, Tanggal, Items Diterima, Bill, Jumlah `1.650.000`). Klik baris → `/goods-receipts/[id]`: detail terima + "Bill" (`GRN-PLASTINDO-014` — `1.650.000`) + section "Jurnal Terkait":
```
Debit  1400 Persediaan Bahan Baku   1.650.000
Kredit 2100 Utang Usaha                        1.650.000
```
Balik ke `/purchase-orders/[id]` PO ini → status sekarang **FULLY_RECEIVED**, Qty Diterima = Qty Pesan tiap baris.

`inventory_balances` sekarang: Ember 0→**40 @ 18.000**, Kursi 0→**10 @ 45.000**, Rak 0→**8 @ 60.000** (avg_cost = harga beli pertama, penerimaan pertama tiap item).

## Tahap 4 — Ember Datang Lagi, Harga Naik (WA Recalculation, PO 12 Agustus → GRN 15 Agustus 2026)

Distributor plastik dunia naikin harga. PO baru (`PO-PLASTINDO-015`, 12 Agustus): Ember Plastik 10L qty `40` @ harapan `18000` (sama seperti sebelumnya). GRN (`GRN-PLASTINDO-015`, 15 Agustus): qty diterima tetap 40 (gak ada masalah kuantitas), tapi **Harga Riil/Unit diisi manual jadi `20000`** — beda dari harga PO, sistem gak menolak (price variance cuma informasional, cuma qty yang dijaga ketat terhadap sisa PO).

`inventory_balances` Ember dihitung ulang: `(40×18.000 + 40×20.000) ÷ 80 = 1.520.000 ÷ 80 = Rp19.000/pcs`. qty_on_hand jadi **80**. AP bill baru: `800.000` (40×20.000).

Buka `/items/[id]` Ember Plastik 10L lagi → **Qty On Hand 80 pcs**, **Avg Cost / pcs 19.000** — 1 angka gabungan, gak ada jejak "yang mana dari batch mana" (Weighted Average, bukan FIFO).

## Tahap 5 — Purchase Order + Goods Receipt ke CV Sumber Plastik (6–8 Agustus 2026)

Beli komponen buat Paket Alat Makan + Toples (rawan pecah, dipakai nanti buat opname).

**PO** (`/purchase-orders`, source_ref `PO-SUMBERPLASTIK-021`, tanggal `2026-08-06`, supplier `CV Sumber Plastik`):
1. Piring Plastik — Qty `60` — Harga `1500`
2. Gelas Plastik — Qty `60` — Harga `1200`
3. Sendok-Garpu Plastik — Qty `5` — Harga `15000`
4. Toples Plastik — Qty `30` — Harga `8000`

**GRN** (`/goods-receipts`, 8 Agustus, delivery note `SJ-SUMBERPLASTIK-021`, bill ref `GRN-SUMBERPLASTIK-021`, akun sama seperti Tahap 3): qty diterima persis sesuai PO, gak ada selisih. AP bill: `60×1.500 + 60×1.200 + 5×15.000 + 30×8.000 = 90.000+72.000+75.000+240.000 = Rp477.000`.

`inventory_balances`: Piring 0→**60 @ 1.500**, Gelas 0→**60 @ 1.200**, Sendok-Garpu 0→**5 pack @ 15.000**, Toples 0→**30 @ 8.000**.

## Tahap 6 — Stock Position (Kartu Stok Semua Item, read-only)

**Menu:** Inventory → **Stock Position** (`/inventory`). Halaman read-only, murni derived dari `inventory_balances` — gak ada form apa pun, cuma tombol **Refresh**. Tampil tabel: Item, Avg Cost, Qty Tersisa, Nilai Persediaan, plus **Grand Total** nilai seluruh persediaan di bawah tabel. Pak Herman cek sekilas di sini tiap mau lapor ke bank buat pengajuan modal tambahan (`docs/story/company-profile.md`) — gak perlu buka tiap item satu-satu.

## Tahap 7 — Bikin Resep Paket Alat Makan (BOM)

**Menu:** Inventory → **BOM** (`/bom`). Klik **+ New**.

- **Barang Jadi**: `Paket Alat Makan (pcs)` — satu-satunya opsi karena dropdown ini cuma nampilin item `FINISHED_GOOD`
- **Output per Batch**: `12`
- Baris Bahan Baku (klik **+ Tambah bahan baku**):
  1. Piring Plastik — Qty/Batch `12`
  2. Gelas Plastik — Qty/Batch `12`
  3. Sendok-Garpu Plastik — Qty/Batch `1` (1 pack isi 12 pas buat 12 paket)

Klik **Simpan Resep**. List BOM nambah 1 baris: `Paket Alat Makan — 12 pcs/batch — [3 bahan baku] — Aktif`. Klik baris → `/bom/[id]`: detail resep + tabel bahan baku. Resep ini **mutable** (bisa dibikin baru/revisi kapan saja) — production order snapshot qty & biaya aktualnya sendiri, gak look-up ulang ke sini di kemudian hari.

## Tahap 8 — Jalankan Produksi #1 (Production Order, 20 Agustus 2026)

**Menu:** Inventory → **Production Orders** (`/production-orders`). Klik **+ New**.

- **Resep (BOM)**: `Paket Alat Makan (12 pcs/batch)`
- **Qty Diproduksi**: `12` (1 batch persis)
- **Tanggal Produksi**: `2026-08-20`
- **Rujukan dokumen**: `PROD-PAKET-001`
- **Akun Persediaan Barang Jadi (debit)**: `1420 — Persediaan Barang Jadi`
- **Akun Persediaan Bahan Baku (kredit)**: `1400 — Persediaan Bahan Baku`

Klik **Jalankan Produksi**. Bahan baku dikonsumsi otomatis sesuai resep — gak diinput manual. Klik baris hasil di list → `/production-orders/[id]`: tabel "Konsumsi Bahan Baku" (Piring 12 pcs = 18.000, Gelas 12 pcs = 14.400, Sendok-Garpu 1 pack = 15.000, **Total Biaya 47.400**) + "Jurnal Terkait":
```
Debit  1420 Persediaan Barang Jadi    47.400
Kredit 1400 Persediaan Bahan Baku              47.400
```
Masih **bukan HPP** — baru tukar bentuk aset (bahan baku → barang jadi), belum terjual. `inventory_balances` Paket Alat Makan: 0→**12 pcs @ avg Rp3.950** (47.400÷12). Sisa bahan baku: Piring 48, Gelas 48, Sendok-Garpu 4 pack.

## Tahap 9 — Sales Order Toko Serba Ada Barokah (Pesanan Acara, Stok Belum Cukup, 22 Agustus 2026)

Toko Serba Ada Barokah (pelanggan grosir volume besar) mau 30 Paket Alat Makan buat acara — tapi stok gudang cuma 12 (posisi Tahap 8). **Menu:** Inventory → **Sales Orders** (`/sales-orders`). Klik **+ New**.

- **Customer**: `Toko Serba Ada Barokah`
- **Tanggal Pesan**: `2026-08-22`
- **Butuh Tanggal**: `2026-08-30`
- **Rujukan dokumen**: `SO-BAROKAH-005`
- Baris: Paket Alat Makan — Qty Pesan `30` — Harga/Unit `6000`

Klik **Simpan Sales Order**. List nambah baris dengan badge **OPEN**. **Gak ada jurnal apa pun di titik ini** (halaman ini eksplisit bilang itu di atas form) — piutang & pendapatan baru diakui pas barang beneran dikirim lewat Goods Issue.

## Tahap 10 — Produksi Tambahan (Production Order #2, 24 Agustus 2026)

Sama pola Tahap 8: **Resep** `Paket Alat Makan`, **Qty Diproduksi** `24` (2 batch, pas habisin sisa 48 piring/48 gelas/4 pack sendok-garpu), **Tanggal Produksi** `2026-08-24`, **Rujukan** `PROD-PAKET-002`. Klik **Jalankan Produksi**.

Biaya batch ini sama per-unit (harga komponen gak berubah): 24×3.950=94.800. `inventory_balances` Paket Alat Makan: `(12×3.950 + 24×3.950) ÷ 36 = Rp3.950/pcs` (avg gak berubah karena harga komponen konsisten), qty_on_hand → **36 pcs**.

## Tahap 11 — Kirim Bertahap ke Toko Serba Ada Barokah (Fulfillment dari Detail SO, 26 & 29 Agustus 2026)

Buka `/sales-orders/[id]` punya SO-BAROKAH-005 (klik baris di list Sales Orders). Karena status belum `FULLY_FULFILLED`, ada tombol **Kirim / Penuhi** di pojok kanan atas — **ini aksi transaksional, hidup di halaman detail, bukan di row list** (`memory/preferences/ui/admin-shell-design.md`).

**Pengiriman 1 (26 Agustus, 18 pcs):** klik **Kirim / Penuhi** → form muncul, baris "Item (sisa SO)" ter-prefill qty sisa (`30`). Isi:
- **Tanggal Kirim/Invoice**: `2026-08-26`
- **Rujukan dokumen**: `Nota kirim tahap 1`
- **Deskripsi**: `Kirim tahap 1 dari SO Barokah`
- **Akun Piutang Usaha (debit)**: `1300 — Piutang Usaha`
- **Akun Pendapatan (kredit)**: `4200 — Pendapatan Penjualan Grosir`
- **Akun HPP (debit, jurnal kedua)**: `5100 — Harga Pokok Penjualan`
- **Akun Persediaan Barang Jadi (kredit, jurnal kedua)**: `1420 — Persediaan Barang Jadi`
- Ubah **Qty Kirim** baris Paket Alat Makan dari `30` jadi `18`. "Nilai invoice" otomatis update jadi `108.000` (18×6.000).

Klik **Kirim & Terbitkan Invoice**. Trigger `goods_issue_lines_no_over_issue` cek 18 ≤ 30, lolos. Section "Pengiriman (Goods Issue + Invoice)" di halaman SO nambah 1 baris, badge status SO jadi **PARTIALLY_FULFILLED** (18/30 terkirim).

Jurnal (2 sekaligus):
```
Debit  1300 Piutang Usaha              108.000
Kredit 4200 Pendapatan Penjualan Grosir          108.000

Debit  5100 Harga Pokok Penjualan       71.100   (18 × 3.950)
Kredit 1420 Persediaan Barang Jadi                71.100
```

**Pengiriman 2 (29 Agustus, 12 pcs sisa):** klik **Kirim / Penuhi** lagi (baris sisa sekarang `12`). **Tanggal**: `2026-08-29`, **Rujukan**: `Nota kirim tahap 2`, akun-akun sama. Qty Kirim `12` (sisa penuh). Klik **Kirim & Terbitkan Invoice** → invoice KEDUA terbit terpisah:
```
Debit  1300 Piutang Usaha               72.000   (12 × 6.000)
Kredit 4200 Pendapatan Penjualan Grosir           72.000

Debit  5100 Harga Pokok Penjualan       47.400   (12 × 3.950)
Kredit 1420 Persediaan Barang Jadi                47.400
```
Total terkirim 18+12=30 = qty_ordered → status SO jadi **FULLY_FULFILLED**, tombol "Kirim / Penuhi" hilang dari halaman detail (gak ada sisa buat dikirim). Klik salah satu baris di "Pengiriman" → lompat ke `/goods-issues/[id]` invoice itu, keliatan detail lengkap + jurnal HPP.

`inventory_balances` Paket Alat Makan: 36→**6 pcs** (avg tetap 3.950, konsumsi gak ngubah rata-rata).

## Tahap 12 — Penjualan Langsung ke Warung Bu Siti (Goods Issue Tanpa SO, Multi-Unit + Saran Harga, 2 September 2026)

Warung Bu Siti (grosir kecil) datang langsung minta 1 paket besar (isi 5) — barang ready, gak perlu lewat Sales Order. **Menu:** Inventory → **Goods Issues** (`/goods-issues`). Klik **+ New**.

- **Customer**: `Warung Bu Siti`
- **Tanggal**: `2026-09-02`
- **Rujukan dokumen**: `Nota grosir #101`
- **Deskripsi**: `Jual Paket Alat Makan ke Warung Bu Siti`
- Baris "Barang Jadi Keluar": **Item** = `Paket Alat Makan (pcs)`, **Satuan Jual** = `paket besar (@28.000)`, **Qty** = `1`
- Klik tombol **Saran** di sebelah field "Jumlah Pendapatan" → otomatis keisi `28000` (qty 1 × harga satuan `paket besar`). Field ini tetap bisa diedit manual kalau harga disepakati beda.
- **Akun Piutang Usaha (debit)**: `1300 — Piutang Usaha`
- **Akun Pendapatan (kredit)**: `4200 — Pendapatan Penjualan Grosir`
- **Akun HPP (debit, jurnal kedua)**: `5100 — Harga Pokok Penjualan`
- **Akun Persediaan Barang Jadi (kredit, jurnal kedua)**: `1420 — Persediaan Barang Jadi`
- **Kategori Pendapatan Tambahan (opsional)**: dipakai kalau ada biaya tambahan yang mau ditagih terpisah (mis. "Jasa Antar") — kategorinya harus sudah didaftarkan lebih dulu di Settings → Kategori & Pajak (`/settings/charges`); di transaksi ini dikosongkan.
- **Checkbox PPN Keluaran**: cuma muncul kalau `tax_settings.is_active = true` (diaktifkan admin di Settings → Kategori & Pajak). Kalau aktif dan dicentang, PPN dihitung otomatis dari subtotal saat submit — di transaksi ini dibiarkan gak dicentang.

Klik **Simpan Penjualan**. Konversi qty satuan jual → satuan dasar terjadi **di browser sebelum RPC dipanggil**: 1 paket besar × faktor 5 = **5 pcs** yang dikirim ke `create_goods_issue` (RPC tetap terima qty di satuan dasar, gak pernah lihat "1 paket besar").

`total_cost` dihitung dari `avg_cost` berlaku, bukan diketik manual: 5 pcs × Rp3.950 = **Rp19.750**.

Jurnal:
```
Debit  1300 Piutang Usaha              28.000
Kredit 4200 Pendapatan Penjualan Grosir          28.000

Debit  5100 Harga Pokok Penjualan       19.750
Kredit 1420 Persediaan Barang Jadi                19.750
```
**Laba kotor: Rp28.000 − Rp19.750 = Rp8.250.** Kalau dijual lepasan 5×Rp6.000=Rp30.000, marginnya lebih besar — tapi itu konsekuensi diskon grosir per-satuan yang disengaja (harga `paket besar` independen, bukan hasil kali otomatis dari harga `pcs`).

Klik baris di list Goods Issues → `/goods-issues/[id]`: detail invoice terkait, total HPP, tabel "Barang Keluar" (qty dalam **satuan dasar**, `5 pcs`), dan "Jurnal HPP Terkait".

`inventory_balances` Paket Alat Makan: 6→**1 pcs** (avg tetap 3.950).

## Tahap 13 — Stock Opname (Hitung Fisik Bulanan, 10 September 2026)

Akhir bulan, Pak Herman hitung fisik gudang dan bandingin ke catatan sistem. **Menu:** Inventory → **Stock Opname** (`/stock-opnames`). Klik **+ New**.

| Item | Qty Sistem | Hasil Hitung Fisik | Selisih | Sebab (narasi) |
|---|---|---|---|---|
| Ember Plastik 10L | 80 | 76 | −4 | Susut/kemungkinan hilang, gak ketauan sebabnya persis |
| Toples Plastik | 30 | 26 | −4 | Pecah di gudang (rawan pecah) |
| Kursi Plastik Lipat | 10 | 11 | +1 | Ada unit lama yang kelewat dicatat masuk |

Isi form:
- **Tanggal Opname**: `2026-09-10`
- **Rujukan dokumen (nomor berita acara opname)**: `Opname-2026-09`
- **Akun Beban Selisih Persediaan (selisih kurang)**: `6000 — Beban Selisih Persediaan`
- **Akun Pendapatan Selisih Persediaan (selisih lebih)**: `4400 — Pendapatan Selisih Persediaan`
- 3 baris (klik **+ Tambah item** buat tiap baris): pilih item di dropdown → kolom "Qty Sistem" otomatis nampilin qty berjalan (read-only, dari `inventory_balances`) → isi "Qty Hasil Hitung": Ember `76`, Toples `26`, Kursi `11`.

Klik **Simpan Opname**. RPC `record_stock_opname` bikin **3 jurnal terpisah per baris** (BUKAN di-netting jadi 1 angka):
```
Ember (kurang):  Debit 6000 Beban Selisih Persediaan   76.000   / Kredit 1400 Persediaan Bahan Baku   76.000  (4 × 19.000)
Toples (kurang): Debit 6000 Beban Selisih Persediaan   32.000   / Kredit 1400 Persediaan Bahan Baku   32.000  (4 × 8.000)
Kursi (lebih):   Debit 1400 Persediaan Bahan Baku       45.000   / Kredit 4400 Pendapatan Selisih Persediaan 45.000 (1 × 45.000)
```
Klik baris sesi opname di list → `/stock-opnames/[id]`: header nunjukin total "Beban Selisih (kurang)" `108.000` dan "Pendapatan Selisih (lebih)" `45.000` terpisah (bukan net Rp63.000), tabel per-item + "Jurnal Terkait" (3 baris jurnal).

`inventory_balances` disesuaikan langsung ke hasil fisik (avg_cost gak berubah): Ember 80→**76**, Toples 30→**26**, Kursi 10→**11**.

## Posisi Akhir per 10 September 2026

| Item | Qty | Avg Cost | Nilai Persediaan |
|---|---|---|---|
| Ember Plastik 10L | 76 pcs | 19.000 | 1.444.000 |
| Kursi Plastik Lipat | 11 pcs | 45.000 | 495.000 |
| Rak Plastik Serbaguna | 8 pcs | 60.000 | 480.000 |
| Piring Plastik | 48 pcs | 1.500 | 72.000 |
| Gelas Plastik | 48 pcs | 1.200 | 57.600 |
| Sendok-Garpu Plastik | 4 pack | 15.000 | 60.000 |
| Toples Plastik | 26 pcs | 8.000 | 208.000 |
| Paket Alat Makan | 1 pcs | 3.950 | 3.950 |

Total Persediaan ≈ **Rp2.820.550** — cek angka ini di `/inventory` (Stock Position, Grand Total di bawah tabel), muncul di Neraca. HPP bulan berjalan (Rp71.100 + Rp47.400 + Rp19.750 = Rp138.250) + Beban/Pendapatan Selisih Persediaan (Rp108.000 / Rp45.000) muncul di Laporan Laba Rugi.

## Lanjutan Story

Fase berikutnya (`docs/story/fixed-assets.md`) menyusutkan Mobil Pickup Antar Barang & Rak Display Toko — biaya penyusutan itu jadi komponen biaya operasional di Laporan Laba Rugi, melengkapi gambaran biaya Toko Plastik Makmur Jaya di luar HPP yang sudah dihitung di sini.
