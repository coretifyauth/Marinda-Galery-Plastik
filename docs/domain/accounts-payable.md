# Accounts Payable — Bayar Utang ke Supplier

## Masalah yang Diselesaikan

General Ledger bisa nyatet utang timbul (Kredit Utang Usaha) pas beli bahan baku belum bayar. Tapi sama kayak di sisi AR, itu baru "kejadiannya kecatet" — belum ada mekanisme buat tau **siapa** supplier-nya, **kapan jatuh tempo**, dan **udah dibayar berapa**. AP (Accounts Payable) nutup gap ini dari sisi kebalikan AR: sekarang perusahaan yang berutang, bukan yang piutang.

## Konsep Inti

Struktur AP mirror persis AR (Customer jadi Supplier, invoice jadi bill, tapi payment tetap payment), tapi ada 1 perbedaan konteks bisnis penting yang berlaku ke semua turunan di bawahnya: di AR, perusahaan sendiri yang nentuin termin buat customer (kita ngasih syarat termin ke pelanggan langganan). Di AP, kebalikannya — **supplier** yang nentuin termin, perusahaan cuma nerima syarat itu. Bedanya cuma di makna bisnis, bukan di struktur data.

- **Supplier** — master data, pihak yang perusahaan berutang ke dia (bisa lebih dari 1 supplier langganan). Punya termin pembayaran default (syarat yang **diterima** dari supplier, bukan yang kita tetapkan sendiri) yang dipakai ngitung jatuh tempo tiap bill baru. Bukan data transaksional — kalau terminnya berubah (misal supplier naikin kepercayaan jadi termin lebih panjang), cukup diubah di data yang sama, gak bikin baris baru; perubahan cuma berlaku ke bill **baru** ke depan, bill lama yang jatuh temponya udah ditetapkan gak ikut geser.
- **AP Bill** — utang timbul, 1 kejadian "ambil barang, belum bayar". Tiap bill bikin 1 jurnal: **Debit Persediaan atau Beban (tergantung jenis pembelian, bisa lebih dari 1 kategori sekaligus — lihat submodule "Kategori Campur & PPN"), Kredit Utang Usaha**. Akun debit dipilih manual tiap bill dibuat — beli bahan baku masuk Persediaan (asset), beli jasa/sewa/listrik langsung ke Beban (expense) — bukan hasil deteksi otomatis sistem. Jatuh tempo dihitung sekali saat bill dicatat (dari termin supplier saat itu) dan gak berubah lagi setelahnya, walau termin supplier berubah belakangan.
- **AP Payment** — utang berkurang, kejadian bayar beneran ke supplier (bukan jadwal terjadwal). Selalu nutup **1 bill spesifik** (gak ada bayar gabungan beberapa bill sekaligus), boleh **dicicil** (kurang dari sisa tagihan, 1 bill boleh dibayar berkali-kali dari waktu ke waktu), tapi gak boleh **lebih dari sisa tagihan** (overpay ditolak keras — sama alasan kenapa overpay ditolak di AR, biar gak ada saldo mengambang yang gak jelas pertanggungjawabannya). Tiap pembayaran bikin 1 jurnal: **Debit Utang Usaha, Kredit Kas/Bank**, sejumlah yang beneran dibayar. Pembayaran wajib fokus ke 1 obligasi spesifik, sama kebijakan penagihan AR — cicil boleh, nyebar ke banyak obligasi dalam 1 transaksi gak boleh.
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

### Diskon Pembelian (Trade Discount)

Sama seperti sisi penjualan, diskon yang didukung di sini adalah **trade discount** — potongan yang disepakati di titik bill/penerimaan barang dibuat, bukan cash discount bersyarat waktu bayar. Trade discount gak pernah punya baris jurnal sendiri; nilai bill langsung dicatat net dari awal. Lihat submodule "Diskon Penjualan (Trade Discount)" di `docs/domain/accounts-receivable.md` untuk perbandingan lengkap trade vs cash discount.

**Cara Kerja**
- Beda dari sisi penjualan, diskon pembelian gak butuh master data aturan — admin bebas mengisi nilai diskon nominal Rupiah langsung saat bikin AP Bill atau saat mencatat Penerimaan Barang (Goods Receipt), mirip cara kerja kategori beban tambahan (misal Ongkos Kirim Supplier), cuma arahnya mengurangi total, bukan menambah.
- Nilai diskon ini murni mengurangi jumlah yang jadi Utang Usaha — gak nyentuh akun pembukuan mana pun secara terpisah, karena bukan kejadian akuntansi sendiri, cuma bagian dari negosiasi harga di titik pembelian itu.
- Berlaku di level dokumen (1 nilai per bill), bukan per baris barang — beda dari sisi penjualan yang per-barang lewat aturan diskon.

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
- Fitur ini juga berlaku untuk alur pembelian terencana (Purchase Order → Goods Receipt → Bill) — nota dari penerimaan barang lewat PO bisa punya kategori campur (mis. Persediaan + Beban Ongkir) dan PPN Masukan juga, sama seperti bill yang dicatat manual.

**Aturan Bisnis**
- Kategori campur tidak mengubah cara Utang Usaha dihitung — tetap 1 angka total (subtotal kategori + PPN kalau ada).
- Staf AP tidak memilih akun pembukuan bebas untuk kategori tambahan — hanya dari daftar yang sudah disiapkan admin.

**Skenario**
- Nota dari Toko Tepung Makmur berisi Rp750.000 tepung + Rp50.000 ongkir — dicatat sebagai 1 bill dengan 2 baris kategori (Persediaan + Beban Ongkir), Utang Usaha tetap 1 angka Rp800.000.

**Common Mistakes**
- Memaksa transaksi campuran jadi 1 kategori saja — bikin laporan biaya per kategori jadi gak akurat (ongkir ketumpuk jadi Persediaan).
- Membiarkan PPN Masukan diketik manual — beresiko salah hitung atau lupa dicatat sama sekali.
