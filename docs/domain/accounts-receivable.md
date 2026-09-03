# Accounts Receivable — Nagih Piutang Termin

## Masalah yang Diselesaikan

Fase 2 (General Ledger) udah bisa nyatet piutang timbul (Debit Piutang Usaha) pas jual dengan termin. Tapi itu baru "kejadiannya kecatet" — belum ada mekanisme buat:

- Tau **siapa** yang berutang (identitas customer belum ada datanya sendiri, cuma nempel di catatan bebas transaksi jurnal).
- Tau **kapan jatuh tempo** tiap piutang, dan **berapa termin** yang disepakati per customer.
- Nyatet pelunasan dan tau **piutang mana yang udah/belum lunas**, termasuk kalau pelunasannya nyicil.
- Bikin **aging report** (piutang mana yang udah lewat jatuh tempo) buat nagih.

AR nutup gap ini: nambah lapisan "siapa berutang, berapa, kapan jatuh tempo, udah dibayar berapa" di atas General Ledger yang udah ada.

## Konsep Inti

- **Customer** — master data pelanggan yang berutang dengan termin. Punya termin default (misal net-7, net-14) yang dipakai ngitung jatuh tempo tiap invoice baru, batas kredit (opsional) dan toleransi keterlambatan (opsional, lihat submodule "Credit Hold"). Bukan data transaksional — kalau terminnya berubah, cukup diubah di data yang sama, gak perlu bikin catatan baru; perubahan cuma berlaku ke invoice **baru** ke depan, invoice lama yang jatuh temponya udah ditetapkan gak ikut geser.
- **AR Invoice** — piutang timbul, 1 kejadian "kirim barang, belum dibayar". Tiap invoice bikin 1 jurnal: **Debit Piutang Usaha, Kredit Pendapatan**. Jatuh tempo dihitung sekali saat invoice dibuat (dari termin customer saat itu) dan gak berubah lagi setelahnya, walau termin customer berubah belakangan.
- **AR Payment** — piutang berkurang, kejadian bayar beneran. Selalu nutup **1 invoice spesifik** (gak ada bayar gabungan beberapa invoice sekaligus), boleh **dicicil** (kurang dari sisa tagihan, 1 invoice boleh dibayar berkali-kali dari waktu ke waktu), tapi gak boleh **lebih dari sisa tagihan** (overpay ditolak keras — gak ada kelebihan bayar yang jadi saldo mengambang). Tiap pembayaran bikin 1 jurnal: **Debit Kas/Bank, Kredit Piutang Usaha**, sejumlah yang beneran dibayar.
  - **Kenapa cicil boleh tapi overpay gak boleh**: cicil adalah praktik dagang wajar — customer bayar sebagian, sisanya nanti, tetap taat ke invoice yang sama. Overpay beda soal — kalau dibiarkan, kelebihannya jadi saldo bebas yang bisa dipakai kapan saja ke invoice mana saja, rawan gak jelas pertanggungjawabannya. Makanya: cicil bebas, kelebihan bayar ditolak dari titik pencatatan.
- **Status invoice** (lunas/sebagian/belum) — selalu dihitung ulang dari total pembayaran yang sudah diterima dibanding nilai invoice, bukan status yang disimpan/di-update manual.

### Credit Hold — Tahan Kredit Customer Telat Bayar

**Cara Kerja**
- Kalau piutang customer ke perusahaan udah kelewat batas wajar, sales berhenti kasih termin baru sampai piutang lama beres. Ini level ke-2 dari 4 tindakan penjual ke piutang telat (reminder → **credit hold** → renegosiasi cicilan → write-off).
- Dua kondisi independen, salah satu kepenuhi langsung memicu hold:
  - **Nominal**: total piutang belum lunas customer (semua invoice yang masih terbuka, termasuk invoice baru yang mau dibuat) melebihi batas kredit yang ditetapkan buat customer itu. Kalau gak ada batas ditetapkan, gak ada batas nominal.
  - **Waktu**: ada piutang terbuka yang telatnya udah melebihi toleransi hari yang ditetapkan buat customer itu. Kalau gak ada toleransi ditetapkan, customer itu gak pernah kena hold dari sisi waktu.
- Status hold gak disimpan sebagai data tetap — selalu dihitung ulang tiap kali invoice baru mau dibuat. Kalau kena hold, invoice baru ditolak sebelum sempat tercatat.
- Customer on-hold tetap bisa dilayani asal bayar tunai langsung (bukan termin) — itu jalan sebagai penjualan tunai biasa, gak pernah jadi piutang.
- Toleransi keterlambatan defaultnya disamakan dengan termin pembayaran customer itu pas pertama kali diisi, tapi tetap bisa diubah manual per customer sesuai profil risikonya.

**Aturan Bisnis**
- Cek credit hold wajib jadi penghalang keras sebelum invoice baru tercatat — bukan cuma peringatan yang bisa dilewati.
- Status on-hold gak boleh disimpan sebagai data tetap yang di-update manual — harus selalu dihitung ulang biar gak basi.

**Skenario**
- Invoice baru ditolak karena credit hold — customer kelampaui batas kredit ATAU ada piutang telat lebih dari toleransinya.

**Common Mistakes**
- Cek credit hold cuma di tampilan (peringatan yang bisa di-skip) — harus jadi penolakan keras di titik pencatatan invoice.
- Nyimpen status "on hold" sebagai data tetap di profil customer — harus dihitung ulang tiap invoice baru dicek, biar gak ada resiko status basi (customer udah bayar tapi statusnya belum ke-update).

### Retur Barang (Credit Note)

Kalkulasi outstanding invoice (`ar_invoice_remaining()`) sekarang sudah mengikutsertakan saldo excess retur yang direklasifikasi keluar dari Piutang Usaha — padanan fix yang sudah lebih dulu diterapkan di sisi AP.

**Cara Kerja**
- Customer ngembaliin barang yang udah diinvoice — kejadian bisnis nyata (barang beneran balik), bukan koreksi "invoice salah dari awal". Invoice asli gak diubah/dibatalkan sama sekali — retur dicatat sebagai catatan tambahan yang mengurangi sisa tagihan.
- Dua jalur, otomatis terdeteksi dari jenis invoicenya (user gak perlu milih manual):
  - **Financial-only** — invoice yang barangnya gak dilacak stoknya (item yang emang gak diikutin lewat pencatatan stok, atau transaksi lama). Retur cukup 1 jurnal:
    ```
    Debit Retur & Potongan Penjualan
      Kredit Piutang Usaha
    ```
  - **Full (stok + HPP)** — invoice yang barangnya dilacak stok & harga pokoknya (metode Rata-Rata Tertimbang). Retur bikin 2 jurnal sekaligus:
    ```
    Debit Retur & Potongan Penjualan
      Kredit Piutang Usaha

    Debit Persediaan Barang Jadi
      Kredit Harga Pokok Penjualan
    ```
    Nilai HPP yang dibalik pakai harga **snapshot asli** pas barang itu keluar, bukan harga sekarang — biar konsisten sama biaya yang beneran diakui waktu itu. Barang yang balik masuk lagi ke stok yang aktif.
  - **Klasifikasi kondisi barang, per baris item (jalur full)** — tiap baris barang yang diretur wajib diklasifikasi kondisinya: **masih layak jual** (default, jurnal di atas berlaku apa adanya — barang balik masuk stok) atau **rusak** (barang gak akan pernah dijual lagi, gak boleh dianggap nambah nilai stok). Bedanya cuma di sisi cost, bukan di sisi piutang:
    ```
    Baris "masih layak jual":
      Debit Persediaan Barang Jadi
        Kredit Harga Pokok Penjualan
      (seperti biasa, balik masuk stok)

    Baris "rusak":
      Debit Beban Kerugian Barang Rusak
        Kredit Harga Pokok Penjualan
      (TIDAK balik masuk stok)
    ```
    Sisi kontra-revenue (Debit Retur & Potongan Penjualan / Kredit Piutang Usaha) tetap jalan **sama** buat kedua kondisi — customer tetap dapat kompensasi piutang berkurang, terlepas kondisi fisik barangnya (klaim balik dari customer dan nasib fisik barangnya adalah dua hal independen). 1 kejadian retur (1 credit note) boleh campur — sebagian baris layak jual, sebagian rusak, masing-masing punya perlakuan cost sendiri.
- Kenapa pakai akun kontra "Retur & Potongan Penjualan" (bukan langsung mengurangi Pendapatan Penjualan): biar "penjualan kotor" (nilai invoice asli) tetap keliatan utuh di histori, terpisah dari "berapa yang balik".
- Retur independen dari status bayar invoice — tetap bisa dibuat baik invoice-nya belum dibayar, sebagian, maupun udah lunas penuh.
- **Kalau invoice udah lunas, retur bikin sisa tagihan jadi negatif** — perusahaan "berutang" balik ke customer sejumlah itu. Butuh mekanisme sendiri buat ini, bukan cuma dibiarkan sebagai angka minus: tanpa itu, gak ada cara resmi buat customer mencairkan haknya, padahal secara bisnis dia berhak dapat refund atau ganti barang. Dicatat ke akun liability terpisah "Saldo Kredit Retur Customer" — biar riwayatnya tetap bisa ditelusuri balik ke retur mana yang jadi sumbernya.
- Kelebihan tagihan ini (**Saldo Kredit dari Retur**) terdeteksi otomatis begitu 1 retur bikin sisa tagihan invoice itu turun di bawah nol — bagian yang "kelebihan" (bukan seluruh nominal retur, cuma porsi yang gak ketampung sisa tagihan yang ada) langsung dicairkan jadi saldo resmi lewat jurnal reklasifikasi:
  ```
  Debit Piutang Usaha
    Kredit Saldo Kredit Retur Customer
  ```
- **Cuma SATU cara aktif nyelesaiin saldo ini ke depan** — TIDAK BOLEH "dititip"/dipakai motong invoice lain:
  1. **Direfund tunai** — Debit Saldo Kredit Retur Customer, Kredit Kas/Bank.
  2. *(Peninggalan data lama, gak berlaku transaksi baru)* — sebagian retur lama pernah otomatis "terbayar" pakai barang pengganti kalau retur itu diselesaikan lewat penukaran barang pasca-retur. Sejak keputusan penyeragaman dengan alur pembelian (lihat submodule "Penukaran Barang Pasca-Retur"), penukaran barang gak lagi berhubungan sama saldo kredit retur sama sekali — customer harus pilih SATU dari awal: retur (dapat kredit/diskon) atau ganti barang, gak bisa dua-duanya buat barang yang sama.
- Kenapa opsi "dipakai motong invoice lain" gak dibolehkan: sama alasan larangan overpay jadi saldo mengambang di Konsep Inti — gak mau ada saldo yang "ngambang" bisa dipakai kapan aja ke invoice mana aja.
- Sengaja gak ada batas waktu retur (umur invoice vs tanggal retur) — pernah ada, dicabut karena angkanya gak pernah punya dasar/justifikasi kuat. Retur diterima/ditolak sekarang murni keputusan manual staf di luar sistem.
- Batasan yang tetap dijaga otomatis: retur gak boleh dicatat ke periode akuntansi yang udah ditutup — ini soal integritas pembukuan umum (semua transaksi tunduk aturan ini), bukan aturan khusus retur.
- Retur bukan penukaran barang — retur cuma "barang balik", gak otomatis bikin barang pengganti keluar lagi. Penukaran barang pasca-retur (garansi) adalah submodule terpisah.

**Aturan Bisnis**
- Total retur (akumulasi) terhadap 1 invoice gak boleh ngelebihin nilai invoice itu (jalur financial-only) atau qty yang beneran terjual (jalur full).
- Retur harus tetap bisa dibuat walau invoice udah lunas/ada pembayaran — beda dari pembatalan invoice biasa yang menolak kalau udah ada pembayaran.
- Retur gak boleh dicatat ke periode yang sudah ditutup.
- Saldo kredit retur cuma boleh diselesaikan lewat refund tunai atau ganti barang — gak boleh dipakai motong invoice lain.
- Total yang dicairkan/disettle dari saldo kredit retur gak boleh melebihi nominal saldo yang tersisa.
- Klasifikasi kondisi (layak jual/rusak) ditentukan per baris item, bukan per keseluruhan credit note — 1 credit note boleh campur kondisi kalau isinya lebih dari 1 jenis barang.

**Skenario**
- Retur barang, invoice financial-only, belum lunas — sisa tagihan turun langsung dari nominal retur.
- Retur barang, invoice yang stoknya dilacak, udah lunas — 2 jurnal (kontra-revenue + reversal HPP), stok masuk lagi, sisa tagihan jadi negatif (jadi saldo kredit).
- Saldo kredit dari retur, direfund tunai — retur setelah invoice lunas bikin sisa tagihan negatif, excess-nya otomatis dicairkan jadi saldo resmi, lalu direfund tunai (satu-satunya cara aktif menyelesaikan saldo ini sekarang).
- Retur barang rusak, jalur full — kontra-revenue tetap jalan seperti retur biasa (piutang berkurang), tapi cost-nya diakui Beban Kerugian Barang Rusak, TIDAK balik masuk stok.
- Retur campuran dalam 1 credit note — sebagian baris item masih layak jual (balik stok), sebagian baris rusak (jadi beban), masing-masing baris diproses sesuai kondisinya sendiri-sendiri.

**Common Mistakes**
- Retur mereduksi Pendapatan Penjualan langsung (bukan lewat akun kontra) — bikin nilai "penjualan kotor" asli gak keliatan lagi di histori.
- Retur jalur full pakai harga sekarang buat reversal HPP/nilai stok balik (bukan harga snapshot asli) — bikin nilai stok gak konsisten kalau harga produksi udah berubah sejak barang itu keluar.
- Retur ditolak untuk invoice yang udah lunas/ada pembayaran — retur harus tetap bisa jalan, hasilnya boleh aja bikin saldo kredit.
- Bikin aturan baru "gak boleh retur ke periode tertutup" secara khusus — itu udah otomatis berlaku dari aturan umum integritas pembukuan, gak perlu aturan duplikat.
- Excess dari retur negatif dicatat ke akun saldo kredit yang sama dengan kelebihan bayar biasa — harus akun terpisah, beda asal jurnal.
- Excess dari retur dihitung dari seluruh nominal retur (bukan cuma bagian yang ngelebihin sisa tagihan) — bikin dobel hitung kalau sisa tagihannya masih ada sebagian.
- Kasih jalan lagi buat saldo kredit retur "dititip"/dipakai motong invoice lain — keputusan bisnis udah eksplisit cuma refund tunai.
- Barang rusak yang diretur ikut direstock ke stok aktif seolah masih layak jual — harus diakui sebagai Beban Kerugian Barang Rusak, bukan nambah Persediaan Barang Jadi. Kontra-revenue-nya (piutang berkurang) tetap jalan seperti biasa — yang beda cuma sisi cost/stoknya.

### Penukaran Barang Pasca-Retur (Garansi)

**Restrukturisasi (2026-09-03, keputusan owner)**: dulu penukaran barang harus menempel ke retur yang sudah tercatat, lalu membalikkan sebagian diskon retur biar customer gak dapat kompensasi dobel. Sekarang diseragamkan dengan cara pembelian menangani kasus serupa (tukar barang ke supplier) — customer harus pilih SATU jalan sejak awal: **retur (dapat kredit/diskon) ATAU ganti barang**, gak bisa dua-duanya buat barang yang sama. Karena pilihannya sudah dipisah sejak awal, penukaran barang sekarang gak perlu lagi "mengoreksi" apa pun — jadi lebih sederhana.

**Cara Kerja**
- Customer punya barang bermasalah (garansi kualitas) DAN minta barang pengganti — bukan hadiah, customer memang berhak dapat barang layak jual sebagai ganti barang cacat. Bedanya sama retur biasa: retur murni "barang balik, tagihan berkurang"; ini "barang cacat ditukar barang baik" — secara net customer tetap bayar penuh nilai barang yang akhirnya dia terima, cuma gak ada penerbitan tagihan baru buat barang pengganti itu.
- Kenapa gak lewat proses pengeluaran barang/penjualan biasa: proses itu selalu bikin tagihan baru (Debit Piutang Usaha, Kredit Pendapatan). Barang pengganti bukan penjualan baru, jadi kalau dipaksa lewat situ, piutang customer numpuk palsu dan Pendapatan Penjualan kegedean padahal bukan penjualan beneran.
- Jurnal cost barang pengganti — **satu-satunya jurnal** yang tercipta, gak ada jurnal lain:
  ```
  Debit Harga Pokok Penjualan
    Kredit Persediaan Barang Jadi
  ```
  Piutang Usaha customer sama sekali gak disentuh oleh penukaran barang — beda dari versi lama yang wajib bikin jurnal tambahan buat membalikkan diskon retur.
- **Satu barang, satu jalan kompensasi.** Begitu qty tertentu dari satu invoice udah "dipakai" lewat retur (dapat kredit/diskon), qty yang sama gak bisa lagi diajukan buat ganti barang — dan sebaliknya, qty yang udah dipakai ganti barang gak bisa lagi diretur. Sisa yang masih bisa diproses (baik lewat retur maupun ganti barang) selalu dihitung dari total qty terjual dikurangi SEMUA yang udah "diklaim" lewat jalur manapun — jadi gak peduli customer mau retur duluan atau ganti barang duluan, hasil akhirnya tetap konsisten: gak ada barang yang dikompensasi dua kali.
- **Ganti barang gak bisa diajukan buat tagihan yang gak pernah ada barang fisiknya** (misal tagihan jasa) — cuma berlaku buat tagihan yang beneran mengeluarkan barang dari gudang.
- Barang pengganti diambil dari stok aktif yang sama dengan stok jualan biasa — aman karena retur yang **rusak** (submodule "Retur Barang" di atas) TIDAK PERNAH masuk ke stok aktif sama sekali (langsung jadi Beban Kerugian Barang Rusak, gak direstock), jadi gak ada resiko barang cacat yang balik ikut kepakai lagi buat penukaran.

**Aturan Bisnis**
- Satu barang yang terjual cuma bisa dikompensasi lewat SATU jalan — retur atau ganti barang, gak bisa dua-duanya, berlaku dari sisi mana pun duluan diajukan.
- Ganti barang wajib menunjuk tagihan yang beneran punya barang fisik keluar — gak berlaku buat tagihan jasa/financial-only.
- Total qty yang ditukar (dikurangi yang udah diretur) gak boleh melebihi qty yang beneran terjual.

**Skenario**
- Penukaran barang pasca-retur/garansi — 1 jurnal (HPP/Persediaan Barang Jadi), gak nyentuh Piutang Usaha/Pendapatan sama sekali, dibatasi sisa qty yang belum "diklaim" lewat retur maupun ganti barang sebelumnya.

**Common Mistakes**
- Penukaran barang lewat proses pengeluaran barang biasa (bikin tagihan lagi) — piutang & pendapatan numpuk palsu padahal gak ada penjualan baru.
- Barang pengganti diambil dari stok bekas retur (barang rusak yang baru balik) — harusnya dari stok fresh/layak jual, barang rusak gak dipakai ganti lagi.
- Nganggep proteksi "gak boleh dikompensasi dobel" cukup dicek dari 1 arah aja (misal cuma pas mau ganti barang) — customer yang retur dulu BARU ganti barang buat barang yang sama juga harus tetap dicegah, bukan cuma arah sebaliknya.
- Mengira penukaran barang masih perlu menunjuk retur yang sudah ada — itu perilaku lama, sekarang keduanya berdiri sendiri-sendiri.

### Uang Muka / DP (Deposit)

**Cara Kerja**
- Customer bayar duluan sebelum ada invoice — biasanya buat pesanan/produk custom made-to-order yang belum dikerjain. Beda dari pembayaran biasa: pembayaran biasa selalu mengasumsikan ada tagihan yang mau dilunasin, sementara DP diterima sebelum tagihan itu ada sama sekali.
- Kenapa gak langsung dicatat sebagai pengurang Piutang Usaha kayak pembayaran biasa: karena piutangnya belum ada. Prinsip pengakuan pendapatan bilang pendapatan diakui pas barang/jasa diserahkan, bukan pas duit diterima — jadi DP itu bukan pendapatan, itu **kewajiban** (perusahaan "berutang" barang/jasa atau uang balik ke customer sampai pesanannya jadi). Dicatat ke akun liability "Uang Muka Penjualan".
- Empat kejadian, empat jurnal berbeda:
  1. **DP diterima** — Debit Kas/Bank, Kredit Uang Muka Penjualan. Belum nyentuh Piutang Usaha atau Pendapatan sama sekali.
  2. **DP diterapkan ke invoice** (begitu barang jadi & invoice diterbitkan) — Debit Uang Muka Penjualan, Kredit Piutang Usaha. Reklasifikasi, ngurangin sisa tagihan invoice itu.
  3. **DP hangus** (order dibatalin SEBELUM invoice ada, kebijakan non-refundable — umum dipakai kalau ada biaya yang udah kadung dikeluarkan buat penuhin pesanan custom itu) — Debit Uang Muka Penjualan, Kredit **Pendapatan Lain-lain** (bukan Pendapatan Penjualan — ini bukan hasil jual barang, jadi harus kepisah biar Laba Rugi gak nyampur "penjualan beneran" sama "DP hangus").
  4. **DP direfund tunai** (order dibatalin, tapi kali ini perusahaan yang memutuskan balikin duitnya — kasus khusus, kebijakan defaultnya tetap non-refundable) — Debit Uang Muka Penjualan, Kredit Kas/Bank. Gak ada dampak Laba Rugi sama sekali — murni uang balik ke customer, beda dari hangus yang jadi Pendapatan Lain-lain.
- **Penyelesaian 1 DP boleh campuran** — sebagian barang tetap dikirim (diterapkan ke invoice), sebagian duit dibalikin sebagai itikad baik (refund), sisanya baru dianggap hangus. Ketiga jalur ini sama-sama boleh sebagian-sebagian, asal totalnya gak ngelebihin nilai DP awal.
- **Interaksi sama pembatalan invoice**: kalau invoice yang DP-nya udah diterapkan ternyata perlu dibatalin (misal salah input), pembatalan itu ikut membalikkan jurnal penerapan DP-nya juga — biar DP-nya otomatis balik jadi belum dipakai (siap dipakai ulang/direfund/dihanguskan), bukan nyangkut jadi piutang minus yang gak jelas asalnya.

**Aturan Bisnis**
- DP gak boleh langsung diakui sebagai Pendapatan atau pengurang Piutang Usaha saat diterima — wajib lewat akun kewajiban dulu.
- DP hangus dicatat ke Pendapatan Lain-lain, bukan Pendapatan Penjualan biasa.
- Total penyelesaian DP (diterapkan + refund + hangus) gak boleh melebihi nilai DP awal.
- Kalau invoice yang DP-nya sudah diterapkan dibatalkan, penerapan DP itu wajib ikut dibalik.

**Skenario**
- DP diterima lalu diterapkan penuh ke invoice — 3 jurnal terpisah (terima DP, terbitkan invoice, terapkan DP), sisa tagihan invoice berkurang sejumlah DP.
- DP hangus — order dibatalin sebelum invoice ada, DP jadi Pendapatan Lain-lain, gak ada invoice yang pernah dibuat sama sekali.
- Invoice yang DP-nya udah diterapkan ternyata dibatalin (salah input) — pembatalan otomatis ikut membalikkan penerapan DP, DP balik jadi belum dipakai.

**Common Mistakes**
- Mengakui DP sebagai Pendapatan (atau langsung ngurangin Piutang Usaha) pas diterima — piutangnya belum ada, dan barang/jasanya belum diserahkan.
- DP hangus dicatat ke Pendapatan Penjualan biasa — harus ke Pendapatan Lain-lain, biar gak nyampur sama hasil jualan beneran.
- Batalin invoice yang DP-nya udah diterapkan tanpa ikut membalikkan penerapan DP-nya — Piutang Usaha customer itu bakal nyasar jadi minus, dan DP-nya nyangkut gak jelas statusnya.

### Piutang Tak Tertagih (Bad Debt Write-off)

**Cara Kerja**
- Piutang yang udah kelewat batas wajar (credit hold, reminder, dst) tapi tetap gak kunjung dibayar, sampai akhirnya jelas customer-nya gak akan pernah bisa/mau bayar (menghilang, tutup usaha, dsb). Ini level ke-4 (paling ekstrem) dari 4 tindakan penjual ke piutang telat.
- Kenapa bukan pembatalan invoice biasa: invoicenya **benar** dari awal — barang/jasa beneran diserahkan, Pendapatan yang diakui waktu itu valid dan tetap berdiri. Membalikkan Pendapatan akan salah merepresentasikan histori — penjualannya beneran kejadian, yang berubah cuma keyakinan piutangnya bisa dicairkan. Write-off mengakui **kerugian baru** di periode saat ketauan macetnya, bukan mengoreksi periode penjualan yang lama.
- Metode: **langsung dihapuskan** (bukan mencadangkan/estimasi), dipilih karena:
  - Gak ada data historis buat estimasi kredibel — usaha skala kecil/baru biasanya belum punya riwayat write-off yang cukup buat dasar estimasi.
  - Volume & materialitas kecil — piutang macet sifatnya jarang/satuan, bukan pola berulang skala besar.
  - Sesuai praktik pajak Indonesia — piutang tak tertagih buat badan usaha umum cuma diakui fiskus lewat metode langsung dihapuskan, bukan metode cadangan.
- Jurnal (1 kejadian = 1 jurnal, gak ada tahap estimasi terpisah):
  ```
  Debit Beban Piutang Tak Tertagih
    Kredit Piutang Usaha
  ```
- Write-off boleh sebagian (gak wajib penuh sejumlah sisa tagihan), tapi gak boleh ngelebihin sisa tagihan **riil** invoice itu (nilai invoice dikurangi SEMUA pengurang lain yang udah ada: pembayaran, retur, DP yang diterapkan) — beda dari retur yang sengaja boleh bikin sisa tagihan negatif, write-off gak masuk akal "menghapus" uang yang udah lunas/diretur/dikreditkan duluan lewat mekanisme lain.
- Invoice yang udah punya write-off gak bisa dibatalkan lewat jalur salah-input biasa — sama alasan invoice yang udah ada pembayaran: piutang ini udah "kesentuh" keputusan bisnis lain.
- **Di luar scope: recovery** (piutang yang udah di-write-off ternyata akhirnya kebayar juga). Metode langsung dihapuskan gak punya akun "cadangan" penyangga buat nampung kasus ini dengan mulus — kalau nanti beneran kejadian, butuh desain terpisah.

**Aturan Bisnis**
- Write-off gak boleh melebihi sisa tagihan riil invoice itu (setelah dikurangi semua pengurang lain yang sudah ada).
- Invoice yang sudah punya write-off gak bisa dibatalkan lewat jalur salah-input biasa.
- Pendapatan yang sudah diakui dari penjualan yang di-write-off gak boleh ikut dibalik.

**Skenario**
- Piutang tak tertagih (write-off) — pesanan custom yang customernya menghilang, Debit Beban Piutang Tak Tertagih, Kredit Piutang Usaha, Pendapatan asli gak dibalik.

**Common Mistakes**
- Write-off lewat pembatalan invoice biasa (membalikkan Pendapatan) — penjualannya beneran kejadian, gak boleh dianggap "gak pernah ada".
- Write-off ngelebihin sisa tagihan riil invoice (gak ngitung pengurang lain kayak pembayaran/retur/DP yang udah ada) — bisa "menghapus" uang yang sebenarnya udah lunas/diretur duluan.
- Pakai metode cadangan/estimasi buat usaha skala kecil tanpa data historis kerugian — estimasinya cuma tebakan, dan gak diakui fiskus buat badan usaha umum di Indonesia.

### Kategori Campur & PPN

**Cara Kerja**
- 1 invoice ke customer kadang isinya campuran kategori pendapatan — misal Rp500.000 Pendapatan Penjualan Barang + Rp20.000 Pendapatan Jasa Pengiriman, kalau perusahaan mau memisahkan kedua kategori itu di laporan. Dulu sistem cuma bisa mencatat 1 kategori pendapatan per invoice.
- Sekarang admin bisa menyiapkan daftar kategori pendapatan tambahan (misal "Jasa Pengiriman"), dan staf AR bisa menambahkan baris kategori itu saat membuat invoice — nominalnya tetap diinput manual per invoice, gak ada nilai default.
- PPN Keluaran (kalau relevan) dihitung otomatis oleh sistem dari tarif yang diset admin, ditambahkan ke Piutang Usaha (customer ikut berutang pajaknya) — bukan diketik manual.
- Berlaku juga untuk invoice yang lahir dari penjualan barang jadi (Goods Issue) — mekanismenya sama, cuma dipicu dari alur yang berbeda.

**Aturan Bisnis**
- Kategori campur tidak mengubah cara Credit Hold dihitung — tetap dicek terhadap total invoice (subtotal kategori + PPN kalau ada), bukan per-kategori.
- Staf AR tidak memilih akun pembukuan bebas untuk kategori tambahan — hanya dari daftar yang sudah disiapkan admin.

**Skenario**
- Invoice ke sebuah customer berisi Rp500.000 barang + Rp20.000 jasa antar — dicatat sebagai 1 invoice dengan 2 baris kategori pendapatan, Piutang Usaha tetap 1 angka Rp520.000.

**Common Mistakes**
- Memaksa invoice campuran jadi 1 kategori saja — bikin laporan pendapatan per channel jadi gak akurat.
- Membiarkan PPN Keluaran diketik manual di luar invoice — beresiko lupa dicatat atau gak nempel ke dokumen sumber yang benar.
