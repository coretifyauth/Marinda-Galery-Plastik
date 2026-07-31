# Story — Inventory & HPP: CV Roti Barokah

Fase 5. Konteks bisnis: `docs/story/company-profile.md` (poin 5: "hitung HPP roti, butuh FIFO/weighted average karena harga tepung naik-turun"). Konsep: `docs/domain/human/inventory.md`. ERD & DDL: `docs/architecture/data/inventory-schema.md`. Lanjutan langsung dari `docs/story/accounts-payable.md` — bahan baku yang sudah dicatat di sana (dari Toko Tepung Makmur & Toko Gula Sejahtera) sekarang ditelusuri lebih detail: qty & harga per kg, diolah jadi roti, sampai akhirnya kejual dan HPP-nya kehitung.

Timeline cerita ini: **Agustus 2026** (bulan setelah AR/AP per 30 Juli 2026).

## Item Master Data

| Item | Tipe | Satuan | Metode Costing | Akun Persediaan |
|---|---|---|---|---|
| Tepung Terigu | Bahan Baku | kg | **FIFO** — harganya sering naik-turun, presisi per-batch penting | Persediaan Bahan Baku |
| Gula Pasir | Bahan Baku | kg | **Weighted Average** — harga relatif stabil, cukup rata-rata | Persediaan Bahan Baku |
| Roti Tawar | Barang Jadi | buah | FIFO (mengikuti hasil produksi, per-batch) | Persediaan Barang Jadi |

## Resep (BOM)

**1 batch Roti Tawar = 5kg Tepung Terigu + 1kg Gula Pasir → menghasilkan 50 buah roti.**

## Tahap 1 — Pesan tepung (PO, 1 Agustus 2026)

Bu Nur pesan ke Toko Tepung Makmur: 50kg Tepung Terigu, harga disepakati Rp10.000/kg.

`purchase_orders`: supplier = Toko Tepung Makmur, po_date = 1 Agustus. `purchase_order_lines`: qty_ordered = 50kg, unit_cost_expected = Rp10.000.

**Belum ada jurnal** — baru komitmen.

## Tahap 2 — Tepung datang + nota (GRN+Bill, 5 Agustus 2026)

Barang datang persis sesuai pesanan: 50kg @ Rp10.000.

`goods_receipt_notes` (nunjuk PO tahap 1) + `goods_receipt_lines` (qty_received = 50kg, unit_cost = Rp10.000, cocok PO — gak ada selisih) → `ap_bills` (amount Rp500.000, due_date = 5 Agustus + 14 hari = **19 Agustus**, **tabel yang sudah ada, gak berubah**) → `inventory_lots` **Lot #1**: Tepung Terigu, qty_in 50kg, unit_cost Rp10.000.

Jurnal (via `create_ap_bill` yang sudah ada):
```
Debit  Persediaan Bahan Baku    500.000
Kredit Utang Usaha                        500.000
```

## Tahap 3 — Pesan & terima gula (PO 3 Agustus → GRN+Bill 8 Agustus 2026)

Bu Nur pesan ke Toko Gula Sejahtera: 20kg Gula Pasir @ Rp13.000, datang 8 Agustus persis sesuai pesanan.

`inventory_balances` (Gula Pasir): qty_on_hand 0 → **20kg**, avg_cost = **Rp13.000** (penerimaan pertama). `ap_bills`: amount Rp260.000, due_date = 8 Agustus + 7 hari = **15 Agustus**.

Jurnal: `Debit Persediaan Bahan Baku 260.000 / Kredit Utang Usaha 260.000`

## Tahap 4 — Pesan tepung lagi, harga naik (PO 10 Agustus → GRN+Bill 15 Agustus 2026)

Bu Nur pesan lagi 50kg tepung, harapan harga sama (Rp10.000). Pas datang 15 Agustus, **harga naik jadi Rp11.000/kg** — dicatat apa adanya, gak diblokir (price variance informasional, cuma qty yang dijaga ketat terhadap PO).

`goods_receipt_lines`: qty 50kg, unit_cost Rp11.000 (beda dari PO Rp10.000). `inventory_lots` **Lot #2**: Tepung Terigu, qty_in 50kg, unit_cost Rp11.000. `ap_bills`: amount Rp550.000, due_date = **29 Agustus**.

Kartu stok Tepung Terigu sekarang: Lot #1 (50kg @ 10.000, belum kepakai) + Lot #2 (50kg @ 11.000, belum kepakai).

## Tahap 5 — Gula datang lagi, harga turun (GRN+Bill, 20 Agustus 2026)

20kg gula lagi, kali ini harga turun jadi Rp12.000/kg.

`inventory_balances` (Gula Pasir): rata-rata dihitung ulang — (20kg×13.000 + 20kg×12.000) ÷ 40kg = 500.000 ÷ 40 = **Rp12.500/kg**. qty_on_hand jadi **40kg**.

## Tahap 6 — Produksi 1 batch roti (Production Order, 22 Agustus 2026)

Jalankan resep: pakai 5kg tepung + 1kg gula → hasil 50 buah Roti Tawar.

`production_orders`: bom = Roti Tawar, qty_produced = 50 buah. `production_order_lines`: Tepung 5kg, Gula 1kg. `inventory_lot_consumptions`: ambil 5kg dari **Lot #1** (FIFO — yang lama duluan) @ Rp10.000 = Rp50.000 (`consumption_type = PRODUCTION_INPUT`), sisa Lot #1 = 45kg. `inventory_balances` (Gula): konsumsi 1kg @ avg Rp12.500 = Rp12.500, sisa 39kg — Weighted Average gak butuh baris `inventory_lot_consumptions`, cukup update langsung `qty_on_hand`-nya.

Total biaya produksi = Rp50.000 (tepung) + Rp12.500 (gula) = **Rp62.500** untuk 50 buah roti → **biaya per roti = Rp1.250**.

Jurnal:
```
Debit  Persediaan Barang Jadi (Roti Tawar)   62.500
Kredit Persediaan Bahan Baku                          62.500
```
Masih **bukan HPP** — roti belum terjual, baru pindah bentuk dari bahan mentah jadi barang jadi.

**Output produksi ini sendiri jadi 1 lot baru** (Roti Tawar dikonfigurasi FIFO — lihat tabel item di atas): `inventory_lots` **Lot #P1**: item = Roti Tawar, `source_type = PRODUCTION_OUTPUT` (beda dari Lot #1/#2 Tepung Terigu yang `source_type = PURCHASE_RECEIPT`, tapi struktur tabelnya sama persis), `source_ref` = production order ini, qty_in = 50 buah, unit_cost = Rp1.250. Ini yang bakal jadi sumber HPP pas rotinya kejual — mekanisme FIFO-nya generik, gak peduli lot itu asalnya dari beli bahan baku atau dari hasil produksi.

Perhatikan: production order Tahap 6 ini menyentuh **2 arah sekaligus** — Tepung Terigu **keluar** (`PRODUCTION_INPUT` di `inventory_lot_consumptions`) sementara Roti Tawar **masuk** (`PRODUCTION_OUTPUT` di `inventory_lots`). Dua kejadian berlawanan arah, dipicu 1 production order yang sama.

## Tahap 7 — Roti terjual ke Warung Pak Budi (Goods Issue + Invoice, 25 Agustus 2026)

Jual 30 dari 50 buah roti, harga Rp2.000/buah = **Rp60.000 pendapatan**. Biaya pokok 30 buah = 30 × Rp1.250 = **Rp37.500**.

`goods_issues` (nunjuk `ar_invoices` yang dibuat bersamaan) + `goods_issue_lines`: 30 buah Roti Tawar. `total_cost`-nya **bukan angka manual** — dihitung dari lookup FIFO ke lot Roti Tawar yang tersedia: `inventory_lot_consumptions` ambil 30 buah dari **Lot #P1** (satu-satunya lot Roti Tawar yang ada, dari production order Tahap 6) @ Rp1.250 = **Rp37.500** (`consumption_type = SALES_ISSUE`). Sisa Lot #P1: 20 buah. Kalau seandainya Lot #P1 cuma sisa 20 buah pas ada permintaan jual 30, FIFO bakal "nembus" ke lot Roti Tawar berikutnya (dari production order lain) — persis pola yang sama kayak Tepung Terigu di Tahap 4.

Dua jurnal jalan bersamaan (titik HPP akhirnya diakui):
```
(a) Debit Piutang Usaha        60.000
    Kredit Pendapatan Penjualan          60.000

(b) Debit Harga Pokok Penjualan (HPP)   37.500
    Kredit Persediaan Barang Jadi                 37.500
```

**Laba kotor transaksi ini: Rp60.000 − Rp37.500 = Rp22.500** (margin ~37,5%).

## Posisi Akhir per 25 Agustus 2026

| Item | Sisa Qty | Nilai Persediaan |
|---|---|---|
| Tepung Terigu (FIFO) | 45kg (Lot #1) + 50kg (Lot #2 @ 11.000) | 45×10.000 + 50×11.000 = **Rp1.000.000** |
| Gula Pasir (Weighted Avg) | 39kg | 39 × Rp12.500 = **Rp487.500** |
| Roti Tawar (barang jadi) | 20 buah | 20 × Rp1.250 = **Rp25.000** |

Total ini yang muncul di Neraca sebagai "Persediaan". HPP Rp37.500 muncul di Laporan Laba Rugi bulan Agustus.

## Simulasi Interface (rencana)

Sama pola modul lain: setelah DDL (`inventory-schema.md`) dibangun + migration diterapkan, web app bakal punya halaman `/items` (master data barang + metode costing), `/purchase-orders` (bikin PO), `/goods-receipts` (terima barang, cocokkan ke PO, sekaligus bikin bill), `/bom` (kelola resep), `/production-orders` (jalankan produksi), dan integrasi di `/ar-invoices` buat sekaligus bikin goods issue pas invoice dibuat. Detail flow menyusul pas fase UI dikerjakan.

## Lanjutan Story

Fase berikutnya (Fixed Assets) akan menyusutkan oven tambahan & motor yang dibeli 2025 pakai pinjaman KUR (`company-profile.md`) — biaya penyusutan itu nanti juga jadi komponen biaya operasional di Laporan Laba Rugi, melengkapi gambaran biaya CV Roti Barokah di luar HPP bahan baku yang sudah dihitung di sini.
