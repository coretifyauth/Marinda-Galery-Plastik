# Inventory & COGS — Dari Bahan Baku Jadi Harga Pokok Penjualan

## Masalah yang Diselesaikan

Sampai fase AP, sistem udah bisa nyatet "beli bahan baku Rp500.000, belum bayar" (Debit Persediaan, Kredit Utang Usaha) dan "jual barang Rp800.000, belum dibayar" (Debit Piutang, Kredit Pendapatan). Tapi ada satu angka penting yang belum pernah dihitung: **berapa modal yang keluar buat menghasilkan barang yang terjual itu** — Harga Pokok Penjualan (HPP), atau *Cost of Goods Sold* (COGS).

Tanpa HPP, Laporan Laba Rugi bohong. Kelihatan pendapatan besar, padahal margin sebenarnya tipis (atau malah rugi), karena biaya bahan baku yang beneran kepakai belum dikurangkan dengan benar. Modul Inventory nutup gap ini: melacak barang secara fisik (qty & harga per satuan) dari saat diterima, diproses jadi barang jadi, sampai terjual — supaya HPP bisa dihitung akurat.

## Konsep Inti

- **Barang (Item)** — unit yang dilacak sistem, dua jenis: **bahan baku** (dipakai buat produksi) dan **barang jadi** (yang akhirnya dijual ke customer). Semua barang, tanpa kecuali, pakai metode hitung biaya yang sama — Rata-Rata Tertimbang (lihat di bawah).
- **Posisi stok per barang** — qty yang tersedia sekarang, plus harga rata-rata per satuan. Ini semacam "buku besar fisik" yang dipakai bareng-bareng oleh tiga alur di modul ini: beli (nambah), produksi (nambah barang jadi, ngurangin bahan baku), dan jual (ngurangin barang jadi). Diperbarui tiap kali ada barang masuk (harga rata-rata berubah) atau keluar (qty berkurang, harga rata-rata tetap).

**Membeli ≠ Berbiaya**

Ini sering disalahpahami: **membeli bahan baku bukan biaya (expense).** Itu cuma **tukar bentuk aset** — kas/utang berubah jadi Persediaan (aset juga). Baru pas barang itu (dalam bentuk jadi) **benar-benar terjual**, nilainya "keluar" dari Neraca (aset) masuk ke Laporan Laba Rugi (biaya) sebagai HPP.

Ini konsekuensi langsung dari **matching principle** (sudah disinggung di `general-ledger.md`): biaya diakui **bersamaan** dengan pendapatan yang dihasilkannya, bukan pas kas/utang bergerak.

Contoh alur nilai (generik):

| Tahap | Kejadian | Sisi Neraca (Aset) | Sisi Laba Rugi |
|---|---|---|---|
| 1 | Beli bahan baku, belum bayar | Persediaan Bahan Baku naik | — |
| 2 | Bahan baku diproses jadi barang jadi | Pindah dari Persediaan Bahan Baku ke Persediaan Barang Jadi | — |
| 3 | Barang jadi terjual | Persediaan Barang Jadi turun | **HPP muncul**, dicocokkan ke Pendapatan penjualan yang sama |

Nilai Rp yang sama mengalir dari tahap 1 sampai 3 — gak pernah "hilang", cuma pindah kolom, sampai akhirnya keluar sebagai biaya pas barangnya laku.

**Kenapa Butuh Metode Costing**

Masalahnya: harga bahan baku gak selalu sama tiap kali beli. Kalau perusahaan beli bahan yang sama di harga berbeda-beda (batch pertama Rp10.000/unit, batch kedua Rp11.000/unit karena harga naik), pertanyaannya: **pas bahan itu dipakai, harga mana yang dianggap "keluar"?**

Dua metode umum:

- **FIFO (First In, First Out)** — asumsi barang yang masuk duluan, dipakai/dijual duluan. Butuh **tracking per-batch (lot)**: tiap penerimaan barang jadi 1 "lapisan" tersendiri dengan harga masing-masing, dan pas ada pemakaian, sistem "ambil" dari lapisan tertua dulu sampai habis, baru lanjut ke lapisan berikutnya. Contoh: beli 50 unit @ Rp10.000 (Lot A), lalu 50 unit @ Rp11.000 (Lot B). Pakai 60 unit → ambil 50 dari Lot A (Rp500.000) + 10 dari Lot B (Rp110.000) = **Rp610.000** total biaya. Sisa: 40 unit di Lot B (Rp440.000). Lot punya 2 sisi yang gampang keketuker: sisi "lahir" (lot baru terbentuk — dari pembelian, atau dari hasil produksi) dan sisi "dikonsumsi" (qty dari lot yang sudah ada dipakai/dikurangi — jadi input produksi, atau keluar karena terjual). Kata "produksi" bisa muncul di kedua sisi sekaligus untuk 1 kejadian produksi yang sama: bahan baku **dikonsumsi**, barang jadi **lahir** — dua arah berlawanan, dua item berbeda, tapi dipicu 1 kejadian yang sama.
- **Rata-Rata Tertimbang (Weighted Average)** — asumsi semua batch yang belum kepakai diratakan jadi **1 angka biaya per unit**, dihitung ulang tiap ada penerimaan baru. Gak perlu tau lagi batch mana harganya berapa — begitu barang baru masuk, harga lama dan baru langsung "dicampur". Contoh: 50 unit @ Rp10.000 + 50 unit @ Rp11.000 → rata-rata = (500.000+550.000) ÷ 100 = **Rp10.500/unit**. Pakai 60 unit → 60 × Rp10.500 = **Rp630.000**.

FIFO **mengingat riwayat per-batch** (butuh struktur data berlapis — banyak baris aktif sekaligus per barang). Rata-Rata Tertimbang **sengaja melupakan riwayat** dan cuma menyimpan 1 angka gabungan (cukup 1 baris per barang, di-update terus-menerus) — kalau ada sistem yang ngaku pakai Rata-Rata Tertimbang tapi tetap nyimpen riwayat per-batch, itu ambigu, karena justru "melupakan riwayat" itu ciri khasnya. Konsekuensinya: FIFO lebih presisi kalau harga sering naik-turun tajam tapi query/struktur datanya lebih kompleks; Rata-Rata Tertimbang lebih sederhana tapi "meratakan" fluktuasi harga — kurang presisi kalau lonjakan harga signifikan & sering. Beda hasil HPP di atas (Rp610.000 vs Rp630.000) kelihatan kecil di contoh ini, tapi bisa signifikan kalau harga bahan baku fluktuatif terus-menerus dan volume transaksi besar.

**Metode yang dipakai sekarang: Rata-Rata Tertimbang, satu-satunya**

Kedua metode di atas sempat sama-sama diimplementasikan di sistem ini (per barang boleh pilih salah satu — misal Tepung Terigu FIFO karena harganya sering naik-turun, Gula Pasir Rata-Rata Tertimbang). FIFO kemudian **dihapus total** dari sistem — sekarang Rata-Rata Tertimbang dipakai semua barang tanpa kecuali, termasuk yang harganya fluktuatif. Alasannya: rata-rata berjalan tetap merefleksikan perubahan harga (kenaikan/penurunan langsung kebawa ke harga rata-rata pas penerimaan baru), cuma gak sepresisi FIFO di level per-batch — trade-off yang diterima demi struktur data & logika yang jauh lebih sederhana, dianggap sepadan buat skala bisnis ini. Pembelian bahan baku sendiri selalu nambah Persediaan (aset) — gak pernah langsung dicatat sebagai Beban, apa pun metode costing-nya.

### Purchase Order & Penerimaan Barang (3-Way Matching)

**Cara Kerja**
- Sebelum barang fisik diterima, ada tahap **komitmen**: perusahaan memesan barang ke supplier lewat **Purchase Order (PO)** — mencatat apa yang dipesan, berapa qty, dan harga yang disepakati. PO **belum mengubah apapun di General Ledger** — ini baru rencana/janji, belum kejadian akuntansi (belum ada pertukaran aset/liability apapun).
- Begitu barang fisik sampai, dicatat **Goods Receipt Note (GRN)** — bukti penerimaan riil, isinya qty & harga yang **benar-benar** diterima (bisa beda dari yang dipesan). GRN inilah yang jadi dasar penambahan Persediaan (update rata-rata berjalan) dan yang memunculkan jurnal Debit Persediaan, Kredit Utang Usaha.
- **3-way matching** adalah praktik mencocokkan **3 dokumen**: PO (apa yang dipesan), GRN (apa yang diterima), dan Bill/Invoice dari supplier (apa yang ditagih). Tujuannya mencegah: diterima kurang dari yang ditagih (dipesan 50 unit, datang cuma 48, tapi ditagih 50), harga beda dari kesepakatan (nego harga X, ditagih harga Y), dan ditagih tanpa barang pernah diterima sama sekali.
- Idealnya, PO, GRN, dan Bill bisa terjadi di **waktu yang berbeda-beda** (barang datang duluan, tagihan resmi nyusul beberapa hari kemudian — butuh akun perantara semacam "Barang Diterima Belum Ditagih" buat menampung selisih waktu itu). Di skala yang lebih sederhana kayak sekarang, GRN dan Bill dianggap terjadi **bersamaan** (nota yang datang = bukti kirim + tagihan sekaligus) — ini menyederhanakan alur tanpa akun perantara, cocok kalau proses pembelian bisnisnya memang informal dan gak ada jeda berarti antara barang datang dan tagihan resmi. Akun perantara itu baru beneran dibutuhkan kalau nanti proses pembeliannya berkembang sampai butuh jeda waktu — belum ada tekanan nyata buat itu sekarang.

**Aturan Bisnis**
- Purchase Order tidak boleh dianggap kejadian akuntansi — gak ada jurnal apa pun sampai barangnya beneran diterima.
- Penerimaan barang tidak boleh melebihi jumlah yang masih tersisa dari yang dipesan di Purchase Order-nya (per barang).
- Pembelian bahan baku selalu masuk Persediaan (aset), tidak pernah langsung jadi Beban.
- Penerimaan barang harus tertelusur ke Purchase Order dan tagihan (Bill) yang menyertainya.

**Skenario**
- Pesan bahan baku lewat PO, barang datang persis sesuai pesanan — Persediaan naik, harga rata-rata diperbarui (atau jadi harga awal kalau ini penerimaan pertama barang itu), Utang Usaha muncul dari tagihan yang menyertai.
- Pesan bahan baku lagi, tapi harga saat diterima ternyata beda dari yang disepakati di PO — dicatat apa adanya (selisih harga informasional, gak diblokir), cuma qty yang dijaga ketat supaya gak melebihi pesanan.

**Common Mistakes**
- Menganggap Purchase Order sebagai kejadian akuntansi (bikin jurnal) — PO cuma komitmen, jurnal baru muncul pas barang diterima (GRN+Bill).
- Mencatat pembelian bahan baku langsung sebagai Beban/HPP — padahal itu masih aset sampai barangnya terjual.

### Produksi (Bill of Materials & Production Order)

**Cara Kerja**
- Kalau bisnisnya mengolah bahan baku jadi barang jadi (bukan cuma jual-beli barang yang sama persis), perlu ada **resep (Bill of Materials/BOM)** yang mendefinisikan: berapa banyak tiap bahan baku dibutuhkan buat menghasilkan sejumlah barang jadi tertentu. Contoh generik: 1 batch produksi = 5kg Bahan A + 1kg Bahan B → menghasilkan 50 unit Barang Jadi. Resep boleh direvisi kapan saja — revisi ini **tidak mengubah histori produksi yang sudah terjadi**, karena tiap produksi menyimpan salinan angkanya sendiri, bukan mengacu ulang ke resep tiap kali dibaca.
- Pas ada **Production Order** (kejadian produksi beneran), sistem: (1) **konsumsi** bahan baku sesuai resep (dikali berapa batch yang dijalankan) — nilai konsumsi dihitung dari harga rata-rata tertimbang saat itu; (2) **hasilkan** barang jadi sejumlah output resep, dengan nilai/biaya = total biaya bahan baku yang dikonsumsi.
- Ini tetap **tukar aset ke aset** (Persediaan Bahan Baku → Persediaan Barang Jadi) — belum jadi HPP, karena barang jadi belum tentu langsung terjual. Jurnalnya:
  ```
  Debit Persediaan Barang Jadi
    Kredit Persediaan Bahan Baku
  ```
- **Catatan scope:** perhitungan biaya produksi di atas cuma mencakup **biaya bahan baku**. Biaya tenaga kerja langsung & overhead pabrik (listrik produksi, penyusutan mesin produksi, dst) adalah komponen HPP yang sebenarnya juga wajib masuk secara prinsip akuntansi biaya penuh (*full absorption costing*), tapi butuh mekanisme alokasi terpisah — di luar cakupan modul ini untuk saat ini.

**Aturan Bisnis**
- Konsumsi bahan baku tidak boleh melebihi qty yang tersedia di stok.
- Tiap produksi harus tertelusur ke resep (BOM) yang dipakai, dan menyimpan salinan angka bahan baku & biaya yang benar-benar dipakai saat itu — bukan mengacu ulang ke resep.

**Skenario**
- Jalankan 1 batch resep — bahan baku berkurang sesuai takaran (dikali jumlah batch), harga rata-rata bahan baku tidak berubah karena konsumsi (cuma qty yang turun), barang jadi bertambah dengan biaya per unit = total biaya bahan yang dikonsumsi dibagi qty yang dihasilkan.

**Common Mistakes**
- Menganggap produksi (bahan baku → barang jadi) sebagai HPP — itu masih pemindahan antar-aset, HPP baru muncul pas barang jadi itu terjual.

### Penjualan & Pengakuan HPP (Goods Issue)

**Cara Kerja**
- Kebalikan dari penerimaan barang: pas barang jadi **keluar** dari gudang karena terjual, dicatat **Goods Issue** — qty barang jadi yang keluar, dan **biaya pokoknya** (dihitung dari harga rata-rata tertimbang barang jadi itu). Dibuat **bersamaan** dengan invoice penjualan (sama pola dengan GRN+Bill di sisi beli). Inilah titik di mana HPP akhirnya **diakui** — dua jurnal jalan bersamaan:
  ```
  Debit  Piutang Usaha / Kas          [harga jual]
  Kredit Pendapatan Penjualan                    [harga jual]

  Debit  Harga Pokok Penjualan (HPP)  [biaya pokok]
  Kredit Persediaan Barang Jadi                  [biaya pokok]
  ```
- Selisih antara harga jual dan HPP = **laba kotor** transaksi itu.
- Sisi jual belum punya pencocokan tiga arah (3-way matching) selayaknya sisi beli — belum ada "Sales Order" sebagai cerminan Purchase Order yang mendahului Goods Issue, invoice dan Goods Issue langsung dibuat bersamaan tanpa tahap komitmen terpisah. Belum jadi masalah nyata sekarang karena penjualan langsung dicatat begitu terjadi, tapi kalau nanti bisnisnya butuh tahap "pesanan pelanggan" terpisah sebelum barang keluar (misal pesanan custom yang perlu dikonfirmasi dulu sebelum barang disiapkan), ini yang perlu ditambahkan.
- **Catatan lintas modul (retur):** kalau barang yang terjual lewat Goods Issue ini diretur customer, sistem membalik sebagian stok+HPP secara proporsional, pakai harga pokok **snapshot asli** pas barang itu keluar (bukan harga sekarang) — detail penuh ada di dokumentasi Piutang Usaha (Retur Barang/Credit Note). Catatan terbuka: barang yang balik dari retur masuk lagi sebagai stok bernilai seolah layak jual biasa — padahal kalau alasan returnya barang rusak, harusnya diakui sebagai kerugian, bukan ditambahkan balik jadi stok yang bisa dijual/dipakai ganti lagi. Belum ada kejadian ini di cerita bisnis yang sedang berjalan, jadi belum didesain.

**Aturan Bisnis**
- Pengurangan stok barang jadi (Goods Issue) tidak boleh melebihi qty yang tersedia.
- Goods Issue harus tertelusur ke invoice penjualan yang dibuat bersamaan.

**Skenario**
- Jual sejumlah barang jadi — HPP diakui dari harga rata-rata tertimbang barang jadi itu saat transaksi terjadi, laba kotor = harga jual dikurangi HPP.

**Common Mistakes**
- Menghitung HPP berdasarkan **kapan utang ke supplier dibayar**, bukan berdasarkan **kapan barangnya terjual** — dua hal yang sama sekali gak berhubungan. HPP baru diakui persis di titik Goods Issue ini, gak lebih cepat dan gak lebih lambat.
