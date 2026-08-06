# Penghapusan Metode Costing FIFO dari Sistem

**Modul asal:** Lintas modul (Inventory Fase 5, berdampak ke AR Fase 3 & AP Fase 4). **Status:** Ditunda.

## Kasus

Sistem saat ini mendukung 2 metode costing per item (`items.costing_method`: `FIFO` atau `WEIGHTED_AVERAGE`), dengan `inventory_lots`+`inventory_lot_consumptions` (tracking per-lot, cuma dipakai FIFO) dan `inventory_balances` (1 angka rata-rata per item, cuma dipakai Weighted Average) hidup berdampingan. Rencana ke depan: **FIFO mau dihapus dari sistem**, cuma Weighted Average yang dipertahankan. Ketauan/diputuskan saat diskusi desain fitur AP Retur Barang (2026-08-06) — user eksplisit bilang "soon" (belum sekarang), minta dicatat dulu biar gak ilang dari radar.

## Kenapa ditunda

Ini keputusan arsitektur besar yang butuh migration terpisah + rencana migrasi data, bukan sesuatu yang bisa nempel di fitur AP Retur Barang yang lagi dibangun. Kalau nanti dikerjakan, dampaknya nyebar ke banyak tempat — bukan cuma hapus 1 kolom:

- `items.costing_method` check constraint (drop value `FIFO`, atau drop kolom itu sendiri kalau cuma 1 metode tersisa).
- Migrasi data: item existing yang `costing_method = 'FIFO'` harus dipindah ke `WEIGHTED_AVERAGE` — butuh keputusan gimana konversi cost dari lot-lot FIFO yang ada jadi 1 angka `avg_cost` gabungan.
- Tabel `inventory_lots`+`inventory_lot_consumptions` (kalau FIFO satu-satunya pemakai konsep "lot") kemungkinan jadi gak terpakai — perlu diputuskan dihapus atau dibiarkan kosong (histori).
- Fungsi `consume_fifo` (helper generik dipakai `create_production_order` dan `create_goods_issue`) — tiap pemanggil yang branch `if costing_method = 'FIFO' ... else ...` perlu disederhanakan jadi cuma jalur Weighted Average.
- `create_ar_credit_note` (retur AR, jalur full) — saat ini insert lot baru `source_type = SALES_RETURN` kalau item FIFO, atau update `inventory_balances` kalau Weighted Average. Cabang FIFO-nya perlu dihapus.
- **Fitur AP Retur Barang** (migration `0035_ap_credit_notes_schema.sql`, dibangun berbarengan dengan keputusan ini) — sengaja diasumsikan cuma perlu nanganin Weighted Average dulu, gak dibikin mekanisme "konsumsi tertarget ke lot spesifik" buat FIFO karena bakal dibuang gak lama lagi. Begitu FIFO beneran dihapus, gak ada dampak balik ke AP Retur Barang (memang dari awal gak nyentuh FIFO).

## Referensi

- `memory/architecture/data/inventory-schema.md` bagian "Entity — Costing Mechanism" (`items.costing_method`, `inventory_lots`, `consume_fifo`/`consume_weighted_average`).
- `memory/architecture/data/ar-schema.md` bagian "AR Credit Note" (cabang FIFO di retur full).
- `memory/domain/accounts-payable.md` / `memory/architecture/data/ap-schema.md` (AP Retur Barang, sengaja asumsi Weighted-Average-only sampai FIFO dihapus).
