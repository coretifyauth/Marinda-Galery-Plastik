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

**Metode yang Dipakai: Rata-Rata Tertimbang, Satu-Satunya**

Rata-Rata Tertimbang adalah satu-satunya metode costing yang dipakai sistem — berlaku buat semua barang tanpa kecuali, termasuk yang harganya fluktuatif. Alasannya: rata-rata berjalan tetap merefleksikan perubahan harga (kenaikan/penurunan langsung kebawa ke harga rata-rata pas penerimaan baru), cuma gak sepresisi FIFO di level per-batch — trade-off yang diterima demi struktur data & logika yang jauh lebih sederhana, dianggap sepadan buat skala bisnis ini. Pembelian bahan baku sendiri selalu nambah Persediaan (aset) — gak pernah langsung dicatat sebagai Beban, apa pun metode costing-nya.

### Purchase Order & Sales Order (Order) & Penerimaan Barang (3-Way Matching)

**Purchase Order dan Sales Order dipahami sebagai 1 konsep yang sama: "Order", cuma beda arah (beli vs jual).** Strukturnya kembar (sama-sama cuma komitmen, sama-sama opsional, sama-sama bisa dibatalkan sebelum ada realisasi fisik) — konsisten dengan pemasok & customer yang juga dipahami sebagai 1 konsep yang sama (lihat modul Piutang/Utang: "pihak" yang bisa berperan pemasok dan/atau customer). Halaman/formulir di aplikasi **tetap 2 terpisah** (Purchase Order punya halamannya sendiri, Sales Order juga) — ini keputusan tampilan, bukan cerminan bahwa keduanya 2 konsep berbeda di baliknya.

**Purchase Order opsional** — mirip pola di sisi penjualan, penerimaan barang juga bisa dicatat **langsung tanpa Purchase Order** — cocok buat kasus beli dadakan (misal belanja langsung di toko, gak lewat proses pemesanan formal).

**Cara Kerja**
- Sebelum barang fisik berpindah tangan, biasanya ada tahap **komitmen** — sebuah Order: perusahaan memesan barang ke supplier (**Purchase Order/PO**) atau customer memesan barang dari perusahaan (**Sales Order/SO**), mencatat apa yang dipesan, berapa qty, dan harga yang disepakati. Order **belum mengubah apapun di General Ledger** — ini baru rencana/janji, belum kejadian akuntansi (belum ada pertukaran aset/liability, dan buat SO: belum ada piutang/pendapatan yang diakui, karena kewajiban baru dianggap terpenuhi pas kendali barang beneran berpindah, bukan pas dokumen dicetak). Tahap ini **opsional buat kedua arah** — bisa dilewati buat transaksi yang gak direncanakan (beli dadakan, atau jual spontan ke customer kios).
- Begitu barang fisik sampai (sisi beli), dicatat **Goods Receipt Note (GRN)** — bukti penerimaan riil, isinya qty & harga yang **benar-benar** diterima. Kalau GRN ini berasal dari PO, qty & harga bisa dicocokkan ke PO (bisa beda dari yang dipesan). Kalau GRN dibuat langsung tanpa PO, supplier dipilih manual saat itu juga, dan item/qty/harga diketik manual sepenuhnya. Di sisi jual, pemenuhan Order (Goods Issue) **bisa dicicil** — tiap kali sebagian barang dikirim, itu jadi 1 Goods Issue + 1 invoice tersendiri (bukan nunggu semua qty di SO terkirim baru invoice terbit sekali); piutang & pendapatan diakui persis sebesar barang yang beneran udah berpindah, gak lebih gak kurang.
- **3-way matching** (sisi beli) adalah praktik mencocokkan **3 dokumen**: PO (apa yang dipesan), GRN (apa yang diterima), dan Bill/Invoice dari supplier (apa yang ditagih) — berlaku kalau memang ada PO. Tujuannya mencegah: diterima kurang dari yang ditagih, harga beda dari kesepakatan, dan ditagih tanpa barang pernah diterima sama sekali.
- PO/GRN/Bill (atau SO/Goods Issue/Invoice) bisa terjadi di **waktu yang berbeda-beda**. Di sisi beli, barang masuk dan tagihan sekarang **dipisah**: barang sering datang duluan, nota menyusul, dan jeda itu ditampung di akun perantara "Barang Diterima Belum Ditagih" — lihat submodule "Barang Masuk Belum Ditagih" di bawah.
- **Kenapa penerimaan barang (GRN) dan pengiriman barang (Goods Issue) TETAP 2 alur yang beda, walau Order-nya sekarang 1 konsep** — konsekuensi akuntansinya beneran beda: sisi beli cuma nambah Persediaan lawan Utang Usaha, atau lawan Barang Diterima Belum Ditagih kalau nota belum datang (1 jurnal), sisi jual bikin 2 jurnal sekaligus (Piutang/Pendapatan DAN HPP/Persediaan, titik HPP diakui — lihat submodule "Penjualan & Pengakuan HPP" di bawah). Menyatukan "komitmen"-nya masuk akal karena isinya beneran kembar (item, qty, harga, belum ada jurnal), tapi menyatukan "realisasinya" gak masuk akal karena efek pembukuannya beda total.

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
- Belanja bahan baku dadakan di toko, gak sempat/gak perlu bikin PO dulu — langsung catat penerimaan barang, pilih supplier manual, item/qty/harga diketik langsung. Persediaan naik; Utang Usaha muncul saat tagihannya dibuat (bisa langsung atau menyusul, lihat submodule "Barang Masuk Belum Ditagih"), persis sama seperti jalur PO.
- Customer pesan 200 unit buat acara tertentu, stok gudang saat dipesan cuma 80 — Sales Order dibuat duluan tanpa jurnal apa pun. Produksi menambah stok belakangan. Barang dikirim 2 tahap (120 lalu 80) — masing-masing tahap memunculkan invoice terpisah, sampai total terkirim sama dengan yang dipesan.
- Customer kios beli langsung barang yang tersedia — tetap lewat jalur biasa (Goods Issue tanpa Sales Order).

**Common Mistakes**
- Menganggap Order (PO maupun SO) sebagai kejadian akuntansi (bikin jurnal) — Order cuma komitmen, jurnal baru muncul pas barang beneran berpindah tangan.
- Mencatat pembelian bahan baku langsung sebagai Beban/HPP — padahal itu masih aset sampai barangnya terjual.
- Menganggap Purchase Order masih wajib buat semua penerimaan barang — sekarang opsional, penerimaan langsung tanpa PO valid buat kasus beli dadakan.
- Menunda invoice sampai seluruh Sales Order terpenuhi — seharusnya tiap pengiriman langsung memunculkan invoice sendiri, sesuai barang yang benar-benar sudah berpindah saat itu.
- Memaksa semua penjualan melalui Sales Order dulu — Sales Order hanya relevan untuk pesanan yang direncanakan, bukan transaksi spontan.
- Menganggap Purchase Order dan Sales Order masih 2 hal yang beda secara mendasar — sekarang cuma beda arah dari 1 konsep Order yang sama; formulir/halamannya tetap kelihatan terpisah di aplikasi, tapi itu keputusan tampilan doang.

### Barang Masuk Belum Ditagih (Goods Received Not Invoiced)

**Masalahnya:** barang dari supplier sering datang **duluan**, nota/faktur resminya menyusul beberapa hari kemudian (kadang dengan harga yang sedikit beda dari perkiraan). Kalau pencatatan barang masuk dan tagihan dipaksa jadi satu langkah, ada dua pilihan buruk: nunggu nota baru input (barang sudah ada di rak tapi stok sistem 0, gak bisa dijual, dan Neraca akhir bulan kurang akurat), atau input duluan dengan harga tebakan lalu tagihan terpaksa salah. Submodule ini **memisahkan dua kejadian itu**: *barang masuk* (kejadian fisik) dan *tagihan* (kejadian finansial) bisa terjadi di waktu berbeda. Cakupan: penerimaan langsung tanpa Purchase Order (jalur PO ikut pola yang sama).

**Cara Kerja**
- **Barang masuk dicatat tanpa tagihan.** Supplier, nomor surat jalan, item, qty, dan **harga perkiraan** (diketik manual; boleh diisi 0 kalau memang belum tahu) dicatat saat barang diterima. Stok fisik langsung bertambah dan barang bisa dijual. Jurnalnya: Debit **Persediaan**, Kredit **Barang Diterima Belum Ditagih**. Akun kredit ini sengaja bukan Utang Usaha — Utang Usaha adalah kewajiban resmi per supplier (punya nomor nota, jatuh tempo, bisa dibayar), sedangkan di tahap ini notanya belum ada, jadi belum ada yang bisa dibayar. Kewajiban sudah lahir (barangnya sudah dipegang), tapi ditampung dulu di akun perantara sampai nota datang. Kalau harga diisi 0, gak ada nilai yang dijurnal. **Harga rata-rata (avg cost) item belum berubah** di tahap ini.
- **Harga dan diskon bisa direvisi selama belum ditagih.** Tiap revisi menaikkan nomor revisi; jurnal revisi sebelumnya **dibalik** (bertanggal hari revisi dilakukan, bukan tanggal barang datang) lalu dibuat jurnal baru sebesar nilai terbaru: Debit Persediaan, Kredit Barang Diterima Belum Ditagih. Yang boleh direvisi hanya harga, diskon, dan nomor surat jalan — bukan item maupun qty (salah item/qty: batalkan barang masuknya lalu catat ulang). Revisi gak menyentuh stok maupun avg cost.
- **Tagihan dibuat dengan dua mode:** *tagihan langsung* (seperti sebelumnya, gak berkaitan dengan barang masuk) atau *tagihan dari barang masuk*. Di mode kedua, user memilih supplier, lalu memilih satu atau beberapa barang masuk milik supplier itu yang belum tertagih — tiap pilihan menampilkan nominal tagihannya dengan jelas. Jurnalnya: Debit **Barang Diterima Belum Ditagih**, Kredit **Utang Usaha** (ditambah pajak dan biaya tambahan nota seperti tagihan biasa). Begitu semua barang masuk ditagih, saldo akun perantara kembali nol.
- **Avg cost baru dihitung saat tagihan dibuat.** Barang masuk yang belum ditagih belum ikut dihitung dalam harga rata-rata, jadi barang berharga perkiraan (atau 0) gak "mengencerkan" biaya stok yang sudah ada. Selama masa tunggu, penjualan memakai avg cost terakhir.
- **Kalau barang terjual di masa tunggu**, stok yang sudah ditagih dianggap habis lebih dulu, lalu barang masuk belum ditagih yang paling lama. HPP penjualan itu memakai avg cost yang berlaku saat itu dan **tidak pernah dikoreksi lagi**. Selisih biaya milik unit yang sudah terjual (karena harga nota beda dari avg cost saat itu) dicatat sebagai **koreksi HPP di periode saat tagihan dibuat** — HPP lama tetap tidak diubah, dan stok yang masih tersisa dinilai dengan harga nota.
- **Daftar barang masuk memberi penanda merah "belum tertagih"** (lengkap dengan umurnya), supaya gak ada barang yang lupa ditagih. Barang masuk berharga 0 juga diberi penanda sendiri.
- **Pembatalan.** Tagihan yang dibatalkan membuat barang masuknya kembali berstatus belum tertagih (stok tetap). Barang masuk yang belum ditagih bisa dibatalkan terpisah (jurnal dibalik, stok dikurangi) selama stoknya masih cukup.

**Aturan Bisnis**
- Mencatat barang masuk **tidak** otomatis membuat tagihan.
- Satu tagihan hanya boleh menggabungkan barang masuk dari **supplier yang sama**. Satu barang masuk ditagih **utuh** dan paling banyak oleh **satu** tagihan aktif — gak bisa ditagih sebagian, gak bisa ditagih dua kali. Satu tagihan boleh menutup banyak barang masuk. Kalau supplier menagih satu kiriman dalam dua nota, barang masuknya harus dicatat terpisah sejak diterima.
- Nominal tagihan dari barang masuk = jumlah nilai barang masuk terpilih (setelah revisi). Selisih antara perkiraan dan nota diselesaikan lewat revisi **sebelum** menagih, bukan di tagihan.
- Barang masuk berharga 0 harus direvisi (diberi harga) dulu sebelum bisa ditagih.
- Revisi hanya selama belum ditagih; begitu ditagih, barang masuk itu terkunci. Revisi selalu bertanggal hari revisi dilakukan, jadi periode yang sudah ditutup gak pernah tersentuh.
- Item yang avg cost-nya masih **nol** gak bisa dijual, dikonsumsi produksi, ditukar, ataupun diretur ke supplier — biaya pokoknya belum diketahui. Item yang avg cost-nya sudah ada boleh dijual meski ada barang masuknya yang belum ditagih.
- HPP penjualan yang sudah tercipta gak diubah.
- **Data lama tetap berlaku apa adanya.** Barang masuk yang dicatat sebelum fitur ini dianggap sudah ditagih sejak awal oleh tagihan yang dibuat bersamanya: jurnalnya (Persediaan lawan Utang Usaha) gak diubah, gak melewati akun Barang Diterima Belum Ditagih, gak punya revisi, dan gak pernah muncul sebagai "belum tertagih". Stok dan avg cost yang sudah ada dianggap seluruhnya sudah ditagih. Retur ke supplier dan pembatalan tagihan atas data lama tetap berjalan seperti sebelumnya.
- **Item lama yang stoknya ada tapi avg cost-nya nol** terkena aturan "avg cost nol gak bisa dijual" begitu fitur ini aktif. Kondisi ini harus dicek di data yang ada sebelum fitur diaktifkan, dan diputuskan satu per satu (mis. diberi biaya lewat penyesuaian) — bukan dibiarkan terblokir diam-diam di kasir.
- Saldo Barang Diterima Belum Ditagih = nilai barang yang sudah diterima tapi belum bernota. Saldonya harus kembali nol begitu semuanya ditagih; saldo yang menggantung berarti ada nota yang belum datang atau lupa dicatat.
- **Diskon pembelian** diisi di barang masuk, di dua level: per item (helper di layar — jumlahnya otomatis terakumulasi ke diskon header) dan per dokumen. Diskon header gak boleh lebih kecil dari jumlah diskon item; selisih lebihnya dianggap diskon tambahan level dokumen, dibagi ke barisnya sebanding nilai. Diskon item dihitung langsung ke biaya bersih item itu, jadi avg cost per item mencerminkan diskon item yang sebenarnya.

**Skenario**
- 40 pcs sudah ada (ditagih, avg cost Rp10.000). Senin masuk 100 pcs perkiraan Rp10.000, belum ada nota → Persediaan dan Barang Diterima Belum Ditagih sama-sama naik Rp1.000.000, avg cost tetap Rp10.000. Selasa terjual 60 pcs dengan HPP Rp10.000 per pcs. Kamis nota datang Rp10.200 → harga direvisi (jurnal Senin dibalik, dibuat jurnal baru Rp1.020.000), lalu tagihan dibuat dari barang masuk itu (Barang Diterima Belum Ditagih jadi nol, Utang Usaha Rp1.020.000). Avg cost baru Rp10.200 untuk 80 pcs sisa (nilai Rp816.000). HPP Selasa tetap Rp600.000; selisih Rp4.000 milik 20 pcs yang sudah terjual lebih dulu (selisih Rp200 per pcs) dicatat sebagai koreksi HPP hari tagihan (Debit HPP / Kredit Persediaan Rp4.000).
- Item baru, barang masuk pertama dengan harga 0 → avg cost nol, jadi barang belum bisa dijual sampai harganya direvisi dan ditagih. Hasil akhir avg cost bersih tanpa selisih.
- Supplier mengantar 3 kali dalam sebulan, menagih sekali di akhir bulan → ketiga barang masuk dipilih dalam satu tagihan.
- Tagihan dibatalkan karena nota salah → barang masuknya kembali "belum tertagih" (merah), tagihan baru dibuat setelah nota dikoreksi.

**Common Mistakes**
- Mengkredit Utang Usaha saat barang masuk — nota belum ada, bukan kewajiban resmi yang bisa dibayar.
- Membiarkan saldo Barang Diterima Belum Ditagih menggantung — selalu cocokkan dengan daftar barang masuk berpenanda merah.
- Mengira revisi harga mengubah HPP penjualan yang sudah terjadi — gak; HPP lama tetap; selisih unit yang sudah terjual dicatat sebagai koreksi HPP di periode tagihan, dan stok yang tersisa dinilai harga nota.
- Menagih satu barang masuk dengan dua tagihan, atau menggabungkan barang masuk dari supplier berbeda dalam satu tagihan — keduanya ditolak.
- Menganggap harga 0 "gratis" — 0 hanya artinya "belum tahu"; barang tidak bisa dijual dan tidak bisa ditagih sebelum diberi harga.
- Menganggap diskon item di layar tersimpan sebagai master data — itu hanya alat bantu hitung; yang tersimpan adalah diskon per baris pada barang masuk.

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
- Kebalikan dari penerimaan barang: pas barang jadi **keluar** dari gudang karena terjual, dicatat **Goods Issue** — qty barang jadi yang keluar, dan **biaya pokoknya** (dihitung dari harga rata-rata tertimbang barang jadi itu). Dibuat **bersamaan** dengan invoice penjualan (beda dengan sisi beli, di mana barang masuk dan tagihan sekarang bisa terpisah waktunya). Inilah titik di mana HPP akhirnya **diakui** — dua jurnal jalan bersamaan:
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
- Keduanya **katalog terkontrol** (dipilih dari daftar tetap, bukan teks bebas) — pola yang sama persis kayak katalog kategori biaya tambahan yang udah ada di AR/AP/POS (`charge_categories`): daftar dikelola sendiri (nambah/nonaktifkan), barang tinggal pilih dari situ. Ini nyegah variasi tulisan yang beda-beda buat 1 hal yang sama ("Lion Star" vs "lion star" vs "LionStar") — kalau teks bebas, filter/pengelompokan jadi gak akurat karena string-nya gak persis sama.
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
- **Tiga pola input yang beda, tergantung internal vs jual vs beli:**
  - **Internal** (qty produksi, hasil hitung fisik/Stock Opname): input qty bisa **campuran beberapa satuan sekaligus** dalam 1 baris (misal sebagian dus penuh, sebagian pack lepas, sebagian pcs satuan) — tiap satuan yang berlaku buat barang itu muncul sebagai kolom isian sendiri, sistem jumlahkan otomatis ke qty satuan dasar. Cocok di sini karena gak ada harga sama sekali yang perlu diurus — cuma soal konversi qty.
  - **Jual** (Sales Order, Jual Barang/Goods Issue): user pilih **1 satuan** dari satuan-satuan yang punya harga jual, lalu isi qty — harga otomatis muncul dari harga satuan itu, **gak ada input harga manual sama sekali**. Barang yang belum punya satuan berharga gak bisa dipilih buat dijual sampai adminnya isi dulu harganya. Pola ini konsisten dengan pemilihan satuan yang dipakai di aplikasi kasir (POS).
  - **Beli** (Purchase Order, Terima Barang): user pilih **1 satuan** juga (dropdown SEMUA satuan barang itu, gak difilter yang punya harga jual), lalu isi qty **dan** harga beli MANUAL untuk satuan itu. Beda dari sisi jual: harga beli gak pernah otomatis, karena harga jual ke customer (yang tersimpan di data satuan barang) gak ada hubungannya sama harga beli dari supplier — sistem ini gak nyimpen "harga beli referensi" terpisah. Kalau 1 kali terima barang campur kemasan dengan harga beda per satuan, dipecah jadi beberapa baris (1 baris = 1 satuan).

**Aturan Bisnis**
- Tiap barang maksimal punya 1 "satuan dasar" (faktor konversi wajib 1) — sisanya boleh berapa pun satuan tambahan.
- Qty yang beneran dikonsumsi/ditambah ke stok SELALU di satuan dasar, gak peduli kombinasi/pilihan satuan apa yang dipakai user pas input.
- Harga tiap satuan independen — gak wajib proporsional ke harga satuan dasar. Nominal invoice/pesanan **otomatis diturunkan** dari harga satuan yang dipilih di sisi jual; nominal PO/Terima Barang tetap ketik manual (gak ada harga beli referensi tersimpan).
- Faktor konversi tiap satuan harus bilangan bulat (gak boleh pecahan), tapi antar satuan 1 barang **tidak wajib kelipatan satu sama lain** — mis. lembar=1, bungkus=100, pack=1000, sak=19.200 boleh walau sak bukan kelipatan pack (ikut kemasan nyata di gudang). Layar posisi stok/kartu barang tetap menampilkan angka gabungan ("1 sak, 8 bungkus") dengan mengambil satuan terbesar dulu lalu sisanya ke satuan lebih kecil; hasilnya selalu tepat, hanya kombinasi satuannya bisa kurang ringkas kalau faktornya gak nested.

**Skenario**
- Barang dijual pakai satuan jual bukan satuan dasar (misal 1 lusin) — user pilih "lusin" di layar Sales Order/Goods Issue, harga otomatis muncul dari harga satuan itu (bisa beda dari harga satuan dasar × faktor konversi, biasanya diskon grosir), qty & harga dikonversi ke satuan dasar sebelum dicatat.
- Barang dibeli dalam satuan "dus" (bukan pcs lepasan) — user pilih "dus" di layar Purchase Order, isi qty & harga beli per dus sendiri (gak ada auto-fill), dikonversi ke satuan dasar sebelum dicatat.
- Barang punya 3 satuan: pcs (dasar), pack (isi 12), box (isi 144). User hitung barang ini (Stock Opname/qty produksi) dengan campuran 2 pcs + 2 pack + 0 box dalam 1 baris — sistem jumlahkan otomatis jadi 26 pcs (2×1 + 2×12 + 0×144) sebelum dicatat ke stok, user gak perlu hitung sendiri atau pura-pura semuanya 1 satuan.

**Common Mistakes**
- Nyimpen qty transaksi di satuan JUAL/BELI (misal "2", maksudnya 2 lusin) tanpa dikonversi ke satuan dasar — stok kelihatan cuma berkurang/bertambah dikit padahal fisiknya jauh lebih banyak, HPP juga keitung jauh lebih kecil dari seharusnya.
- Menghitung harga per satuan jual sebagai hasil kali otomatis dari harga satuan dasar (misal harga lusin dipaksa = 12 × harga per buah) — mengabaikan diskon grosir yang biasanya memang beda dari harga eceran. Harga tiap satuan diisi manual sekali di data master barang, bukan dihitung ulang tiap transaksi.
- Pakai pola "isi qty campur beberapa satuan sekaligus" di layar jual/beli (Sales Order/Goods Issue/Purchase Order) — itu cocoknya buat internal doang. Jual butuh pilih 1 satuan biar harga bisa otomatis muncul; beli butuh pilih 1 satuan biar harganya jelas per baris (bisa beda-beda per satuan).
- Nyoba samain harga beli dari supplier dengan harga jual ke customer yang tersimpan di data satuan barang — dua hal yang gak berhubungan, harga beli PO/Terima Barang selalu ketik manual.

### Kode Scan Barang (Barcode/QR per Barang & per Satuan Jual)

**Cara Kerja**
- Kasir toko fisik butuh cara cepat identifikasi barang pas checkout — scan kode di kemasan, bukan cari manual satu-satu dari katalog. Ada **2 level kode scan**, keduanya opsional dan bisa dipakai bareng:
  - **Kode barang** (1 kode per barang) — buat barang tanpa label pabrik per kemasan (kasus umum toko plastik: ikat/bal/dus dikemas sendiri). Admin cukup cetak **1 label** per barang, bukan 1 label per satuan. Scan kode ini masuk keranjang dalam **satuan jual default** barang itu (lihat di bawah), dan kasir bisa ganti satuannya lewat dropdown di baris keranjang tanpa scan ulang.
  - **Kode satuan** (1 kode per satuan jual) — buat barang pabrikan yang kemasannya memang sudah punya label sendiri-sendiri (dus beda kode dari pcs). Scan kode ini langsung masuk keranjang dalam satuan persis itu, tanpa lewat satuan default. Kode satuan **tidak lagi dibuat lewat tombol generate di halaman barang** (barang tanpa label pabrik cukup pakai kode barang, supaya admin tidak perlu cetak label per satuan); kode satuan yang sudah ada tetap tampil, bisa dicetak ulang, dan tetap bekerja saat scan.
- **Satuan jual default**: tiap barang punya 1 satuan jual yang ditandai sebagai default scan kode barang. Kalau admin belum menandai, otomatis **satuan dasar**, jadi barang lama tetap jalan tanpa diisi ulang. Satuan default **wajib salah satu satuan yang punya harga jual** (satuan tanpa harga memang gak bisa dijual).
- Saat scan, sistem cocokkan teks kode ke kode satuan dulu (hasilnya satuan persis), baru ke kode barang (hasilnya satuan default).
- Kode bisa dari 2 sumber, dan sistem memperlakukan keduanya **sama persis** — cuma teks yang dicocokkan pas scan, gak peduli asal-usulnya:
  - **Barcode pabrik** — barang bermerek yang udah ada label EAN-13/UPC dari produsen, tinggal discan & disimpan apa adanya pas input satuan jual itu.
  - **Kode internal** — buat barang yang gak punya label pabrik (barang curah, racikan sendiri, atau produk lokal kecil yang emang gak pernah didaftarin ke standar barcode resmi). Sistem sediakan tombol generate kode urutan internal (format `SKU-TAHUN-00001`, sama polanya kayak nomor dokumen lain di sistem ini) + render QR siap-print langsung dari halaman barang, tanpa perlu aplikasi/alat cetak label terpisah.
- Gak ada validasi format ketat (EAN-13/UPC checksum dst) — kolomnya nerima teks apa aja, karena kode QR yang digenerate sendiri emang gak wajib ikutin standar retail resmi.
- Gak wajib diisi — barang/satuan yang gak pernah discan (dijual manual, ditimbang, atau dipilih dari katalog POS) boleh dibiarkan kosong selamanya, gak ada dampak ke bagian modul lain.

**Aturan Bisnis**
- Kode scan harus unik lintas **SEMUA kode, baik kode barang maupun kode satuan** (gak boleh 2 barang/satuan beda punya kode yang sama, dan kode barang gak boleh sama dengan kode satuan manapun) — kalau bentrok, scan jadi ambigu dan bisa keliru nge-charge harga barang lain.
- Kode barang dan kode satuan gak wajib diisi, dan gak ada aturan "kalau 1 satuan barang X punya kode, semua satuan barang X juga harus punya" — independen per baris. Barang yang pakai kode barang boleh sekaligus punya kode satuan untuk sebagian kemasannya.
- Satuan jual default harus salah satu satuan jual milik barang itu sendiri, dan harus punya harga jual. Kalau harga satuan default dikosongkan/dihapus, default balik ke satuan dasar.
- Satuan jual default cuma dipakai di **scan kode barang di kasir (POS)**. Klik barang dari katalog POS dan form Sales Order/Jual Barang gak berubah dari cara kerjanya sekarang.
- Di keranjang kasir, tiap kombinasi (barang, satuan) satu baris — pembeli boleh beli 1 dus + 3 pcs barang yang sama sebagai 2 baris. Kalau kasir mengganti satuan sebuah baris jadi satuan yang sudah ada barisnya untuk barang yang sama, kedua baris digabung (qty dijumlahkan). **Stok dicek gabungan semua baris barang yang sama, di satuan dasar** (bukan per baris), jadi 100 pcs + 1 bal (125 pcs) ditolak langsung kalau stok total cuma 150 pcs, tanpa nunggu kasir klik bayar.
- Kode scan murni identitas lookup, sama sekali gak menyentuh perhitungan stok/HPP/jurnal — mengubah atau menghapus kode gak berdampak retroaktif ke transaksi yang udah pernah pakai satuan itu (transaksi udah menyimpan qty & harga hasil resolusinya sendiri, gak balik nunjuk ke kode).

**Skenario**
- Piring Plastik dijual 3 satuan: pcs, lusin, pack isi 6. Toko Makmur Jaya cuma bikinin kode buat "pack isi 6" (paling sering dijual retail & discan) — pcs dan lusin dibiarkan tanpa kode, tetap dijual manual lewat katalog seperti biasa.
- Ember Plastik 10L gak ada barcode dari PT Plastindo Jaya (pabrik plastik lokal kecil). Pak Herman generate kode internal dari sistem, cetak label QR-nya, tempel ke rak/kemasan ember — Mbak Rina discan kode itu di kasir buat checkout cepat.
- Kantong Plastik A dijual per pcs, ikat (isi 5), bal (isi 125), dos (isi 1250), semuanya kemasan sendiri tanpa barcode pabrik. Pak Herman cukup bikin **1 kode barang** dan set satuan jual default = ikat. Kasir scan kode itu sekali: masuk keranjang "Kantong Plastik A — 1 ikat". Pelanggan ternyata beli 2 bal: kasir ganti dropdown ke bal dan qty ke 2 (harga ikut harga bal), stok terpotong 2 × 125 = 250 pcs.
- Stok Kantong Plastik B tinggal 3.000 pcs. Kasir scan lalu ganti ke 3 dos (3 × 1.250 = 3.750 pcs) — ditolak langsung di layar kasir karena melebihi stok, tanpa nunggu server menolak pas bayar.

**Common Mistakes**
- Cuma nyediain kode di level barang tanpa satuan default yang jelas — scan gak tau satuan mana yang harus dimasukkan ke keranjang. Makanya kode barang selalu dipasangkan dengan satuan jual default (otomatis satuan dasar kalau belum diset).
- Cuma nyediain kode per satuan jual buat barang yang kemasannya dikemas sendiri — admin dipaksa cetak dan tempel 1 label per satuan per barang (barang 4 satuan = 4 label), dan salah tempel label berarti salah harga. Kode per satuan paling cocok buat barang pabrikan yang labelnya memang sudah ada dari produsen.
- Mengira harga ikut dari kodenya — yang menentukan harga adalah satuan yang terpilih di keranjang, bukan kode yang discan.
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
- Ini murni **lapisan riwayat/audit trail** di atas posisi stok yang sudah ada — bukan cara baru menghitung qty/HPP. Posisi stok (qty & harga rata-rata berjalan) dihitung dan disimpan independen dari fitur ini.
- Tiap baris riwayat tertelusur balik ke dokumen sumber aslinya (invoice penjualan, bukti terima barang, production order, dst) — konsisten sama prinsip semua transaksi harus tertelusur ke dokumen sumber.

**Aturan Bisnis**
- Kartu Stok gak pernah jadi sumber kebenaran baru buat qty atau HPP — cuma cerminan dari transaksi yang udah tercatat di modul lain. Kalau suatu saat ada perbedaan antara jumlah riwayat dan saldo akhir yang tercatat, saldo akhir yang dianggap benar — riwayatnya yang harus diperbaiki, bukan sebaliknya.
- Riwayat mencakup SEMUA jenis kejadian yang bisa menggerakkan stok barang, bukan cuma jalur transaksi inti (beli/produksi/jual) — termasuk juga retur (dari customer maupun ke supplier), barang rusak yang ditulis-jadi-beban, penggantian garansi, dan penyesuaian hasil hitung fisik.

**Skenario**
- Pemilik curiga stok Tepung Terigu turun drastis padahal gak inget ada penjualan besar bulan ini — buka Kartu Stok barang itu, lihat baris demi baris: sekian kilo masuk dari pembelian, sekian kilo keluar buat produksi, ada penyesuaian opname karena selisih hitung fisik — penyebabnya ketahuan tanpa perlu buka satu-satu halaman transaksi yang berbeda-beda.

**Common Mistakes**
- Menganggap Kartu Stok sebagai sumber kebenaran baru buat saldo stok — posisi stok (qty & harga rata-rata berjalan) yang sudah ada tetap yang utama, Kartu Stok cuma riwayat pendukung yang menjelaskan bagaimana angka itu terbentuk.
