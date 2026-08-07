# Inventory & COGS — Dari Bahan Baku Jadi Harga Pokok Penjualan

## Masalah yang Diselesaikan

Sampai fase AP, sistem udah bisa nyatet "beli bahan baku Rp500.000, belum bayar" (Debit Persediaan, Kredit Utang Usaha) dan "jual barang Rp800.000, belum dibayar" (Debit Piutang, Kredit Pendapatan). Tapi ada satu angka penting yang belum pernah dihitung: **berapa modal yang keluar buat menghasilkan barang yang terjual itu** — Harga Pokok Penjualan (HPP), atau *Cost of Goods Sold* (COGS).

Tanpa HPP, Laporan Laba Rugi bohong. Kelihatan pendapatan besar, padahal margin sebenarnya tipis (atau malah rugi), karena biaya bahan baku yang beneran kepakai belum dikurangkan dengan benar. Modul Inventory nutup gap ini: melacak barang secara fisik (qty & harga per satuan) dari saat diterima, diproses jadi barang jadi, sampai terjual — supaya HPP bisa dihitung akurat.

## Prinsip Inti: Membeli ≠ Berbiaya

Ini sering disalahpahami: **membeli bahan baku bukan biaya (expense).** Itu cuma **tukar bentuk aset** — kas/utang berubah jadi Persediaan (aset juga). Baru pas barang itu (dalam bentuk jadi) **benar-benar terjual**, nilainya "keluar" dari Neraca (aset) masuk ke Laporan Laba Rugi (biaya) sebagai HPP.

Ini konsekuensi langsung dari **matching principle** (sudah disinggung di `general-ledger.md`): biaya diakui **bersamaan** dengan pendapatan yang dihasilkannya, bukan pas kas/utang bergerak.

Contoh alur nilai (generik):

| Tahap | Kejadian | Sisi Neraca (Aset) | Sisi Laba Rugi |
|---|---|---|---|
| 1 | Beli bahan baku, belum bayar | Persediaan Bahan Baku naik | — |
| 2 | Bahan baku diproses jadi barang jadi | Pindah dari Persediaan Bahan Baku ke Persediaan Barang Jadi | — |
| 3 | Barang jadi terjual | Persediaan Barang Jadi turun | **HPP muncul**, dicocokkan ke Pendapatan penjualan yang sama |

Nilai Rp yang sama mengalir dari tahap 1 sampai 3 — gak pernah "hilang", cuma pindah kolom, sampai akhirnya keluar sebagai biaya pas barangnya laku.

## Kenapa Butuh Metode Costing

Masalahnya: harga bahan baku gak selalu sama tiap kali beli. Kalau perusahaan beli bahan yang sama di harga berbeda-beda (batch pertama Rp10.000/unit, batch kedua Rp11.000/unit karena harga naik), pertanyaannya: **pas bahan itu dipakai, harga mana yang dianggap "keluar"?**

Dua metode umum:

### FIFO (First In, First Out)

Asumsi: barang yang masuk duluan, dipakai/dijual duluan. Butuh **tracking per-batch (lot)** — tiap penerimaan barang jadi 1 "lapisan" (layer) tersendiri dengan harga masing-masing, dan pas ada pemakaian, sistem "ambil" dari lapisan tertua dulu sampai habis, baru lanjut ke lapisan berikutnya.

Contoh: beli 50 unit @ Rp10.000 (Lot A), lalu 50 unit @ Rp11.000 (Lot B). Pakai 60 unit → ambil 50 dari Lot A (Rp500.000) + 10 dari Lot B (Rp110.000) = **Rp610.000** total biaya. Sisa: 40 unit di Lot B (Rp440.000).

**Lot punya 2 sisi yang gampang keketuker:** sisi **"lahir"** (lot baru terbentuk — bisa dari pembelian, atau dari hasil produksi kalau barang jadi juga di-FIFO-kan) dan sisi **"dikonsumsi"** (qty dari lot yang sudah ada dipakai/dikurangi — bisa jadi input produksi, atau keluar karena terjual). Kata "produksi" bisa muncul di kedua sisi ini sekaligus untuk 1 kejadian produksi yang sama: bahan baku **dikonsumsi** (keluar, jadi input), barang jadi **lahir** (masuk, jadi lot baru hasil output) — dua arah berlawanan, dua item berbeda, tapi dipicu 1 kejadian yang sama.

### Weighted Average (Rata-Rata Tertimbang)

Asumsi: semua batch yang belum kepakai diratakan jadi **1 angka biaya per unit**, dihitung ulang tiap ada penerimaan baru. Gak perlu tau lagi batch mana harganya berapa — begitu barang baru masuk, harga lama dan baru langsung "dicampur".

Contoh: 50 unit @ Rp10.000 + 50 unit @ Rp11.000 → rata-rata = (500.000+550.000) ÷ 100 = **Rp10.500/unit**. Pakai 60 unit → 60 × Rp10.500 = **Rp630.000**.

### Bedanya, dan Kenapa Bisa Beda Hasil

FIFO **mengingat riwayat per-batch** (butuh struktur data berlapis — banyak baris aktif sekaligus per item). Weighted Average **sengaja melupakan riwayat** dan cuma menyimpan 1 angka gabungan (cukup 1 baris per item, di-update terus-menerus). Konsekuensinya:

- FIFO lebih presisi kalau harga sering naik-turun tajam, tapi query/struktur datanya lebih kompleks.
- Weighted Average lebih sederhana, tapi "meratakan" fluktuasi harga — kurang presisi kalau lonjakan harga signifikan & sering.

Beda hasil HPP di atas (Rp610.000 vs Rp630.000) kelihatan kecil di contoh ini, tapi bisa signifikan kalau harga bahan baku fluktuatif terus-menerus dan volume transaksi besar.

**Catatan implementasi:** kedua metode di atas sempat sama-sama diimplementasikan di sistem ini (per item boleh pilih salah satu — misal Tepung Terigu FIFO karena harganya sering naik-turun, Gula Pasir Weighted Average). FIFO kemudian **dihapus total** dari sistem (migration `0038_remove_fifo_costing.sql`) — sekarang Weighted Average dipakai semua item tanpa kecuali, termasuk yang harganya fluktuatif. Alasannya: rata-rata berjalan tetap merefleksikan perubahan harga (kenaikan/penurunan langsung kebawa ke `avg_cost` pas penerimaan baru), cuma gak sepresisi FIFO di level per-batch — trade-off yang diterima demi struktur data & logika yang jauh lebih sederhana, dianggap sepadan buat skala bisnis ini.

## Bill of Materials (BOM) — Resep Produksi

Kalau bisnisnya mengolah bahan baku jadi barang jadi (bukan cuma jual-beli barang yang sama persis), perlu ada **resep** yang mendefinisikan: berapa banyak tiap bahan baku dibutuhkan buat menghasilkan sejumlah barang jadi tertentu.

Contoh generik: 1 batch produksi = 5kg Bahan A + 1kg Bahan B → menghasilkan 50 unit Barang Jadi.

Pas ada **Production Order** (kejadian produksi beneran), sistem:
1. **Konsumsi** bahan baku sesuai resep (dikali berapa batch yang dijalankan) — nilai konsumsi dihitung dari Weighted Average (harga rata-rata saat itu).
2. **Hasilkan** barang jadi sejumlah output resep, dengan **nilai/biaya = total biaya bahan baku yang dikonsumsi**.

Ini tetap **tukar aset ke aset** (Persediaan Bahan Baku → Persediaan Barang Jadi) — belum jadi HPP, karena barang jadi belum tentu langsung terjual.

**Catatan scope:** perhitungan biaya produksi generik di atas cuma mencakup **biaya bahan baku**. Biaya tenaga kerja langsung & overhead pabrik (listrik produksi, penyusutan mesin produksi, dst) adalah komponen HPP yang sebenarnya juga wajib masuk secara prinsip akuntansi biaya penuh (*full absorption costing*), tapi butuh mekanisme alokasi terpisah — di luar cakupan modul ini untuk saat ini.

## Purchase Order & 3-Way Matching

Sebelum barang fisik diterima, ada tahap **komitmen**: perusahaan memesan barang ke supplier lewat **Purchase Order (PO)** — mencatat apa yang dipesan, berapa qty, dan harga yang disepakati. PO **belum mengubah apapun di General Ledger** — ini baru rencana/janji, belum kejadian akuntansi (belum ada pertukaran aset/liability apapun).

Begitu barang fisik sampai, dicatat **Goods Receipt Note (GRN)** — bukti penerimaan riil, isinya qty & harga yang **benar-benar** diterima (bisa beda dari yang dipesan). GRN inilah yang jadi dasar penambahan Persediaan (update rata-rata berjalan).

**3-way matching** adalah praktik mencocokkan **3 dokumen**: PO (apa yang dipesan), GRN (apa yang diterima), dan Bill/Invoice dari supplier (apa yang ditagih). Tujuannya mencegah:
- Diterima kurang dari yang ditagih (dipesan 50 unit, datang cuma 48, tapi ditagih 50).
- Harga beda dari kesepakatan (nego harga X, ditagih harga Y).
- Ditagih tanpa barang pernah diterima sama sekali.

Idealnya, PO, GRN, dan Bill bisa terjadi di **waktu yang berbeda-beda** (barang datang duluan, tagihan resmi nyusul beberapa hari kemudian — butuh akun perantara semacam "Barang Diterima Belum Ditagih" buat menampung selisih waktu itu). Di skala yang lebih sederhana, GRN dan Bill dianggap terjadi **bersamaan** (nota yang datang = bukti kirim + tagihan sekaligus) — ini menyederhanakan alur tanpa akun perantara, cocok kalau proses pembelian bisnisnya memang informal dan gak ada jeda berarti antara barang datang dan tagihan resmi.

## Goods Issue — Sisi Keluar (Penjualan)

Kebalikan dari GRN: pas barang jadi **keluar** dari gudang karena terjual, dicatat **Goods Issue** — qty barang jadi yang keluar, dan **biaya pokoknya** (dihitung dari metode costing barang jadi itu). Inilah titik di mana HPP akhirnya **diakui** — dua jurnal jalan bersamaan:

```
Debit  Piutang Usaha / Kas          [harga jual]
Kredit Pendapatan Penjualan                    [harga jual]

Debit  Harga Pokok Penjualan (HPP)  [biaya pokok]
Kredit Persediaan Barang Jadi                  [biaya pokok]
```

Selisih antara harga jual dan HPP = **laba kotor** transaksi itu.

## Constraint Wajib

**1. Membeli bahan baku selalu masuk Persediaan (aset), bukan Beban langsung**
Konsekuensi matching principle — biaya baru diakui pas barang terjual, bukan pas dibeli.

**2. Metode costing: Weighted Average, berlaku semua item**
Sejak FIFO dihapus (migration `0038`), gak ada lagi pilihan metode per item — satu mekanisme buat semua, gak ada isu "gonta-ganti metode" lagi.

**3. Pengurangan qty (Weighted Average) gak boleh melebihi yang tersedia**
Gak bisa mengeluarkan barang yang secara fisik gak ada di stok.

**4. Goods Receipt harus tertelusur ke Purchase Order, dan gak boleh melebihi qty yang dipesan**
Bagian dari 3-way matching — mencegah penerimaan "siluman" yang gak pernah dipesan, atau qty diterima melebihi qty dipesan tanpa sepengetahuan.

**5. Tiap pergerakan stok (masuk/keluar) harus tertelusur ke dokumen sumber**
Sama invarian traceability yang berlaku di semua modul lain — Goods Receipt tertelusur ke PO+Bill, Goods Issue tertelusur ke Invoice, Production Order tertelusur ke resep (BOM) yang dipakai.

**Catatan lintas modul:** master data item punya kolom `return_window_days` (nullable) — batas hari maksimal item itu boleh diretur customer, dipakai fitur AR Credit Note (`docs/domain/accounts-receivable.md` bagian "Retur Barang"). Ditaro di item (bukan di customer), karena soal umur simpan fisik barangnya, bukan soal hubungan dagang ke customer tertentu.

## Common Mistakes

- Mencatat pembelian bahan baku langsung sebagai Beban/HPP — padahal itu masih aset sampai barangnya terjual.
- Menghitung HPP berdasarkan **kapan utang ke supplier dibayar**, bukan berdasarkan **kapan barangnya terjual** — dua hal yang sama sekali gak berhubungan.
- Weighted Average tapi nyimpen riwayat per-batch juga — bikin ambigu metode mana yang beneran dipakai; padahal justru kesederhanaan (melupakan riwayat) itu ciri khasnya.
- Menganggap Purchase Order sebagai kejadian akuntansi (bikin jurnal) — PO cuma komitmen, jurnal baru muncul pas barang diterima (GRN+Bill).
- Lupa bahwa produksi (bahan baku → barang jadi) bukan HPP — itu masih pemindahan antar-aset, HPP baru muncul pas barang jadi itu terjual.
