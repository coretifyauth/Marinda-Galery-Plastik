# Inventory & COGS — Dari Bahan Baku Jadi Harga Pokok Penjualan

## Masalah yang Diselesaikan

Sampai fase AP, sistem udah bisa nyatet "beli bahan baku Rp500.000, belum bayar" (Debit Persediaan, Kredit Utang Usaha) dan "jual barang Rp800.000, belum dibayar" (Debit Piutang, Kredit Pendapatan). Tapi ada satu angka penting yang belum pernah dihitung: **berapa modal yang keluar buat menghasilkan barang yang terjual itu** — Harga Pokok Penjualan (HPP), atau *Cost of Goods Sold* (COGS).

Tanpa HPP, Laporan Laba Rugi bohong. Kelihatan pendapatan besar, padahal margin sebenarnya tipis (atau malah rugi), karena biaya bahan baku yang beneran kepakai belum dikurangkan dengan benar. Modul Inventory nutup gap ini: melacak barang secara fisik (qty & harga per satuan) dari saat diterima, diproses jadi barang jadi, sampai terjual — supaya HPP bisa dihitung akurat.

## Konsep Inti

- **Barang (Item)** — unit yang dilacak sistem, dua jenis: **bahan baku** (dipakai buat produksi) dan **barang jadi** (yang akhirnya dijual ke customer). Semua barang, tanpa kecuali, pakai metode hitung biaya yang sama — Rata-Rata Tertimbang (lihat di bawah). Tiap barang punya **1 satuan dasar** (kg, pcs, dst) — dipakai buat semua pelacakan stok/biaya (pembelian, produksi, posisi stok). Satuan jual ke customer boleh beda dari satuan dasar ini (lihat submodule "Satuan Jual & Harga" di bawah).
- **Posisi stok per barang** — qty yang tersedia sekarang (di satuan dasar), plus harga rata-rata per satuan. Ini semacam "buku besar fisik" yang dipakai bareng-bareng oleh tiga alur di modul ini: beli (nambah), produksi (nambah barang jadi, ngurangin bahan baku), dan jual (ngurangin barang jadi). Diperbarui tiap kali ada barang masuk (harga rata-rata berubah) atau keluar (qty berkurang, harga rata-rata tetap). Bisa juga disesuaikan langsung ke hasil hitung fisik gudang lewat Stock Opname (lihat submodule di bawah).

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

### Purchase Order & Sales Order (Order) & Penerimaan Barang (3-Way Matching)

**Purchase Order dan Sales Order sekarang dipahami sebagai 1 konsep yang sama: "Order", cuma beda arah (beli vs jual)** — perubahan internal (2026-09-04), gak mengubah cara kerja yang user lihat sama sekali. Dulu keduanya kedengarannya beda tapi sebenarnya struktur & aturannya udah lama kembar (sama-sama cuma komitmen, sama-sama opsional, sama-sama bisa dibatalkan sebelum ada realisasi fisik) — begitu pemasok & customer juga udah dipahami sebagai 1 konsep yang sama (lihat modul Piutang/Utang: "pihak" yang bisa berperan pemasok dan/atau customer), gak ada lagi alasan Purchase Order dan Sales Order dianggap 2 hal yang beda-beda secara mendasar. Halaman/formulir di aplikasi **tetap 2 terpisah** (Purchase Order tetap punya halamannya sendiri, Sales Order juga) — ini keputusan tampilan yang sengaja dipertahankan, bukan cerminan bahwa keduanya masih 2 konsep berbeda di baliknya.

**Purchase Order sekarang opsional (2026-09-03)** — dulu setiap penerimaan barang wajib berasal dari Purchase Order yang sudah dibuat lebih dulu. Sekarang, mirip pola di sisi penjualan, penerimaan barang juga bisa dicatat **langsung tanpa Purchase Order** — cocok buat kasus beli dadakan (misal belanja langsung di toko, gak lewat proses pemesanan formal).

**Cara Kerja**
- Sebelum barang fisik berpindah tangan, biasanya ada tahap **komitmen** — sebuah Order: perusahaan memesan barang ke supplier (**Purchase Order/PO**) atau customer memesan barang dari perusahaan (**Sales Order/SO**), mencatat apa yang dipesan, berapa qty, dan harga yang disepakati. Order **belum mengubah apapun di General Ledger** — ini baru rencana/janji, belum kejadian akuntansi (belum ada pertukaran aset/liability, dan buat SO: belum ada piutang/pendapatan yang diakui, karena kewajiban baru dianggap terpenuhi pas kendali barang beneran berpindah, bukan pas dokumen dicetak). Tahap ini **opsional buat kedua arah** — bisa dilewati buat transaksi yang gak direncanakan (beli dadakan, atau jual spontan ke customer kios).
- Begitu barang fisik sampai (sisi beli), dicatat **Goods Receipt Note (GRN)** — bukti penerimaan riil, isinya qty & harga yang **benar-benar** diterima. Kalau GRN ini berasal dari PO, qty & harga bisa dicocokkan ke PO (bisa beda dari yang dipesan). Kalau GRN dibuat langsung tanpa PO, supplier dipilih manual saat itu juga, dan item/qty/harga diketik manual sepenuhnya. Di sisi jual, pemenuhan Order (Goods Issue) **bisa dicicil** — tiap kali sebagian barang dikirim, itu jadi 1 Goods Issue + 1 invoice tersendiri (bukan nunggu semua qty di SO terkirim baru invoice terbit sekali); piutang & pendapatan diakui persis sebesar barang yang beneran udah berpindah, gak lebih gak kurang.
- **3-way matching** (sisi beli) adalah praktik mencocokkan **3 dokumen**: PO (apa yang dipesan), GRN (apa yang diterima), dan Bill/Invoice dari supplier (apa yang ditagih) — berlaku kalau memang ada PO. Tujuannya mencegah: diterima kurang dari yang ditagih, harga beda dari kesepakatan, dan ditagih tanpa barang pernah diterima sama sekali.
- Idealnya, PO/GRN/Bill (atau SO/Goods Issue/Invoice) bisa terjadi di **waktu yang berbeda-beda**. Di skala yang lebih sederhana kayak sekarang, GRN dan Bill dianggap terjadi **bersamaan** (nota yang datang = bukti kirim + tagihan sekaligus) — ini menyederhanakan alur tanpa butuh akun perantara "Barang Diterima Belum Ditagih". Akun perantara itu baru beneran dibutuhkan kalau nanti proses pembeliannya berkembang sampai butuh jeda waktu — belum ada tekanan nyata buat itu sekarang.
- **Kenapa penerimaan barang (GRN) dan pengiriman barang (Goods Issue) TETAP 2 alur yang beda, walau Order-nya sekarang 1 konsep** — konsekuensi akuntansinya beneran beda: sisi beli cuma nambah Persediaan + Utang Usaha (1 jurnal), sisi jual bikin 2 jurnal sekaligus (Piutang/Pendapatan DAN HPP/Persediaan, titik HPP diakui — lihat submodule "Penjualan & Pengakuan HPP" di bawah). Menyatukan "komitmen"-nya masuk akal karena isinya beneran kembar (item, qty, harga, belum ada jurnal), tapi menyatukan "realisasinya" gak masuk akal karena efek pembukuannya beda total.

**Aturan Bisnis**
- Order (baik PO maupun SO) tidak boleh dianggap kejadian akuntansi — gak ada jurnal apa pun sampai barangnya beneran berpindah tangan (GRN buat beli, Goods Issue buat jual).
- Penerimaan barang yang berasal dari Purchase Order tidak boleh melebihi jumlah yang masih tersisa dari yang dipesan (per barang); pengiriman barang yang berasal dari Sales Order juga gak boleh melebihi qty yang dipesan di baris itu. Transaksi langsung tanpa Order (dari kedua sisi) gak punya batas pembanding ini sama sekali.
- Pembelian bahan baku selalu masuk Persediaan (aset), tidak pernah langsung jadi Beban.
- Penerimaan barang langsung (tanpa PO) wajib menyebutkan supplier secara manual — gak ada jalan lain buat tahu siapa yang ditagih.
- Order boleh **dibatalkan** selama belum ada realisasi fisik sama sekali terhadapnya — begitu sudah ada 1 GRN (buat PO) atau 1 Goods Issue (buat SO), Order itu gak bisa dibatalkan lagi (koreksi cukup bikin Order baru). Karena Order memang tidak pernah punya jurnal, membatalkannya juga tidak memunculkan jurnal pembalik apa pun — murni status akhir yang gak bisa diubah lagi.
- Order sama sekali tidak wajib buat kedua arah — transaksi tanpa tahap pemesanan (beli dadakan/jual spontan) tetap sah dan tidak perlu melalui Order.

**Skenario**
- Pesan bahan baku lewat PO, barang datang persis sesuai pesanan — Persediaan naik, harga rata-rata diperbarui, Utang Usaha muncul dari tagihan yang menyertai.
- Pesan bahan baku lagi, tapi harga saat diterima ternyata beda dari yang disepakati di PO — dicatat apa adanya (selisih harga informasional, gak diblokir), cuma qty yang dijaga ketat supaya gak melebihi pesanan.
- Belanja bahan baku dadakan di toko, gak sempat/gak perlu bikin PO dulu — langsung catat penerimaan barang, pilih supplier manual, item/qty/harga diketik langsung. Persediaan naik dan Utang Usaha muncul persis sama seperti jalur PO.
- Customer pesan 200 unit buat acara tertentu, stok gudang saat dipesan cuma 80 — Sales Order dibuat duluan tanpa jurnal apa pun. Produksi menambah stok belakangan. Barang dikirim 2 tahap (120 lalu 80) — masing-masing tahap memunculkan invoice terpisah, sampai total terkirim sama dengan yang dipesan.
- Customer kios beli langsung barang yang tersedia — tetap lewat jalur biasa (Goods Issue tanpa Sales Order), tidak ada perubahan dari sebelumnya.

**Common Mistakes**
- Menganggap Order (PO maupun SO) sebagai kejadian akuntansi (bikin jurnal) — Order cuma komitmen, jurnal baru muncul pas barang beneran berpindah tangan.
- Mencatat pembelian bahan baku langsung sebagai Beban/HPP — padahal itu masih aset sampai barangnya terjual.
- Menganggap Purchase Order masih wajib buat semua penerimaan barang — sekarang opsional, penerimaan langsung tanpa PO valid buat kasus beli dadakan.
- Menunda invoice sampai seluruh Sales Order terpenuhi — seharusnya tiap pengiriman langsung memunculkan invoice sendiri, sesuai barang yang benar-benar sudah berpindah saat itu.
- Memaksa semua penjualan melalui Sales Order dulu — Sales Order hanya relevan untuk pesanan yang direncanakan, bukan transaksi spontan.
- Menganggap Purchase Order dan Sales Order masih 2 hal yang beda secara mendasar — sekarang cuma beda arah dari 1 konsep Order yang sama; formulir/halamannya tetap kelihatan terpisah di aplikasi, tapi itu keputusan tampilan doang.

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
- Sisi jual sekarang **juga** punya tahap komitmen sebelum Goods Issue (Sales Order) — sekarang 1 konsep yang sama dengan Purchase Order (Order, cuma beda arah), lihat submodule "Purchase Order & Sales Order (Order) & Penerimaan Barang" di atas. Tahap ini **opsional**, karena penjualan punya 2 pola sekaligus (spontan dan terencana), gak kayak pembelian yang selalu direncanakan.
- **Catatan lintas modul (retur):** kalau barang yang terjual lewat Goods Issue ini diretur customer, sistem membalik sebagian stok+HPP secara proporsional, pakai harga pokok **snapshot asli** pas barang itu keluar (bukan harga sekarang) — detail penuh ada di dokumentasi Piutang Usaha (Retur Barang/Credit Note). Barang yang diretur diklasifikasi kondisinya per baris: **masih layak jual** (balik jadi stok normal) atau **rusak** (gak balik jadi stok, diakui sebagai Beban Kerugian Barang Rusak) — jadi barang rusak gak pernah lagi "seolah-olah" jadi stok bernilai.

**Aturan Bisnis**
- Pengurangan stok barang jadi (Goods Issue) tidak boleh melebihi qty yang tersedia.
- Goods Issue harus tertelusur ke invoice penjualan yang dibuat bersamaan.

**Skenario**
- Jual sejumlah barang jadi — HPP diakui dari harga rata-rata tertimbang barang jadi itu saat transaksi terjadi, laba kotor = harga jual dikurangi HPP.

**Common Mistakes**
- Menghitung HPP berdasarkan **kapan utang ke supplier dibayar**, bukan berdasarkan **kapan barangnya terjual** — dua hal yang sama sekali gak berhubungan. HPP baru diakui persis di titik Goods Issue ini, gak lebih cepat dan gak lebih lambat.

### Kategori & Brand Barang

**Cara Kerja**
- Seiring katalog barang bertambah banyak, staff butuh cara ngelompokin & nyari barang cepat — bukan cuma scroll manual di 1 tabel panjang. 2 atribut deskriptif ditambahkan ke barang: **Kategori** (pengelompokan jenis barang, mis. "Alat Makan"/"Perlengkapan Dapur") dan **Brand** (merek/pemasok lini produk, mis. "Lion Star"/"Maspion").
- Keduanya **katalog terkontrol** (dipilih dari daftar tetap, bukan teks bebas) — pola yang sama persis kayak katalog kategori biaya tambahan yang udah ada di AR/AP/POS (`ar_invoice_charge_types`, dst): daftar dikelola sendiri (nambah/nonaktifkan), barang tinggal pilih dari situ. Ini nyegah variasi tulisan yang beda-beda buat 1 hal yang sama ("Lion Star" vs "lion star" vs "LionStar") — kalau teks bebas, filter/pengelompokan jadi gak akurat karena string-nya gak persis sama.
- **Opsional, independen satu sama lain** — barang boleh gak punya kategori, gak punya brand, salah satu, atau keduanya. Barang lama (sebelum fitur ini) otomatis gak punya keduanya, gak perlu di-backfill paksa.
- **1 barang → maksimal 1 kategori, 1 brand** (bukan multi-kategori/tag) — cukup buat kebutuhan pengelompokan simpel, bukan sistem tagging.
- Murni metadata deskriptif — sama sekali gak menyentuh perhitungan stok/HPP/jurnal, gak ada RPC baru.

**Aturan Bisnis**
- Kategori dan brand masing-masing dikelola sebagai katalog independen (bisa dinonaktifkan tanpa dihapus, pola sama katalog lain) — barang yang udah kepilih ke kategori/brand yang dinonaktifkan tetap nunjukin nilainya (snapshot, gak ilang), cuma gak muncul lagi di pilihan buat barang baru.
- Menonaktifkan kategori atau brand gak mempengaruhi barang yang udah pernah dikaitkan ke situ.

**Skenario**
- Piring Plastik & Gelas Plastik dikategorikan "Alat Makan", brand "Maspion" (dari CV Sumber Plastik) — gampang difilter bareng pas nyari.
- Ember Plastik 10L dikategorikan "Perlengkapan Rumah Tangga", brand "Lion Star" (dari PT Plastindo Jaya).

**Common Mistakes**
- Bikin kategori/brand jadi teks bebas per barang (bukan katalog terkontrol) — variasi penulisan bikin filter/pengelompokan gak akurat.
- Mewajibkan tiap barang harus punya kategori/brand — barang lama & barang yang emang gak jelas mereknya (curah/racikan sendiri) harus tetap bisa disimpan tanpa keduanya.

### Satuan Jual & Harga (Multi Unit of Measure)

**Cara Kerja**
- Barang bisa dijual ke customer dalam **satuan yang beda dari satuan dasarnya**. Contoh: sebuah barang satuan dasarnya "pcs" (dipakai buat pelacakan stok), tapi bisa dijual per pcs ATAU per lusin (isi 12) — dua pilihan satuan jual, masing-masing punya harga sendiri.
- Tiap barang boleh (opsional) dikasih 1 atau lebih "satuan jual" — masing-masing punya **faktor konversi** ke satuan dasar (berapa satuan dasar = 1 satuan jual ini) dan **harga jual per satuan jual itu**. Satuan dasar sendiri juga terhitung sebagai "satuan jual" (faktor konversi 1) — jadi kalau barang cuma dijual dalam 1 satuan aja (kasus paling umum), cukup 1 baris data: satuan dasar + harganya.
- **Sisi stok/HPP SELALU dihitung di satuan dasar** — begitu customer pilih "beli 2 lusin", sistem otomatis konversi jadi qty satuan dasar (2 × 12 = 24 buah) SEBELUM ngurangin stok/ngitung HPP. Barang besar/kecil kemasannya, `avg_cost` dan posisi stok gak pernah "ngerti" satuan jual — cuma ngerti satuan dasar.
- **Harga per satuan jual itu independen, BUKAN hasil kali otomatis dari harga satuan dasar.** Harga per lusin biasanya dikasih diskon grosir (misal Rp22.000/lusin, bukan 12 × Rp2.000 = Rp24.000) — itu keputusan bisnis yang diisi manual per satuan jual, bukan dihitung sistem.
- Cuma relevan buat transaksi yang melibatkan barang fisik — invoice financial-only (jasa, atau barang yang gak dilacak stok) gak pernah nyentuh satuan tambahan sama sekali, karena emang gak ada referensi ke barang di situ.
- **Tiga pola input yang beda, tergantung internal vs jual vs beli (revisi 2026-08-14):**
  - **Internal** (qty produksi, hasil hitung fisik/Stock Opname): input qty bisa **campuran beberapa satuan sekaligus** dalam 1 baris (misal sebagian dus penuh, sebagian pack lepas, sebagian pcs satuan) — tiap satuan yang berlaku buat barang itu muncul sebagai kolom isian sendiri, sistem jumlahkan otomatis ke qty satuan dasar. Cocok di sini karena gak ada harga sama sekali yang perlu diurus — cuma soal konversi qty.
  - **Jual** (Sales Order, Jual Barang/Goods Issue): user pilih **1 satuan** dari satuan-satuan yang punya harga jual, lalu isi qty — harga otomatis muncul dari harga satuan itu, **gak ada lagi input harga manual sama sekali**. Barang yang belum punya satuan berharga gak bisa dipilih buat dijual sampai adminnya isi dulu harganya. Ini gantiin pola "input harga manual + tombol saran nominal" yang sebelumnya dipakai di sini — ketauan bikin bingung dan gak konsisten sama pola pemilihan satuan yang sudah dipakai di aplikasi kasir (POS) sejak awal.
  - **Beli** (Purchase Order, Terima Barang): user pilih **1 satuan** juga (dropdown SEMUA satuan barang itu, gak difilter yang punya harga jual), lalu isi qty **dan** harga beli MANUAL untuk satuan itu. Beda dari sisi jual: harga beli gak pernah otomatis, karena harga jual ke customer (yang tersimpan di data satuan barang) gak ada hubungannya sama harga beli dari supplier — sistem ini gak nyimpen "harga beli referensi" terpisah. Kalau 1 kali terima barang campur kemasan dengan harga beda per satuan, dipecah jadi beberapa baris (1 baris = 1 satuan).

**Aturan Bisnis**
- Tiap barang maksimal punya 1 "satuan dasar" (faktor konversi wajib 1) — sisanya boleh berapa pun satuan tambahan.
- Qty yang beneran dikonsumsi/ditambah ke stok SELALU di satuan dasar, gak peduli kombinasi/pilihan satuan apa yang dipakai user pas input.
- Harga tiap satuan independen — gak wajib proporsional ke harga satuan dasar. Nominal invoice/pesanan **otomatis diturunkan** dari harga satuan yang dipilih di sisi jual; nominal PO/Terima Barang tetap ketik manual (gak ada harga beli referensi tersimpan).
- Faktor konversi antar satuan 1 barang harus kelipatan bulat rapi dari satuan di bawahnya (mis. pcs=1, pack=12, box=144 — bukan box=100) — dijaga sistem otomatis, bukan cuma aturan penulisan data. Ini supaya layar posisi stok/kartu barang bisa menampilkan angka gabungan yang ringkas ("1 box, 2 pack, 4 pcs") tanpa nyisain pecahan gak presisi.

**Skenario**
- Barang dijual pakai satuan jual bukan satuan dasar (misal 1 lusin) — user pilih "lusin" di layar Sales Order/Goods Issue, harga otomatis muncul dari harga satuan itu (bisa beda dari harga satuan dasar × faktor konversi, biasanya diskon grosir), qty & harga dikonversi ke satuan dasar sebelum dicatat.
- Barang dibeli dalam satuan "dus" (bukan pcs lepasan) — user pilih "dus" di layar Purchase Order, isi qty & harga beli per dus sendiri (gak ada auto-fill), dikonversi ke satuan dasar sebelum dicatat.
- Barang punya 3 satuan: pcs (dasar), pack (isi 12), box (isi 144). User hitung barang ini (Stock Opname/qty produksi) dengan campuran 2 pcs + 2 pack + 0 box dalam 1 baris — sistem jumlahkan otomatis jadi 26 pcs (2×1 + 2×12 + 0×144) sebelum dicatat ke stok, user gak perlu hitung sendiri atau pura-pura semuanya 1 satuan.

**Common Mistakes**
- Nyimpen qty transaksi di satuan JUAL/BELI (misal "2", maksudnya 2 lusin) tanpa dikonversi ke satuan dasar — stok kelihatan cuma berkurang/bertambah dikit padahal fisiknya jauh lebih banyak, HPP juga keitung jauh lebih kecil dari seharusnya.
- Menghitung harga per satuan jual sebagai hasil kali otomatis dari harga satuan dasar (misal harga lusin dipaksa = 12 × harga per buah) — mengabaikan diskon grosir yang biasanya memang beda dari harga eceran. Harga tiap satuan diisi manual sekali di data master barang, bukan dihitung ulang tiap transaksi.
- Pakai pola "isi qty campur beberapa satuan sekaligus" di layar jual/beli (Sales Order/Goods Issue/Purchase Order) — itu cocoknya buat internal doang. Jual butuh pilih 1 satuan biar harga bisa otomatis muncul; beli butuh pilih 1 satuan biar harganya jelas per baris (bisa beda-beda per satuan).
- Nyoba samain harga beli dari supplier dengan harga jual ke customer yang tersimpan di data satuan barang — dua hal yang gak berhubungan, harga beli PO/Terima Barang selalu ketik manual.

### Kode Scan Barang (Barcode/QR per Satuan Jual)

**Cara Kerja**
- Kasir toko fisik butuh cara cepat identifikasi barang pas checkout — scan kode di kemasan, bukan cari manual satu-satu dari katalog. Tiap **satuan jual** (bukan barang secara umum) boleh, opsional, dikasih 1 kode scan unik — konsisten sama alasan kenapa harga & faktor konversi juga per satuan jual di submodule sebelumnya: kemasan fisik beda (dus vs pcs) biasanya punya label/barcode beda juga di dunia nyata. Kalau kode ditaruh di level barang (bukan per satuan), scan gak bisa langsung tau satuan mana yang lagi dipegang kasir.
- Kode bisa dari 2 sumber, dan sistem memperlakukan keduanya **sama persis** — cuma teks yang dicocokkan pas scan, gak peduli asal-usulnya:
  - **Barcode pabrik** — barang bermerek yang udah ada label EAN-13/UPC dari produsen, tinggal discan & disimpan apa adanya pas input satuan jual itu.
  - **Kode internal** — buat barang yang gak punya label pabrik (barang curah, racikan sendiri, atau produk lokal kecil yang emang gak pernah didaftarin ke standar barcode resmi). Sistem sediakan tombol generate kode urutan internal (format `SKU-2026-00001`, sama polanya kayak nomor dokumen lain di sistem ini) + render QR siap-print langsung dari halaman barang, tanpa perlu aplikasi/alat cetak label terpisah.
- Gak ada validasi format ketat (EAN-13/UPC checksum dst) — kolomnya nerima teks apa aja, karena kode QR yang digenerate sendiri emang gak wajib ikutin standar retail resmi.
- Gak wajib diisi — barang/satuan yang gak pernah discan (dijual manual, ditimbang, atau dipilih dari katalog POS seperti sebelumnya) boleh dibiarkan kosong selamanya, gak ada dampak ke bagian modul lain.

**Aturan Bisnis**
- Kode scan harus unik lintas SELURUH satuan jual (gak boleh 2 barang/satuan beda punya kode yang sama) — kalau bentrok, scan jadi ambigu dan bisa keliru nge-charge harga barang lain.
- Kode scan gak wajib diisi buat tiap satuan jual, dan gak ada aturan "kalau 1 satuan barang X punya kode, semua satuan barang X juga harus punya" — independen per baris.
- Kode scan murni identitas lookup, sama sekali gak menyentuh perhitungan stok/HPP/jurnal — mengubah atau menghapus kode gak berdampak retroaktif ke transaksi yang udah pernah pakai satuan itu (transaksi udah menyimpan qty & harga hasil resolusinya sendiri, gak balik nunjuk ke kode).

**Skenario**
- Piring Plastik dijual 3 satuan: pcs, lusin, pack isi 6. Toko Makmur Jaya cuma bikinin kode buat "pack isi 6" (paling sering dijual retail & discan) — pcs dan lusin dibiarkan tanpa kode, tetap dijual manual lewat katalog seperti biasa.
- Ember Plastik 10L gak ada barcode dari PT Plastindo Jaya (pabrik plastik lokal kecil). Pak Herman generate kode internal dari sistem, cetak label QR-nya, tempel ke rak/kemasan ember — Mbak Rina discan kode itu di kasir buat checkout cepat.

**Common Mistakes**
- Nyimpen kode scan di level barang (bukan per satuan jual) — begitu barang itu ternyata dijual >1 satuan (kemasan fisiknya beda-beda), sistem cuma bisa nyimpen 1 kode padahal tiap kemasan biasanya punya kode/label sendiri-sendiri, scan jadi gak bisa bedain satuan mana yang lagi discan.
- Mewajibkan format ketat (EAN-13/UPC numerik + checksum) buat semua kode — menolak kode generate-sendiri (apalagi QR yang bisa encode teks bebas) yang emang gak dirancang ikutin standar itu.

### Stock Opname (Penyesuaian Stok Fisik)

**Cara Kerja**
- Semua transaksi stok yang udah dibahas (beli, produksi, jual, retur, write-off) itu **tercatat lewat kejadian yang jelas**. Tapi ada 1 sumber selisih yang gak pernah lewat transaksi apa pun: susut alami, salah catat lama, atau kehilangan tanpa penjelasan pasti. Stock Opname = proses hitung fisik stok gudang secara berkala, dibandingkan ke posisi stok yang tercatat di sistem, lalu **sistem disesuaikan mengikuti hasil hitung fisik** — karena fisiknya itu kebenaran, bukan sebaliknya.
- Beda mendasar dari retur/write-off: opname **gak menempel ke 1 transaksi tertentu**. Dokumen sumbernya justru **hasil hitung fisik itu sendiri** (kapan dihitung, siapa yang hitung), bukan nunjuk ke invoice/bill/credit note manapun.
- Selisih bisa 2 arah, masing-masing diakui ke akun **terpisah** (bukan digabung/netting) — biar laporan tetap nunjukin rincian per item, bukan cuma hasil akhir gabungan:
  - **Kurang** (fisik < sistem) — kerugian, diakui sebagai beban:
    ```
    Debit Beban Selisih Persediaan
      Kredit Persediaan (Bahan Baku/Barang Jadi, sesuai jenis barangnya)
    ```
  - **Lebih** (fisik > sistem) — biasanya ada penerimaan/kejadian lama yang kelewat dicatat, diakui sebagai pendapatan:
    ```
    Debit Persediaan (Bahan Baku/Barang Jadi, sesuai jenis barangnya)
      Kredit Pendapatan Selisih Persediaan
    ```
- Nilai selisih dihitung dari **harga rata-rata berjalan barang itu saat opname terjadi** (bukan harga historis) — konsisten sama cara Rata-Rata Tertimbang bekerja di modul ini (gak nyimpen asal-usul per batch).
- 1 sesi opname boleh mencakup banyak barang sekaligus (misal hitung fisik seluruh gudang hari yang sama) — tiap barang punya arah selisihnya sendiri-sendiri, gak di-*netting* jadi 1 angka gabungan sebelum dijurnal. Barang yang hasil hitungnya **PAS** (gak ada selisih) gak menghasilkan catatan apa pun — gak ada yang perlu disesuaikan.
- Cuma qty yang disesuaikan — harga rata-rata berjalan barang itu **tidak berubah** (opname soal jumlah fisik, bukan soal harga per unit).

**Aturan Bisnis**
- Selisih kurang dan lebih diakui ke akun terpisah (Beban vs Pendapatan Selisih Persediaan), gak digabung jadi 1 angka bersih.
- Nilai selisih dihitung dari harga rata-rata berjalan barang itu saat opname, bukan harga historis.
- Barang tanpa selisih (hasil hitung fisik = catatan sistem) gak menghasilkan pencatatan apa pun.
- Opname gak boleh dicatat ke periode akuntansi yang udah ditutup — soal integritas pembukuan umum, bukan aturan khusus opname.

**Skenario**
- Opname 1 sesi, banyak barang sekaligus — sebagian barang selisih kurang (jadi beban), sebagian selisih lebih (jadi pendapatan), sebagian pas (gak ada catatan) — masing-masing diproses independen sesuai arahnya sendiri.

**Common Mistakes**
- Menggabungkan (netting) semua selisih dalam 1 sesi opname jadi 1 angka bersih sebelum dijurnal — kehilangan rincian per barang, gak bisa lagi lihat "barang apa yang sebenarnya hilang" vs "barang apa yang ternyata lebih".
- Memakai harga historis (harga pas barang itu pertama masuk) buat menghitung nilai selisih — harusnya harga rata-rata berjalan yang berlaku SAAT opname terjadi.
- Mencatat opname lewat jalur transaksi yang udah ada (retur, write-off, goods issue) — opname gak punya "lawan transaksi" (customer/supplier) sama sekali, butuh jalur sendiri.

### Kartu Stok / Riwayat Mutasi per Item

**Cara Kerja**
- Semua submodule di atas (beli, produksi, jual, retur, write-off, opname) masing-masing sudah nyatet transaksinya sendiri-sendiri. Tapi posisi stok yang ditampilkan ke user cuma nunjukin **saldo akhir** — persis rekening bank yang cuma nunjukin "Saldo: Rp 5.000.000" tanpa daftar transaksi apa pun. Kalau saldo suatu barang kelihatan gak sesuai ekspektasi, gak ada cara langsung menjawab "kenapa segini" tanpa buka manual satu-satu ke setiap jenis transaksi yang mungkin menyentuh barang itu.
- Kartu Stok menutup ini — klik 1 barang, lihat **riwayat kronologis** semua kejadian yang menggerakkan qty barang itu (tanggal, jenis kejadian, dokumen sumbernya, qty masuk/keluar, saldo berjalan setelah baris itu) — persis buku tabungan: tiap baris nunjukin transaksi + saldo setelahnya, bukan cuma angka akhir.
- Ini murni **lapisan riwayat/audit trail** di atas posisi stok yang sudah ada — bukan cara baru menghitung qty/HPP. Posisi stok (qty & harga rata-rata berjalan) tetap dihitung dan disimpan persis seperti sebelumnya, gak berubah oleh fitur ini.
- Tiap baris riwayat tertelusur balik ke dokumen sumber aslinya (invoice penjualan, bukti terima barang, production order, dst) — konsisten sama prinsip semua transaksi harus tertelusur ke dokumen sumber.

**Aturan Bisnis**
- Kartu Stok gak pernah jadi sumber kebenaran baru buat qty atau HPP — cuma cerminan dari transaksi yang udah tercatat di modul lain. Kalau suatu saat ada perbedaan antara jumlah riwayat dan saldo akhir yang tercatat, saldo akhir yang dianggap benar — riwayatnya yang harus diperbaiki, bukan sebaliknya.
- Riwayat mencakup SEMUA jenis kejadian yang bisa menggerakkan stok barang, bukan cuma jalur transaksi inti (beli/produksi/jual) — termasuk juga retur (dari customer maupun ke supplier), barang rusak yang ditulis-jadi-beban, penggantian garansi, dan penyesuaian hasil hitung fisik.

**Skenario**
- Pemilik curiga stok Tepung Terigu turun drastis padahal gak inget ada penjualan besar bulan ini — buka Kartu Stok barang itu, lihat baris demi baris: sekian kilo masuk dari pembelian, sekian kilo keluar buat produksi, ada penyesuaian opname karena selisih hitung fisik — penyebabnya ketahuan tanpa perlu buka satu-satu halaman transaksi yang berbeda-beda.

**Common Mistakes**
- Menganggap Kartu Stok sebagai sumber kebenaran baru buat saldo stok — posisi stok (qty & harga rata-rata berjalan) yang sudah ada tetap yang utama, Kartu Stok cuma riwayat pendukung yang menjelaskan bagaimana angka itu terbentuk.
