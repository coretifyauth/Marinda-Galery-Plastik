# Inventory & COGS — AI Context

Inventory melacak barang fisik (qty + harga per satuan) dari diterima → diproses jadi barang jadi → terjual, supaya HPP (Harga Pokok Penjualan / COGS) bisa dihitung akurat. **Prinsip inti: membeli bahan baku BUKAN biaya** — itu tukar aset (Kas/Utang → Persediaan). HPP baru diakui pas barang jadi **terjual** (matching principle), gak peduli kapan utang ke supplier dibayar.

## Alur Nilai

```
Beli bahan baku (aset naik) → Produksi (pindah aset: Bahan Baku → Barang Jadi) → Terjual (HPP muncul, dicocokkan ke Pendapatan)
```

Cuma tahap terakhir yang menyentuh Laporan Laba Rugi.

## Metode Costing (per item, ditentukan di master data item)

- **FIFO** — tracking per-batch (lot). Tiap penerimaan = 1 lot baru (qty + unit_cost + tanggal terima). Konsumsi ambil dari lot **terlama dulu** sampai habis, baru lanjut ke lot berikutnya (bisa span multi-lot). Butuh struktur data berlapis (banyak baris aktif per item).
- **Weighted Average** — 1 angka rata-rata berjalan per item, dihitung ulang **tiap ada penerimaan baru**: `new_avg = (qty_before × avg_before + qty_in × unit_cost_in) / (qty_before + qty_in)`. Konsumsi cuma kurangin qty, avg_cost gak berubah sampai penerimaan berikutnya. Cukup 1 baris per item, di-update terus (bukan derived dari agregat — beda dari pola "status derived" di modul lain, karena rata-rata berjalan gak bisa dihitung ulang dari SUM sederhana).

### Lot: masuk vs keluar

Konsep "lot" FIFO punya 2 sisi yang gampang keketuker karena sama-sama bisa dipicu oleh produksi:

- **Lot lahir (masuk)** — tiap kali qty suatu item bertambah, dari pembelian (bahan baku diterima) ATAU dari hasil produksi (barang jadi dihasilkan). Ini "kelahiran" batch baru.
- **Lot dikonsumsi (keluar)** — tiap kali qty suatu lot berkurang, dipakai sebagai input produksi (bahan baku) ATAU keluar karena terjual (barang jadi). Ini "pemakaian" dari batch yang sudah ada.

Satu production order menyentuh **dua-duanya sekaligus** dari arah berlawanan: bahan baku **keluar** (dikonsumsi sebagai input), barang jadi **masuk** (lahir sebagai lot baru hasil output) — makanya kata "produksi" muncul di kedua sisi tapi maknanya kebalikan, tergantung item mana yang dimaksud (bahan baku vs barang jadi).

## BOM (Bill of Materials) & Production Order

Resep: 1 finished item ← beberapa raw material item + qty per batch. Production Order = kejadian produksi beneran: konsumsi bahan baku (sesuai resep × jumlah batch, dihitung pakai metode costing masing-masing bahan), hasilkan barang jadi senilai total biaya bahan yang dikonsumsi. **Masih tukar aset ke aset** (Persediaan Bahan Baku → Persediaan Barang Jadi) — bukan HPP. Scope saat ini: biaya produksi cuma dari bahan baku, belum termasuk tenaga kerja/overhead.

## Purchase Order & 3-Way Matching

- **Purchase Order (PO)** — komitmen pesan ke supplier (item, qty, harga disepakati). **Gak bikin jurnal** — belum kejadian akuntansi.
- **Goods Receipt Note (GRN)** — bukti terima fisik (qty & harga riil, bisa beda dari PO). Dicocokkan ke `purchase_order_lines` (qty diterima gak boleh melebihi qty dipesan). GRN inilah yang nambah Persediaan (bikin lot FIFO / update avg cost).
- **Bill (AP)** — tagihan dari supplier. Di desain ini, GRN & Bill dibuat **bersamaan** (asumsi proses pembelian informal, nota = bukti kirim + tagihan sekaligus) — menghindari kompleksitas akun perantara "Barang Diterima Belum Ditagih" yang dibutuhkan kalau GRN dan Bill terjadi di waktu berbeda.

## Goods Issue (sisi keluar — penjualan)

Barang jadi keluar gudang karena terjual → dua jurnal bersamaan:
```
Debit Piutang/Kas [harga jual]     | Kredit Pendapatan [harga jual]
Debit HPP [biaya pokok]            | Kredit Persediaan Barang Jadi [biaya pokok]
```
Biaya pokok dihitung dari metode costing item itu (FIFO: consume lot terlama; Weighted Average: qty × avg_cost saat itu).

## Constraints (wajib ditegakkan di implementasi)

- Pembelian bahan baku selalu ke Persediaan (aset), gak pernah langsung Beban.
- Metode costing tetap/konsisten per item, gak boleh gonta-ganti tanpa revaluasi formal.
- FIFO wajib consume lot terlama dulu (urut `received_at`).
- Konsumsi/pengurangan qty gak boleh melebihi yang tersedia (anti over-consumption, pola sama anti-over-allocation AR/AP).
- Goods Receipt gak boleh melebihi qty yang dipesan di PO line-nya (anti over-receipt, pola sama).
- Semua pergerakan stok tertelusur ke dokumen sumber (PO+Bill buat masuk, Invoice buat keluar, BOM buat produksi).

## Common mistakes to guard against

- Mencatat pembelian bahan baku sebagai Beban/HPP langsung.
- HPP dihitung dari kapan utang dibayar (harusnya dari kapan barang terjual).
- FIFO consume lot salah urutan.
- PO dianggap bikin jurnal (harusnya GRN+Bill yang bikin).
- Produksi dianggap HPP (masih tukar aset, HPP baru pas barang jadi terjual).

## Belum termasuk (di luar scope fase ini)

Detail: `docs/scope-debt/` — akun perantara "Barang Diterima Belum Ditagih" (kalau GRN & Bill perlu terpisah waktu), Sales Order (mirror PO di sisi jual, 3-way matching cuma di procurement), laporan price variance (PO vs GRN beda harga), tenaga kerja/overhead dalam biaya produksi.

## Glossary

- **Item**: master data barang (raw material atau finished good), punya metode costing sendiri.
- **Lot**: 1 batch barang (khusus item FIFO) yang "lahir" — bisa dari penerimaan pembelian atau dari hasil produksi — punya qty & harga sendiri, immutable setelah dibuat.
- **Konsumsi (Lot Consumption)**: kebalikan Lot — pencatatan qty yang "keluar"/dipakai dari sebuah lot, entah buat input produksi atau karena terjual.
- **BOM (Bill of Materials)**: resep — daftar bahan baku & qty yang dibutuhkan buat 1 batch produksi.
- **Purchase Order (PO)**: pesanan ke supplier, belum kejadian akuntansi.
- **Goods Receipt Note (GRN)**: bukti penerimaan fisik barang, dasar penambahan Persediaan.
- **Goods Issue**: bukti pengeluaran fisik barang jadi karena terjual, dasar pengakuan HPP.
- **HPP / COGS**: Harga Pokok Penjualan — biaya pokok barang yang terjual, diakui bersamaan dengan pendapatannya.

Naratif lengkap + reasoning penuh: `docs/domain/human/inventory.md`.
