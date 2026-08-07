# Inventory & COGS — AI Context

Inventory melacak barang fisik (qty + harga per satuan) dari diterima → diproses jadi barang jadi → terjual, supaya HPP (Harga Pokok Penjualan / COGS) bisa dihitung akurat. **Prinsip inti: membeli bahan baku BUKAN biaya** — itu tukar aset (Kas/Utang → Persediaan). HPP baru diakui pas barang jadi **terjual** (matching principle), gak peduli kapan utang ke supplier dibayar.

## Alur Nilai

```
Beli bahan baku (aset naik) → Produksi (pindah aset: Bahan Baku → Barang Jadi) → Terjual (HPP muncul, dicocokkan ke Pendapatan)
```

Cuma tahap terakhir yang menyentuh Laporan Laba Rugi.

## Metode Costing: Weighted Average (satu-satunya, berlaku semua item)

- **Weighted Average** — 1 angka rata-rata berjalan per item, dihitung ulang **tiap ada penerimaan baru**: `new_avg = (qty_before × avg_before + qty_in × unit_cost_in) / (qty_before + qty_in)`. Konsumsi cuma kurangin qty, avg_cost gak berubah sampai penerimaan berikutnya. Cukup 1 baris per item, di-update terus (bukan derived dari agregat — beda dari pola "status derived" di modul lain, karena rata-rata berjalan gak bisa dihitung ulang dari SUM sederhana).
- **FIFO sudah dihapus total dari sistem** (migration `0038_remove_fifo_costing.sql`). Dulu ada 2 metode, ditentukan per item (misal Tepung Terigu FIFO karena harganya sering naik-turun dan presisi per-batch penting, Gula Pasir Weighted Average). Sekarang Weighted Average dipakai semua item, termasuk yang harganya fluktuatif — rata-rata berjalan tetap merefleksikan perubahan harga (naik/turun langsung kebawa ke `avg_cost` pas penerimaan baru), cuma gak sepresisi FIFO di level per-batch. Trade-off yang diterima sengaja: struktur data lebih sederhana (1 baris per item, bukan berlapis-lapis lot), cukup buat skala bisnis ini.

## BOM (Bill of Materials) & Production Order

Resep: 1 finished item ← beberapa raw material item + qty per batch. Production Order = kejadian produksi beneran: konsumsi bahan baku (sesuai resep × jumlah batch, dihitung pakai metode costing masing-masing bahan), hasilkan barang jadi senilai total biaya bahan yang dikonsumsi. **Masih tukar aset ke aset** (Persediaan Bahan Baku → Persediaan Barang Jadi) — bukan HPP. Scope saat ini: biaya produksi cuma dari bahan baku, belum termasuk tenaga kerja/overhead.

## Purchase Order & 3-Way Matching

- **Purchase Order (PO)** — komitmen pesan ke supplier (item, qty, harga disepakati). **Gak bikin jurnal** — belum kejadian akuntansi.
- **Goods Receipt Note (GRN)** — bukti terima fisik (qty & harga riil, bisa beda dari PO). Dicocokkan ke `purchase_order_lines` (qty diterima gak boleh melebihi qty dipesan). GRN inilah yang nambah Persediaan (update avg cost).
- **Bill (AP)** — tagihan dari supplier. Di desain ini, GRN & Bill dibuat **bersamaan** (asumsi proses pembelian informal, nota = bukti kirim + tagihan sekaligus) — menghindari kompleksitas akun perantara "Barang Diterima Belum Ditagih" yang dibutuhkan kalau GRN dan Bill terjadi di waktu berbeda.

## Goods Issue (sisi keluar — penjualan)

Barang jadi keluar gudang karena terjual → dua jurnal bersamaan:
```
Debit Piutang/Kas [harga jual]     | Kredit Pendapatan [harga jual]
Debit HPP [biaya pokok]            | Kredit Persediaan Barang Jadi [biaya pokok]
```
Biaya pokok dihitung dari Weighted Average (qty × avg_cost saat itu).

## Constraints (wajib ditegakkan di implementasi)

- Pembelian bahan baku selalu ke Persediaan (aset), gak pernah langsung Beban.
- Konsumsi/pengurangan qty gak boleh melebihi yang tersedia (anti over-consumption, pola sama anti-over-allocation AR/AP).
- Goods Receipt gak boleh melebihi qty yang dipesan di PO line-nya (anti over-receipt, pola sama).
- Semua pergerakan stok tertelusur ke dokumen sumber (PO+Bill buat masuk, Invoice buat keluar, BOM buat produksi).

## Common mistakes to guard against

- Mencatat pembelian bahan baku sebagai Beban/HPP langsung.
- HPP dihitung dari kapan utang dibayar (harusnya dari kapan barang terjual).
- PO dianggap bikin jurnal (harusnya GRN+Bill yang bikin).
- Produksi dianggap HPP (masih tukar aset, HPP baru pas barang jadi terjual).

## Belum termasuk (di luar scope fase ini)

Detail: `memory/scope-debt/` — akun perantara "Barang Diterima Belum Ditagih" (kalau GRN & Bill perlu terpisah waktu), Sales Order (mirror PO di sisi jual, 3-way matching cuma di procurement), laporan price variance (PO vs GRN beda harga), tenaga kerja/overhead dalam biaya produksi.

`items.return_window_days` (nullable) — batas hari maksimal item itu boleh diretur sejak invoice, dipakai AR Credit Note (`memory/domain/accounts-receivable.md` bagian "Retur Barang"). Ditaro di sini (bukan di `customers`) karena soal umur simpan fisik barang.

## Glossary

- **Item**: master data barang (raw material atau finished good), costing-nya Weighted Average.
- **BOM (Bill of Materials)**: resep — daftar bahan baku & qty yang dibutuhkan buat 1 batch produksi.
- **Purchase Order (PO)**: pesanan ke supplier, belum kejadian akuntansi.
- **Goods Receipt Note (GRN)**: bukti penerimaan fisik barang, dasar penambahan Persediaan.
- **Goods Issue**: bukti pengeluaran fisik barang jadi karena terjual, dasar pengakuan HPP.
- **HPP / COGS**: Harga Pokok Penjualan — biaya pokok barang yang terjual, diakui bersamaan dengan pendapatannya.

Naratif lengkap + reasoning penuh: `docs/domain/inventory.md`.
