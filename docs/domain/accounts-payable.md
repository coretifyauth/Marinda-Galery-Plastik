# Accounts Payable — Bayar Utang ke Supplier

## Masalah yang Diselesaikan

General Ledger bisa nyatet utang timbul (Kredit Utang Usaha) pas beli bahan baku belum bayar. Tapi sama kayak di sisi AR, itu baru "kejadiannya kecatet" — belum ada mekanisme buat tau **siapa** supplier-nya, **kapan jatuh tempo**, dan **udah dibayar berapa**. AP (Accounts Payable) nutup gap ini dari sisi kebalikan AR: sekarang perusahaan yang berutang, bukan yang piutang.

## Konsep Inti

Struktur AP mirror persis AR (Customer jadi Supplier, invoice jadi bill, tapi payment tetap payment), tapi ada 1 perbedaan konteks bisnis penting yang berlaku ke semua turunan di bawahnya: di AR, perusahaan sendiri yang nentuin termin buat customer (kita ngasih syarat termin ke pelanggan langganan). Di AP, kebalikannya — **supplier** yang nentuin termin, perusahaan cuma nerima syarat itu. Bedanya cuma di makna bisnis, bukan di struktur data.

- **Supplier** — master data, pihak yang perusahaan berutang ke dia (bisa lebih dari 1 supplier langganan). Punya termin pembayaran default (syarat yang **diterima** dari supplier, bukan yang kita tetapkan sendiri) yang dipakai ngitung jatuh tempo tiap bill baru. Bukan data transaksional — kalau terminnya berubah (misal supplier naikin kepercayaan jadi termin lebih panjang), cukup diubah di data yang sama, gak bikin baris baru; perubahan cuma berlaku ke bill **baru** ke depan, bill lama yang jatuh temponya udah ditetapkan gak ikut geser.
- **AP Bill** — utang timbul, 1 kejadian "ambil barang, belum bayar". Tiap bill bikin 1 jurnal: **Debit Persediaan atau Beban (tergantung jenis pembelian, bisa lebih dari 1 kategori sekaligus — lihat submodule "Kategori Campur & PPN"), Kredit Utang Usaha**. Akun debit dipilih manual tiap bill dibuat — beli bahan baku masuk Persediaan (asset), beli jasa/sewa/listrik langsung ke Beban (expense) — bukan hasil deteksi otomatis sistem. Jatuh tempo dihitung sekali saat bill dicatat (dari termin supplier saat itu) dan gak berubah lagi setelahnya, walau termin supplier berubah belakangan.
- **AP Payment** — utang berkurang, kejadian bayar beneran ke supplier (bukan jadwal terjadwal). Selalu nutup **1 bill spesifik** (gak ada bayar gabungan beberapa bill sekaligus), boleh **dicicil** (kurang dari sisa tagihan, 1 bill boleh dibayar berkali-kali dari waktu ke waktu), tapi gak boleh **lebih dari sisa tagihan** (overpay ditolak keras — sama alasan kenapa overpay ditolak di AR, biar gak ada saldo mengambang yang gak jelas pertanggungjawabannya). Tiap pembayaran bikin 1 jurnal: **Debit Utang Usaha, Kredit Kas/Bank**, sejumlah yang beneran dibayar. Pembayaran wajib fokus ke 1 obligasi spesifik, sama kebijakan penagihan AR — cicil boleh, nyebar ke banyak obligasi dalam 1 transaksi gak boleh.
  - Pengecualian sempit: kalau nominal yang dibayar adalah sisa tagihan **dibulatkan** (ke bawah atau ke atas) karena uang riil gak bisa membayar pecahan sen/receh, pembayaran itu dianggap **lunas** dan selisihnya dicatat sebagai selisih pembulatan — lihat submodule "Selisih Pembulatan Pelunasan".
- **Status bill** (lunas/sebagian/belum/dibatalkan) — selalu dihitung ulang dari total pembayaran yang sudah diterima dibanding nilai bill, bukan status yang disimpan/di-update manual. Sama pola persis AR.

**Aturan Bisnis**
- Bill dan pembayaran wajib selalu punya jurnal akuntansi yang sepadan — gak ada jalur pencatatan utang yang lewatin pembukuan.
- Bill/pembayaran gak boleh diedit/dihapus setelah dibuat — koreksi cuma lewat pembatalan (reversing entry).
- Pembayaran boleh kurang dari sisa tagihan (cicil), gak boleh lebih (overpay ditolak keras).
- Jatuh tempo dihitung sekali pas bill dibuat dari termin supplier saat itu, gak retroaktif ikut berubah kalau termin supplier berubah belakangan.
- Bill cuma bisa dibatalkan kalau belum ada pembayaran atau retur yang nyentuh dia — begitu udah kesentuh transaksi lain, pembatalan ditolak.

**Skenario**
- Bill lunas tepat waktu — 1 pembayaran nutup 1 bill penuh sekaligus.
- Bayar sebagian (cicil) — 2+ pembayaran ke bill yang sama, masing-masing kurang dari sisa tagihan.
- Pembayaran ditolak — coba bayar lebih dari sisa tagihan (overpay), atau coba nutup lebih dari 1 bill dalam 1 transaksi.
- Telat bayar — beda arah dari AR. Di AR, yang nanggung resiko telat itu kita (piutang macet, harus nagih). Di AP, kalau perusahaan yang telat bayar, resikonya supplier bisa setop kirim bahan baku berikutnya. Cara ngeceknya sama kayak aging AR (bill mana yang udah lewat jatuh tempo), cuma maknanya "bill mana yang HARUS kita bayar duluan", bukan "piutang mana yang harus ditagih".
- Bill dibatalkan (salah input, belum ada pembayaran) — pembalikan jurnal pakai akun yang sama persis, bill asli tetap ada di histori.

**Common Mistakes**
- Jatuh tempo dihitung ulang dari termin supplier saat ini (bukan snapshot) — bill lama ikut geser kalau termin berubah.
- Status lunas/belum disimpan sebagai kolom manual yang di-update tiap pembayaran — harus derived query, resiko gak sinkron.
- Nyatet utang tanpa lewat proses yang juga bikin jurnal — AP dan pembukuan jadi dua sumber angka gak sinkron.
- Terima pembayaran dengan nominal lebih (overpay) dari sisa outstanding bill — harus ditolak. Kurang (cicil) boleh, itu bukan mistake.
- Batalin bill yang udah ada pembayaran/retur tanpa pengaman — pembukuan tetap balance tapi transaksi yang udah kesentuh jadi gak jelas nasibnya.
- Salah pilih akun debit pas bikin bill — bahan baku harusnya masuk Persediaan (asset), jasa/sewa/listrik harusnya langsung Beban (expense). Sistem nerima akun debit sebagai input manual, jadi kesalahan pilih akun itu tanggung jawab yang input, bukan dicegah otomatis.

### Tagihan Dulu, Barang Menyusul (Kolam Tagihan)

**Masalahnya:** supplier sering mengirim nota duluan dan minta dibayar, sementara barangnya datang bertahap beberapa hari kemudian (dan tidak langsung menutup seluruh nota). Pembukuan harus bisa mencatat utang dan pembayarannya tanpa mengaku punya stok yang belum ada di gudang, dan tiap barang yang datang belakangan harus bisa ditelusuri ke nota yang membayarnya — gak boleh "tercecer" di sembarang tagihan.

**Cara Kerja**
- Tagihan dibuat dengan dua mode. **Tagihan langsung** — biaya/jasa tanpa barang fisik, seperti sebelumnya. **Tagihan barang** — ada barang fisik yang akan diterima. Gak ada jalur ketiga: **barang masuk selalu dibuat dari satu tagihan barang**; barang masuk tanpa nota gak ada lagi.
- Bagian barang dari tagihan barang disebut **kolam**: nilai barang sesuai nota yang belum diterima fisiknya. Jurnal saat tagihan dibuat: Debit **Pembelian Belum Diterima** (aset — klaim kita ke supplier: sudah ditagih, barang belum datang), Kredit **Utang Usaha**. Bukan Debit Persediaan, karena barangnya belum ada di gudang. Ongkos kirim, PPN Masukan, dan kategori campur tetap dijurnal seperti tagihan biasa saat tagihan dibuat; semuanya di luar kolam.
- **Status bayar gak ada hubungannya dengan kolam.** Tagihan boleh dibayar sebelum barang datang, sesudahnya, atau dicicil — kolam dan barang masuk jalan sendiri-sendiri. Bayar tetap lewat alur pembayaran biasa.
- Tiap kiriman dicatat sebagai **barang masuk yang dibuat dari tagihan itu** (harga per item diketik sesuai nota): Debit Persediaan, Kredit Pembelian Belum Diterima. Kolam berkurang sebesar nilai barang masuk. Satu tagihan boleh punya banyak barang masuk (kiriman bertahap); satu barang masuk punya **tepat satu** tagihan — gak bisa dibagi ke dua nota dan gak bisa dipindah. Kalau supplier menagih satu kiriman dengan dua nota, kirimannya dicatat sebagai dua barang masuk, masing-masing dari satu nota.
- Alokasi barang masuk ke tagihan gak punya jurnal sendiri. Yang berjurnal hanya tagihan dan barang masuk; saldo Pembelian Belum Diterima otomatis sama dengan jumlah sisa kolam semua tagihan.
- **Sisa kolam** (barang yang gak akan datang atau selisih receh) ditutup begini:
  - Sisa di bawah satuan pembulatan (Rp1) — dilepas ke akun Selisih Pembulatan yang sama dengan pelunasan: Debit Beban Selisih Pembulatan, Kredit Pembelian Belum Diterima.
  - Sisa yang lebih besar, **bagian yang sudah dibayar** — dilepas ke Uang Muka: Debit Uang Muka Pembelian, Kredit Pembelian Belum Diterima. Batasnya (uang yang sudah dibayar, termasuk uang muka yang sudah diterapkan ke tagihan itu) dikurangi nilai barang masuk yang sudah terpakai. Setelah jadi Uang Muka, nasibnya mengikuti mekanisme uang muka yang ada: diterapkan ke tagihan lain, direfund, atau dihanguskan.
  - Sisa yang **belum dibayar** — secara bisnis ini koreksi utang (nota kredit dari supplier). Belum ada jalurnya; dicatat sebagai scope-debt (`memory/scope-debt/ap-kolam-sisa-belum-dibayar.md`).
- **Pembatalan barang masuk** membalik jurnalnya (Debit Pembelian Belum Diterima, Kredit Persediaan), mengurangi stok, dan mengembalikan kolam. Ditolak kalau stok item itu gak cukup lagi dikurangi, atau barang masuk itu sudah diretur. **Pembatalan tagihan barang** hanya boleh kalau belum ada pembayaran maupun retur dan semua barang masuknya sudah dibatalkan.
- **Retur ke supplier** atas barang masuk selalu mengenai tagihan induknya (satu), jadi gak ada pertanyaan "tagihan mana yang dikurangi".
- **Nota telat = barang belum bisa dicatat.** Stok sistem baru bertambah saat barang masuk dibuat, dan barang masuk butuh tagihan. Kalau nominal belum pasti, tagihan boleh dibuat dari nominal perkiraan; nota yang beda dikoreksi dengan membatalkan (barang masuk lalu tagihan) dan membuat ulang selama syarat pembatalan di atas masih terpenuhi.

**Aturan Bisnis**
- Setiap barang masuk wajib punya tepat satu tagihan barang aktif, dan supplier barang masuk harus sama dengan supplier tagihan.
- Jumlah nilai bersih barang masuk (setelah diskon) dari satu tagihan gak boleh melebihi kolam tagihan itu — lebih dari itu ditolak.
- Harga tiap baris barang masuk wajib diisi; gak ada harga perkiraan atau harga 0.
- Hanya bagian yang sudah dibayar yang boleh dilepas ke Uang Muka. Sisa yang belum dibayar gak boleh "dihilangkan" lewat jalur ini.
- Tagihan barang yang dibatalkan gak boleh meninggalkan barang masuk aktif.
- Selisih nilai setelah stok sudah bergerak (nota ternyata lebih mahal dari perkiraan, barangnya sudah terjual) belum punya jalur koreksi (`memory/scope-debt/ap-kolam-selisih-harga-setelah-stok-bergerak.md`).
- PPN Masukan dijurnal penuh saat tagihan dibuat dan tidak disesuaikan kalau barangnya batal datang dan kolam dilepas (`memory/scope-debt/ap-kolam-ppn-masukan-barang-batal-datang.md`).

**Skenario**
- Nota Rp10 juta dibayar langsung. Barang datang Rp3 juta, Rp4 juta, lalu Rp3 juta → kolam 10 → 7 → 3 → 0; saldo Pembelian Belum Diterima ikut turun ke nol.
- Nota Rp10 juta, belum dibayar sama sekali, barang datang Rp4 juta → kolam Rp6 juta, utang tetap Rp10 juta sampai dibayar.
- Nota Rp10 juta, dibayar Rp7 juta, barang terpakai Rp4 juta, sisa Rp6 juta gak jadi dikirim → paling banyak Rp3 juta (dibayar Rp7 juta dikurangi terpakai Rp4 juta) dilepas ke Uang Muka; Rp3 juta sisanya menunggu nota kredit.
- Nota Rp10.000.000, tiga barang masuk berjumlah Rp9.999.999,60 → sisa Rp0,40 dilepas ke Beban Selisih Pembulatan.
- Barang masuk Rp6,5 juta padahal sisa kolam Rp6 juta (harga naik) → ditolak dari tagihan itu; kirimannya dicatat dari tagihan lain, atau dipecah menjadi dua barang masuk dari dua nota.

**Common Mistakes**
- Mendebit Persediaan saat tagihan barang dibuat — buku mengaku punya stok yang belum ada, stok opname gak cocok, dan harga rata-rata item terhitung dari barang yang belum datang.
- Menganggap tagihan harus dibayar dulu supaya barang masuknya boleh dicatat (atau sebaliknya) — status bayar dan kolam independen.
- Menganggap sisa kolam hilang sendiri — yang gak jadi datang harus ditutup secara sadar (pembulatan, uang muka, atau nota kredit).
- Mengubah nominal tagihan supaya cocok dengan barang yang datang — yang berubah itu barang masuknya (dan nota yang beda dikoreksi dengan batal-ulang).

### Diskon Pembelian (Trade Discount)

Sama seperti sisi penjualan, diskon yang didukung di sini adalah **trade discount** — potongan yang disepakati di titik bill/penerimaan barang dibuat, bukan cash discount bersyarat waktu bayar. Trade discount gak pernah punya baris jurnal sendiri; nilai bill langsung dicatat net dari awal. Lihat submodule "Diskon Penjualan (Trade Discount)" di `docs/domain/accounts-receivable.md` untuk perbandingan lengkap trade vs cash discount.

**Cara Kerja**
- Beda dari sisi penjualan, diskon pembelian gak butuh master data aturan — admin bebas mengisi nilai diskon nominal Rupiah langsung saat bikin AP Bill atau saat mencatat Penerimaan Barang (Goods Receipt), mirip cara kerja kategori beban tambahan (misal Ongkos Kirim Supplier), cuma arahnya mengurangi total, bukan menambah.
- Nilai diskon ini murni mengurangi jumlah yang jadi Utang Usaha — gak nyentuh akun pembukuan mana pun secara terpisah, karena bukan kejadian akuntansi sendiri, cuma bagian dari negosiasi harga di titik pembelian itu.
- **Tagihan langsung** (tanpa barang masuk): berlaku di level dokumen (1 nilai per bill), bukan per baris barang — beda dari sisi penjualan yang per-barang lewat aturan diskon. **Tagihan barang:** nilai barang di tagihan dicatat net sesuai nota, tanpa diskon tersendiri. Rincian diskon diisi di barang masuk yang dibuat dari tagihan itu, per item (alat bantu di layar yang jumlahnya otomatis masuk ke diskon dokumen) dan per dokumen — lihat submodule "Barang Masuk dari Tagihan" di `docs/domain/inventory.md`.

**Aturan Bisnis**
- Diskon pembelian diinput manual sebagai nominal Rupiah (bukan persen), bebas diisi admin tanpa harus dari master data — beda sengaja dari sisi penjualan yang wajib dari aturan.
- Diskon pembelian gak pernah menghasilkan baris jurnal terpisah — nilai bill yang tercatat sudah net dari awal.

**Skenario**
- Bill dari supplier senilai Rp1.000.000, dapat potongan tunai Rp50.000 karena bayar kontan — admin isi field diskon Rp50.000 saat bikin bill, Utang Usaha yang tercatat Rp950.000, tanpa baris jurnal diskon terpisah.

**Common Mistakes**
- Mencatat diskon pembelian sebagai baris jurnal "Diskon Pembelian" tersendiri — trade discount gak butuh itu, cukup net langsung.
- Menyamakan mekanisme ini dengan diskon penjualan (yang wajib dari master data aturan) — sisi pembelian sengaja dibuat bebas/manual, gak butuh aturan yang disiapkan duluan.

### Retur Barang ke Supplier

Form retur memvalidasi kategori akun: akun Persediaan gak bisa "diretur" lewat jalur nominal manual tanpa bukti fisik (bill wajib punya Goods Receipt Note buat retur Persediaan), dan akun Utang Usaha terkunci otomatis ke akun yang benar (gak bisa salah diisi akun lain).

**Cara Kerja**
- Kebalikan retur di AR — bahan baku yang diterima dari supplier ternyata rusak (misal tepung apek, gula basah kena air), dan perusahaan mau kembalikan. Bedanya dari pembatalan bill: bill-nya **valid**, transaksinya beneran kejadian, cuma **sebagian barangnya** dikembalikan belakangan — bisa kejadian kapan pun, baik bill belum dibayar, sebagian, maupun udah lunas penuh.
- Begitu barang rusak ketauan, ada **2 resolusi** yang bisa disepakati sama supplier — pilihan manual orang yang input transaksi (sama pola milih akun debit Persediaan vs Beban pas bikin bill, keputusan bisnis manusia, bukan hasil deteksi sistem), **bukan konsekuensi otomatis dari status bayar bill**:
  - **Opsi A — Kurangi Utang** (retur beneran ngurangin Utang Usaha):
    - Bill belum lunas/sebagian: **Debit Utang Usaha, Kredit Persediaan Bahan Baku** — utang beneran berkurang sejumlah nilai retur, gak lewat akun perantara.
    - Bill udah lunas penuh (atau retur ngelebihin sisa outstanding): jurnal yang sama tetap jalan dulu (bikin outstanding minus) → excess-nya **otomatis** direklasifikasi jadi saldo baru **Piutang Retur Supplier** (akun asset baru) — mirror mekanisme saldo kredit retur di AR, tapi arah aset kebalik (di AR itu liability kita ke customer; di sini asset kita ke supplier, karena supplier yang "berutang" balik ke kita). Saldo ini partial-capable, **cuma bisa dicairkan tunai** (Debit Kas/Bank, Kredit Piutang Retur Supplier) — gak bisa dipakai motong bill lain.
    - Kenapa gak butuh akun kontra (beda dari AR yang pakai kontra-revenue "Retur & Potongan Penjualan"): sisi debit bill (Persediaan Bahan Baku) itu akun **neraca** (asset), bukan akun laporan laba-rugi kayak Pendapatan — retur boleh langsung mengurangi Persediaan tanpa lewat akun perantara.
  - **Opsi B — Tukar Barang** (supplier kirim barang pengganti, bukan kurangin utang):
    - **Berdiri sendiri, gak lewat retur Opsi A sama sekali** — kalau Opsi B dianggap tambahan DI ATAS Opsi A untuk porsi barang yang sama, supplier jadi ngasih 2 kompensasi sekaligus (kurangi utang DAN kirim barang pengganti tanpa nagih balik) buat 1 kejadian rusak yang sama, gak masuk akal secara bisnis. Makanya Opsi A dan Opsi B saling eksklusif per porsi barang (lihat Aturan Bisnis).
    - **Berlaku sama persis di semua status bayar** — Utang Usaha **gak pernah kesentuh**, mau bill-nya lunas, sebagian, atau belum dibayar sama sekali.
    - Jurnal: **Debit Persediaan Bahan Baku** (barang baru masuk) **/ Kredit Persediaan Bahan Baku** (barang rusak keluar) — net nol, murni reklasifikasi fisik (barang keluar-masuk dicatat biar jejak audit per-kejadian lengkap), tanpa baris Beban — karena perusahaan gak kehilangan nilai apa pun (dapat gantinya senilai sama).
- Sengaja gak ada batas waktu retur (umur bill vs tanggal retur) — sama seperti di AR. Retur ke supplier diterima/ditolak murni keputusan manual staf di luar sistem.
- **Kedua opsi berbagi 1 batas fisik yang sama**: total qty yang diklaim lewat opsi mana pun (A atau B), buat 1 item di 1 bill yang sama, gak boleh ngelebihin qty yang beneran diterima di bill itu. Karena batasnya di level fisik (bukan per-mekanisme), 1 bill boleh dipecah campuran — sebagian qty diretur (Opsi A), sebagian ditukar (Opsi B) — sesuai hasil negosiasi nyata per porsi barangnya, gak harus 1 kejadian = 1 resolusi seragam buat seluruh bill.
- Catatan implementasi: fitur ini nanganin item dengan metode costing Rata-Rata Tertimbang — satu-satunya metode yang ada sekarang (FIFO sudah dihapus total dari sistem). Nilai barang yang diretur/ditukar dihitung dari harga rata-rata **saat kejadiannya terjadi**, bukan harga asal pas barang diterima — konsisten dengan cara Rata-Rata Tertimbang bekerja di modul Inventory (gak nyimpen asal-usul per batch).
- **Barang rusak yang supplier tolak kompensasi sama sekali** (gak mau kurangi utang, gak mau kirim pengganti) — dicatat lewat penyesuaian stok fisik (Stock Opname), bukan lewat RPC khusus AP. Konsekuensinya: catatan kerugiannya gak otomatis tertaut ke bill/supplier spesifik yang jadi penyebabnya, staf yang input harus inget sendiri gak dobel-klaim qty yang sama lewat jalur retur di atas.

**Aturan Bisnis**
- Opsi A dan Opsi B saling eksklusif **per porsi barang yang sama** — 1 unit barang cuma bisa diklaim lewat salah satu opsi, gak boleh jalan bareng buat porsi yang sama (itu kompensasi ganda dari sisi supplier). Porsi yang beda dalam 1 bill yang sama boleh pakai opsi berbeda-beda.
- Total qty yang diklaim lewat Opsi A dan Opsi B sekaligus, buat 1 item di 1 bill yang sama, gak boleh ngelebihin qty yang beneran diterima di bill itu.
- Total saldo Piutang Retur Supplier yang dicairkan tunai gak boleh ngelebihin nominal awal saldo itu.
- Retur gak boleh dicatat ke periode akuntansi yang udah ditutup — soal integritas pembukuan umum, bukan aturan khusus retur.

**Skenario**
- Retur (Opsi A), bill belum lunas — utang beneran berkurang.
- Retur (Opsi A), bill udah lunas — jurnal sama tetap jalan (outstanding jadi minus), otomatis direklasifikasi jadi saldo Piutang Retur Supplier.
- Retur (Opsi B) — tukar barang, berdiri sendiri, Utang Usaha gak kesentuh, independen dari status bayar.
- Saldo Piutang Retur Supplier dicairkan tunai.
- 1 bill dipecah campuran — sebagian qty diretur (Opsi A, dapat potongan utang), sebagian qty lain dari bill yang sama ditukar (Opsi B) — dua kejadian independen, sama-sama dibatasi qty fisik yang diterima.

**Common Mistakes**
- Opsi A dan Opsi B dianggap bisa jalan bareng buat porsi barang yang sama — itu kompensasi ganda dari sisi supplier, cuma boleh pilih salah satu per porsi.
- Excess dari Opsi A (bill udah lunas) dianggap otomatis berarti barang harus diganti (Opsi B) — dua-duanya independen, resolusi yang dipilih adalah keputusan bisnis, bukan konsekuensi status bayar.
- Barang rusak yang gak dapat kompensasi sama sekali (supplier nolak) dianggap bisa dicatat lewat RPC AP khusus — gak ada jalur RPC khusus buat kasus ini, harus lewat Stock Opname.

### Uang Muka / DP ke Supplier

**Cara Kerja**
- Perusahaan kadang harus bayar duluan ke supplier **sebelum** ada bill — supplier baru yang belum kasih kepercayaan termin, atau bahan baku custom/pesanan besar yang mensyaratkan DP dulu. Mirror DP di AR, tapi arahnya **kebalik**: di AR, DP yang **diterima** dari customer itu **liability** (kita berutang barang ke mereka); di AP, DP yang **dibayar** ke supplier itu **asset** (Uang Muka Pembelian) — supplier yang berutang barang/uang balik ke kita.
- Kenapa gak langsung dicatat sebagai Beban atau pengurang Utang Usaha: matching principle — barangnya belum diterima, belum ada manfaat yang diakui. DP itu klaim ke supplier, bukan biaya yang udah terjadi, dan belum ada bill/utang yang timbul di titik itu.
- Empat kejadian, empat jurnal berbeda:
  1. **DP dibayar** — Debit Uang Muka Pembelian, Kredit Kas/Bank. Belum nyentuh Utang Usaha sama sekali — belum ada bill.
  2. **DP diterapkan ke bill** (begitu barang datang & bill diterbitkan) — Debit Utang Usaha, Kredit Uang Muka Pembelian. Reklasifikasi, ngurangin outstanding bill itu.
  3. **DP direfund tunai** (order dibatalin, supplier mau balikin uangnya) — Debit Kas/Bank, Kredit Uang Muka Pembelian. Gak ada dampak Laba Rugi — murni aset balik jadi kas.
  4. **DP hangus** (order dibatalin, supplier gak mau/gak bisa balikin) — Debit Beban Kerugian Uang Muka, Kredit Uang Muka Pembelian. Ada dampak Laba Rugi — kita beneran rugi sejumlah itu.
- **Penyelesaian 1 DP boleh campuran** — sebagian diterapkan ke bill, sebagian direfund, sisanya baru dianggap hangus, asal totalnya gak ngelebihin nilai DP awal, sama pola penyelesaian DP di AR.
- **Beda mendasar dari DP di AR soal siapa nentuin kebijakan refund**: di AR, DP dari customer defaultnya gak direfund (kebijakan yang KITA tetapkan ke customer kita, awalnya cuma ada jalur hangus). Di AP, refund-tidaknya DP kita ke supplier itu **supplier** yang nentuin, bukan kita — makanya sejak awal AP butuh 2 jalur (refund DAN hangus) sekaligus, gak cuma 1.
- **Dampak ke sisa outstanding bill**: DP yang udah diterapkan ikut ngurangin sisa tagihan bill, sama pola AR. Kalau bill yang DP-nya udah diterapkan ternyata perlu dibatalin, pembatalan itu ikut otomatis membalikkan penerapan DP-nya juga — biar DP-nya balik jadi belum dipakai (siap dipakai ulang/direfund/dihanguskan), bukan nyangkut jadi utang minus yang gak jelas asalnya.

**Aturan Bisnis**
- DP gak boleh langsung diakui sebagai Beban atau pengurang Utang Usaha saat dibayar — wajib lewat akun aset Uang Muka Pembelian dulu.
- DP hangus dicatat ke Beban Kerugian Uang Muka.
- Total penyelesaian DP (diterapkan + refund + hangus) gak boleh melebihi nilai DP awal.
- Kalau bill yang DP-nya sudah diterapkan dibatalkan, penerapan DP itu wajib ikut dibalik.

**Skenario**
- DP dibayar lalu diterapkan penuh ke bill — 2 jurnal terpisah (bayar DP, terapkan ke bill), outstanding bill berkurang sejumlah DP.
- DP dibatalkan, direfund tunai penuh — supplier mau balikin, gak ada dampak Laba Rugi.
- DP dibatalkan, hangus penuh — supplier gak mau balikin, jadi Beban Kerugian Uang Muka.
- DP diselesaikan campuran — sebagian diterapkan ke bill, sebagian direfund, sisanya hangus, ketiganya partial dan independen.

**Common Mistakes**
- Mengakui DP sebagai Beban (atau langsung ngurangin Utang Usaha) pas dibayar — barangnya belum diterima, belum ada manfaat yang diakui.
- Refund DP dicatat lewat jalur hangus (atau sebaliknya) — dua-duanya beda dampak Laba Rugi (refund netral, hangus jadi Beban), harus lewat jalur yang tepat.
- DP yang udah diterapkan ke bill dianggap masih bisa direfund/dihanguskan sejumlah penuh — bagian yang udah kepake harus dikurangin dulu, cuma sisanya yang bisa diselesaikan lewat refund/hangus.

### Kategori Campur & PPN

**Cara Kerja**
- 1 nota supplier kadang isinya campuran — misal Rp750.000 tepung (Persediaan) + Rp50.000 ongkos kirim (Beban), dalam 1 nota fisik yang sama.
- Admin bisa menyiapkan daftar kategori beban/persediaan tambahan (misal "Ongkos Kirim Supplier"), dan staf AP bisa menambahkan baris kategori itu saat mencatat bill — nominalnya tetap diinput manual per nota, gak ada nilai default.
- PPN Masukan (kalau relevan) dihitung otomatis oleh sistem dari tarif yang diset admin, ditambahkan ke Utang Usaha — bukan diketik manual, biar konsisten dengan jumlah yang benar-benar terutang ke supplier.
- Fitur ini juga berlaku untuk alur pembelian terencana (Purchase Order, tagihan barang, lalu barang masuk dari tagihan itu) — nota supplier untuk barang pesanan PO bisa punya kategori campur (mis. ongkos kirim sebagai Beban) dan PPN Masukan juga, sama seperti bill yang dicatat manual. Biaya tambahan dan PPN dijurnal saat tagihan dibuat dan berada di luar kolam barang.

**Aturan Bisnis**
- Kategori campur tidak mengubah cara Utang Usaha dihitung — tetap 1 angka total (subtotal kategori + PPN kalau ada).
- Staf AP tidak memilih akun pembukuan bebas untuk kategori tambahan — hanya dari daftar yang sudah disiapkan admin.

**Skenario**
- Nota dari Toko Tepung Makmur berisi Rp750.000 tepung + Rp50.000 ongkir — dicatat sebagai 1 bill dengan 2 baris kategori (Persediaan + Beban Ongkir), Utang Usaha tetap 1 angka Rp800.000.

**Common Mistakes**
- Memaksa transaksi campuran jadi 1 kategori saja — bikin laporan biaya per kategori jadi gak akurat (ongkir ketumpuk jadi Persediaan).
- Membiarkan PPN Masukan diketik manual — beresiko salah hitung atau lupa dicatat sama sekali.

### Selisih Pembulatan Pelunasan

**Cara Kerja**
- Nota supplier kadang bernilai pecahan, misal Rp387.239,40 (hasil konversi harga per dus ke per pcs, atau PPN 11%). Bill wajib dicatat **persis sesuai nota** — nota adalah dokumen sumber, sistem gak boleh membulatkannya sendiri.
- Tapi uang riil gak bisa membayar pecahan: transfer bank gak bisa mengirim sen, dan uang tunai praktis gak punya pecahan di bawah Rp100. Jadi perusahaan membayar angka bulat, misal Rp387.239, dan supplier menyatakan tagihan **lunas**. Secara hukum perikatan tagihan itu memang sudah selesai (kesepakatan kedua pihak) — arah pembulatan (ke bawah atau ke atas) ditentukan kesepakatan dengan supplier, bukan aturan "kurang dari 5 dibulatkan ke bawah".
- Yang dicatat sebagai pembayaran selalu **uang yang benar-benar berpindah** (sesuai mutasi bank / kuitansi tunai) — gak pernah mengetik sen yang gak ada di rekening. Sistem yang membaca apakah nominal itu pelunasan dengan pembulatan:
  - Sisa tagihan dibulatkan ke bawah dan ke atas ke **kelipatan satuan pembulatan**. Kalau nominal bayar sama dengan salah satu dari dua angka itu, tagihan dianggap **lunas** dan selisihnya dijurnal otomatis.
  - Satuan pembulatan tergantung **metode bayar** yang dipilih saat mencatat pembayaran (bukan dari akun kas yang dipakai): Transfer Bank Rp1, Tunai Rp100 (default, bisa diubah admin di Pengaturan). Metode bayar ikut disimpan di pembayaran, jadi tiap selisih bisa ditelusuri alasannya.
  - Selain dua angka itu, aturan lama berlaku: kurang dari sisa = cicilan biasa, lebih dari sisa = ditolak.
- Jurnal pembulatan ke bawah (kita bayar kurang, supplier merelakan) — posisi kita diuntungkan, jadi **Pendapatan**:
  ```
  Debit Utang Usaha [sisa tagihan]   Kredit Kas/Bank [uang yang dibayar]
                                      Kredit Pendapatan Selisih Pembulatan [selisih]
  ```
- Jurnal pembulatan ke atas (supplier minta digenapkan, kita bayar lebih) — posisi kita dirugikan, jadi **Beban**:
  ```
  Debit Utang Usaha [sisa tagihan]                 Kredit Kas/Bank [uang yang dibayar]
  Debit Beban Selisih Pembulatan [selisih]
  ```
- Baris pembulatan ada di **jurnal yang sama** dengan pembayarannya, bukan jurnal terpisah — kalau pembayaran suatu saat dibalik, selisihnya ikut terbalik otomatis.

**Aturan Bisnis**
- Bill tetap dicatat sesuai nota (termasuk pecahannya). Pembulatan hanya terjadi di titik pelunasan.
- Pendapatan dan Beban Selisih Pembulatan adalah **2 akun terpisah** (bukan 1 akun yang dinetto) — laporan Laba Rugi tetap menunjukkan berapa yang untung dan berapa yang rugi dari pembulatan, sama seperti Selisih Persediaan.
- Selisih yang **bukan pembulatan** (misal supplier bilang "Rp500-nya gak usah" pada pembayaran transfer) bukan bagian fitur ini — itu potongan harga, keputusan yang harus disadari orang, bukan diserap diam-diam ke akun pembulatan.
- Aturan selalu membaca **sisa tagihan saat itu** (setelah cicilan, retur, DP), bukan nilai awal bill.
- Kalau sisa tagihan tinggal receh di bawah satuan (misal Rp0,40 sisa dari pembayaran lama), bisa ditutup dengan mencatat pembayaran **Rp0** — itu juga "sisa dibulatkan ke bawah", jurnalnya cuma Debit Utang / Kredit Pendapatan Selisih Pembulatan tanpa baris kas.

**Skenario**
- Nota Rp387.239,40, transfer Rp387.239 → lunas, Pendapatan Selisih Pembulatan Rp0,40.
- Nota Rp387.239,40, supplier minta Rp387.240, transfer Rp387.240 → lunas, Beban Selisih Pembulatan Rp0,60.
- Nota Rp387.239,40, transfer Rp387.200 → cicilan biasa, sisa Rp39,40 (lewat transfer, kurang Rp39 bukan pembulatan). Kalau nanti dilunasi transfer Rp39 → lunas, Pendapatan Rp0,40.
- Nota Rp387.239,40 dibayar tunai Rp387.200 → lunas, Pendapatan Selisih Pembulatan Rp39,40 (satuan tunai Rp100).
- Transfer Rp387.300 → ditolak (kelebihan bayar).

**Common Mistakes**
- Mencatat pembayaran Rp387.239,40 padahal yang ditransfer Rp387.239 — saldo Kas/Bank di sistem lebih besar dari rekening asli, selisihnya menumpuk tiap transaksi dan rekonsiliasi bank gak pernah cocok.
- Membulatkan nilai bill saat dicatat — bill jadi gak sama dengan nota supplier (dokumen sumber).
- Memakai batas toleransi lebar (Rp1.000 dsb) supaya "otomatis lunas" — mencampur pembulatan dengan potongan harga.
- Menebak metode bayar dari nama/kode akun kas — akun bisa diganti nama atau dipetakan ulang kapan saja; metode bayar harus fakta yang dicatat di pembayaran.
- Menyebut selisih pembulatan "selisih kurs" — selisih kurs adalah untung/rugi perubahan nilai tukar mata uang asing, konsep yang beda sama sekali.
