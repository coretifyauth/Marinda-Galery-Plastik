# Story — Inventory & HPP: CV Roti Barokah

Fase 5. Konteks bisnis: `docs/story/company-profile.md` (poin 5: "hitung HPP roti, butuh weighted average karena harga tepung naik-turun"). Konsep: `docs/domain/inventory.md`. ERD & DDL: `docs/architecture/inventory-schema.md`. Lanjutan langsung dari `docs/story/accounts-payable.md` — bahan baku yang sudah dicatat di sana (dari Toko Tepung Makmur & Toko Gula Sejahtera) sekarang ditelusuri lebih detail: qty & harga per kg, diolah jadi roti, sampai akhirnya kejual dan HPP-nya kehitung.

Timeline cerita ini: **Agustus 2026** (bulan setelah AR/AP per 30 Juli 2026).

> **Catatan migrasi:** metode costing FIFO (per-lot) sudah dihapus total dari sistem (`supabase/migrations/0038_remove_fifo_costing.sql`). Semua item sekarang pakai **Weighted Average** — gak ada lagi konsep `inventory_lots`/lot per-batch, satu-satunya sumber saldo per item adalah `inventory_balances` (qty_on_hand + avg_cost).

## Item Master Data

| Item | Tipe | Satuan Dasar | Metode Costing | Akun Persediaan |
|---|---|---|---|---|
| Tepung Terigu | Bahan Baku | kg | **Weighted Average** — harganya sering naik-turun, tapi sekarang cukup rata-rata tertimbang, gak perlu jejak per-batch | Persediaan Bahan Baku |
| Gula Pasir | Bahan Baku | kg | **Weighted Average** — harga relatif stabil, cukup rata-rata | Persediaan Bahan Baku |
| Roti Tawar | Barang Jadi | buah | **Weighted Average** — ngikutin hasil produksi, avg_cost dihitung ulang tiap ada penambahan qty | Persediaan Barang Jadi |

## Satuan Jual Roti Tawar (`item_units`)

| Satuan Jual | Faktor Konversi (ke "buah") | Harga | Catatan |
|---|---|---|---|
| buah (base) | 1 | Rp2.000/buah | Satuan dasar, dipakai semua pelacakan stok/HPP |
| lusin (isi 12) | 12 | Rp22.000/lusin | Diskon grosir — 12 × Rp2.000 = Rp24.000 kalau beli lepasan, lusin lebih murah Rp2.000 |

Harga-harga ini cuma dipakai buat **menyarankan** nominal pas bikin Goods Issue baru — semua invoice di skenario bawah tetap tercatat pakai nominal yang benar-benar disepakati saat itu, gak pernah berubah retroaktif kalau harganya diubah belakangan (lihat Tahap 8).

## Resep (BOM)

**1 batch Roti Tawar = 5kg Tepung Terigu + 1kg Gula Pasir → menghasilkan 50 buah roti.**

## Tahap 1 — Pesan tepung (PO, 1 Agustus 2026)

Bu Nur pesan ke Toko Tepung Makmur: 50kg Tepung Terigu, harga disepakati Rp10.000/kg.

`purchase_orders`: supplier = Toko Tepung Makmur, po_date = 1 Agustus. `purchase_order_lines`: qty_ordered = 50kg, unit_cost_expected = Rp10.000.

**Belum ada jurnal** — baru komitmen.

## Tahap 2 — Tepung datang + nota (GRN+Bill, 5 Agustus 2026)

Barang datang persis sesuai pesanan: 50kg @ Rp10.000.

`goods_receipt_notes` (nunjuk PO tahap 1) + `goods_receipt_lines` (qty_received = 50kg, unit_cost = Rp10.000, cocok PO — gak ada selisih) → `ap_bills` (amount Rp500.000, due_date = 5 Agustus + 14 hari = **19 Agustus**, **tabel yang sudah ada, gak berubah**) → `inventory_balances` (Tepung Terigu): qty_on_hand 0 → **50kg**, avg_cost = **Rp10.000** (penerimaan pertama, sama pola kayak Gula Pasir di Tahap 3).

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

`goods_receipt_lines`: qty 50kg, unit_cost Rp11.000 (beda dari PO Rp10.000). `inventory_balances` (Tepung Terigu): rata-rata dihitung ulang — (50kg×10.000 + 50kg×11.000) ÷ 100kg = 1.050.000 ÷ 100 = **Rp10.500/kg**. qty_on_hand jadi **100kg**. `ap_bills`: amount Rp550.000, due_date = **29 Agustus**.

Kartu stok Tepung Terigu sekarang: qty_on_hand 100kg, avg_cost Rp10.500/kg — satu angka gabungan, gak ada lagi jejak "yang mana dari batch mana".

## Tahap 5 — Gula datang lagi, harga turun (GRN+Bill, 20 Agustus 2026)

20kg gula lagi, kali ini harga turun jadi Rp12.000/kg.

`inventory_balances` (Gula Pasir): rata-rata dihitung ulang — (20kg×13.000 + 20kg×12.000) ÷ 40kg = 500.000 ÷ 40 = **Rp12.500/kg**. qty_on_hand jadi **40kg**.

## Tahap 6 — Produksi 1 batch roti (Production Order, 22 Agustus 2026)

Jalankan resep: pakai 5kg tepung + 1kg gula → hasil 50 buah Roti Tawar.

`production_orders`: bom = Roti Tawar, qty_produced = 50 buah. `production_order_lines`: Tepung 5kg, Gula 1kg. `inventory_balances` (Tepung Terigu): konsumsi 5kg @ avg Rp10.500 = **Rp52.500** (`consumption_type = PRODUCTION_INPUT`), qty_on_hand turun ke 95kg, avg_cost **tetap** Rp10.500 (konsumsi cuma ngurangin qty, gak ngubah rata-rata). `inventory_balances` (Gula Pasir): konsumsi 1kg @ avg Rp12.500 = **Rp12.500**, sisa 39kg, avg tetap Rp12.500 — Weighted Average gak butuh baris per-lot kayak dulu, cukup update langsung `qty_on_hand` item itu.

Total biaya produksi = Rp52.500 (tepung) + Rp12.500 (gula) = **Rp65.000** untuk 50 buah roti → **biaya per roti = Rp1.300**.

Jurnal:
```
Debit  Persediaan Barang Jadi (Roti Tawar)   65.000
Kredit Persediaan Bahan Baku                          65.000
```
Masih **bukan HPP** — roti belum terjual, baru pindah bentuk dari bahan mentah jadi barang jadi.

**Output produksi ini masuk `inventory_balances` Roti Tawar** (bukan lot terpisah — konsep lot udah gak ada): qty_on_hand 0 → **50 buah**, avg_cost = **Rp1.300** (penerimaan pertama buat item ini, sama mekanisme kayak penerimaan pembelian — cuma sumbernya `PRODUCTION_INPUT/OUTPUT`, bukan `PURCHASE_RECEIPT`). Ini yang bakal jadi sumber HPP pas rotinya kejual.

Perhatikan: production order Tahap 6 ini menyentuh **2 arah sekaligus** — Tepung Terigu (dan Gula Pasir) **keluar** dari `inventory_balances` masing-masing, sementara Roti Tawar **masuk** ke `inventory_balances`-nya sendiri. Dua kejadian berlawanan arah, dipicu 1 production order yang sama, dua-duanya cuma update qty_on_hand/avg_cost — gak ada lagi pemisahan mekanisme "konsumsi lot" vs "lot baru".

## Tahap 7 — Roti terjual ke Warung Pak Budi (Goods Issue + Invoice, 25 Agustus 2026)

Jual 30 dari 50 buah roti, harga Rp2.000/buah = **Rp60.000 pendapatan**. Biaya pokok 30 buah = 30 × Rp1.300 = **Rp39.000**.

`goods_issues` (nunjuk `ar_invoices` yang dibuat bersamaan) + `goods_issue_lines`: 30 buah Roti Tawar. `total_cost`-nya **bukan angka manual** — dihitung dari `avg_cost` Roti Tawar yang berlaku saat itu di `inventory_balances`: 30 buah × Rp1.300 = **Rp39.000** (`consumption_type = SALES_ISSUE`). qty_on_hand Roti Tawar turun ke 20 buah, avg_cost tetap Rp1.300 (konsumsi gak ngubah rata-rata, cuma ngurangin qty).

Dua jurnal jalan bersamaan (titik HPP akhirnya diakui):
```
(a) Debit Piutang Usaha        60.000
    Kredit Pendapatan Penjualan          60.000

(b) Debit Harga Pokok Penjualan (HPP)   39.000
    Kredit Persediaan Barang Jadi                 39.000
```

**Laba kotor transaksi ini: Rp60.000 − Rp39.000 = Rp21.000** (margin 35%).

## Posisi Akhir per 25 Agustus 2026

| Item | Sisa Qty | Nilai Persediaan |
|---|---|---|
| Tepung Terigu (Weighted Avg) | 95kg @ Rp10.500 | **Rp997.500** |
| Gula Pasir (Weighted Avg) | 39kg @ Rp12.500 | **Rp487.500** |
| Roti Tawar (barang jadi, Weighted Avg) | 20 buah @ Rp1.300 | **Rp26.000** |

Total Persediaan = Rp997.500 + Rp487.500 + Rp26.000 = **Rp1.511.000**, ini yang muncul di Neraca. HPP Rp39.000 muncul di Laporan Laba Rugi bulan Agustus.

## Tahap 8 — Jual pakai satuan "lusin" (Goods Issue + Invoice, 30 Agustus 2026)

Lanjutan cross-modul: antara 25–30 Agustus, 3 buah Roti Tawar dari Tahap 7 sempat diretur rusak lalu ditukar garansi (`docs/story/accounts-receivable.md` Skenario 6 & 6b) — qty Roti Tawar per 30 Agustus jadi **17 buah @ Rp1.300** (gak berubah dari avg_cost, cuma qty yang turun karena penukaran barang).

Barokah mulai nawarin satuan **lusin** (isi 12) buat pembelian grosir. Warung Bu Imas beli **1 lusin**.

RPC `create_goods_issue` dipanggil — **qty yang dikirim tetap di satuan dasar** (`buah`), bukan "1" (maksudnya 1 lusin). Konversi terjadi di UI sebelum RPC dipanggil: 1 lusin × 12 (faktor konversi) = **12 buah**.

```
Qty dikonsumsi dari stok = 12 buah
HPP = 12 buah × Rp1.300 (avg_cost berlaku)     = Rp15.600
Pendapatan = 1 lusin × Rp22.000 (harga/lusin)  = Rp22.000
```

Dua jurnal jalan bersamaan (persis pola Tahap 7, cuma nominalnya dari harga per-lusin, bukan per-buah):
```
Debit Piutang Usaha        22.000
  Kredit Pendapatan Penjualan     22.000

Debit Harga Pokok Penjualan (HPP)  15.600
  Kredit Persediaan Barang Jadi           15.600
```

**Laba kotor: Rp22.000 − Rp15.600 = Rp6.400.** Kalau dijual lepasan 12 buah @ Rp2.000 = Rp24.000, laba kotornya akan Rp24.000−15.600=Rp8.400 — lebih besar, tapi itu konsekuensi diskon grosir yang memang disengaja (harga per lusin bukan hasil kali otomatis dari harga per buah).

`inventory_balances` Roti Tawar: qty_on_hand 17 → **5 buah** (avg_cost tetap Rp1.300, konsumsi gak ngubah rata-rata).

## Tahap 9 — Stock Opname (Penyesuaian Stok Fisik, 10 September 2026)

Lanjutan cross-modul: Gula Pasir sempat kena Opsi A retur (4kg, `docs/story/accounts-payable.md` Skenario 6) dan Opsi C write-off (2kg, Skenario 10) — posisi per 5 September jadi **33kg @ Rp12.500**.

Awal bulan, Bu Nur hitung fisik seluruh gudang (bukan dipicu kejadian tertentu — cuma rutinitas bulanan) dan bandingin ke catatan sistem:

| Item | Catatan Sistem | Hasil Hitung Fisik | Selisih |
|---|---|---|---|
| Tepung Terigu | 95kg | **90kg** | **Kurang 5kg** — kemungkinan lembap/susut, gak ketauan sebabnya persis |
| Gula Pasir | 33kg | **36kg** | **Lebih 3kg** — kemungkinan ada penerimaan lama yang kelewat dicatat |

RPC `record_stock_opname` dipanggil 1 kali buat kedua item sekaligus (1 sesi opname). Nilai selisih dihitung dari `avg_cost` masing-masing item **saat opname** (bukan harga historis):

```
Tepung Terigu: selisih 5kg × Rp10.500 (avg_cost berlaku) = Rp52.500 (kurang, jadi beban)
Gula Pasir:    selisih 3kg × Rp12.500 (avg_cost berlaku) = Rp37.500 (lebih, jadi pendapatan)
```

Dua jurnal terpisah (BUKAN di-netting jadi 1 angka Rp15.000):

```
Tepung Terigu (kurang):
Debit Beban Selisih Persediaan       52.500
  Kredit Persediaan Bahan Baku              52.500

Gula Pasir (lebih):
Debit Persediaan Bahan Baku          37.500
  Kredit Pendapatan Selisih Persediaan       37.500
```

`inventory_balances` disesuaikan langsung ke hasil hitung fisik — Tepung Terigu qty_on_hand 95 → **90kg** (avg_cost tetap Rp10.500, gak berubah), Gula Pasir qty_on_hand 33 → **36kg** (avg_cost tetap Rp12.500). Roti Tawar gak dihitung ulang sesi ini (hasil hitungnya pas 5 buah, sesuai catatan) — gak ada baris/jurnal buat item itu sama sekali.

## Posisi Akhir per 10 September 2026

| Item | Sisa Qty | Nilai Persediaan |
|---|---|---|
| Tepung Terigu (Weighted Avg) | 90kg @ Rp10.500 | **Rp945.000** |
| Gula Pasir (Weighted Avg) | 36kg @ Rp12.500 | **Rp450.000** |
| Roti Tawar (barang jadi, Weighted Avg) | 5 buah @ Rp1.300 | **Rp6.500** |

Total Persediaan = Rp945.000 + Rp450.000 + Rp6.500 = **Rp1.401.500**. Laporan Laba Rugi bulan September kena tambahan 2 baris: Beban Selisih Persediaan Rp52.500 dan Pendapatan Selisih Persediaan Rp37.500 — net-nya rugi Rp15.000, tapi keduanya tetap keliatan terpisah, gak ketimbun jadi 1 angka.

## Simulasi Interface (rencana)

Sama pola modul lain: setelah DDL (`inventory-schema.md`) dibangun + migration diterapkan, web app bakal punya halaman `/items` (master data barang + metode costing + kelola satuan jual & harga per satuan), `/purchase-orders` (bikin PO), `/goods-receipts` (terima barang, cocokkan ke PO, sekaligus bikin bill), `/bom` (kelola resep), `/production-orders` (jalankan produksi), `/stock-opnames` (list+create sesi hitung fisik, tiap baris input qty hasil hitung per item, selisih & jurnal dihitung otomatis pas submit), dan integrasi di `/ar-invoices` buat sekaligus bikin goods issue pas invoice dibuat. Form Goods Issue punya pemilih satuan jual per baris item (bukan cuma qty) — begitu satuan+qty dipilih, UI otomatis konversi ke satuan dasar & saranin nominal dari harga satuan itu. Detail flow menyusul pas fase UI dikerjakan.

## Lanjutan Story

Fase berikutnya (Fixed Assets) akan menyusutkan oven tambahan & motor yang dibeli 2025 pakai pinjaman KUR (`company-profile.md`) — biaya penyusutan itu nanti juga jadi komponen biaya operasional di Laporan Laba Rugi, melengkapi gambaran biaya CV Roti Barokah di luar HPP bahan baku yang sudah dihitung di sini.
