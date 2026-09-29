# Accounts Receivable — Nagih Piutang Termin

## Masalah yang Diselesaikan

General Ledger bisa nyatet piutang timbul (Debit Piutang Usaha) pas jual dengan termin. Tapi itu baru "kejadiannya kecatet" — belum ada mekanisme buat:

- Tau **siapa** yang berutang (identitas customer belum ada datanya sendiri, cuma nempel di catatan bebas transaksi jurnal).
- Tau **kapan jatuh tempo** tiap piutang, dan **berapa termin** yang disepakati per customer.
- Nyatet pelunasan dan tau **piutang mana yang udah/belum lunas**, termasuk kalau pelunasannya nyicil.
- Bikin **aging report** (piutang mana yang udah lewat jatuh tempo) buat nagih.

AR nutup gap ini: nambah lapisan "siapa berutang, berapa, kapan jatuh tempo, udah dibayar berapa" di atas General Ledger yang udah ada.

## Konsep Inti

- **Customer** — master data pelanggan yang berutang dengan termin. Punya termin default (misal net-7, net-14) yang dipakai ngitung jatuh tempo tiap invoice baru. Bukan data transaksional — kalau terminnya berubah, cukup diubah di data yang sama, gak perlu bikin catatan baru; perubahan cuma berlaku ke invoice **baru** ke depan, invoice lama yang jatuh temponya udah ditetapkan gak ikut geser.
- **AR Invoice** — piutang timbul, 1 kejadian "kirim barang, belum dibayar". Tiap invoice bikin 1 jurnal: **Debit Piutang Usaha, Kredit Pendapatan**. Jatuh tempo dihitung sekali saat invoice dibuat (dari termin customer saat itu) dan gak berubah lagi setelahnya, walau termin customer berubah belakangan.
- **AR Payment** — piutang berkurang, kejadian bayar beneran. Selalu nutup **1 invoice spesifik** (gak ada bayar gabungan beberapa invoice sekaligus), boleh **dicicil** (kurang dari sisa tagihan, 1 invoice boleh dibayar berkali-kali dari waktu ke waktu), tapi gak boleh **lebih dari sisa tagihan** (overpay ditolak keras — gak ada kelebihan bayar yang jadi saldo mengambang). Tiap pembayaran bikin 1 jurnal: **Debit Kas/Bank, Kredit Piutang Usaha**, sejumlah yang beneran dibayar.
  - **Kenapa cicil boleh tapi overpay gak boleh**: cicil adalah praktik dagang wajar — customer bayar sebagian, sisanya nanti, tetap taat ke invoice yang sama. Overpay beda soal — kalau dibiarkan, kelebihannya jadi saldo bebas yang bisa dipakai kapan saja ke invoice mana saja, rawan gak jelas pertanggungjawabannya. Makanya: cicil bebas, kelebihan bayar ditolak dari titik pencatatan.
- **Status invoice** (lunas/sebagian/belum) — selalu dihitung ulang dari total pembayaran yang sudah diterima dibanding nilai invoice, bukan status yang disimpan/di-update manual.

### Credit Hold

Tidak ada mekanisme penolakan otomatis untuk invoice baru berdasarkan batas kredit atau keterlambatan piutang customer — customer tidak punya batas kredit maupun toleransi keterlambatan yang disimpan/dicek sistem. Penagihan piutang telat ditangani lewat reminder dan renegosiasi cicilan, dilakukan manual oleh staf, bukan lewat blokir otomatis sistem.

### Diskon Penjualan (Trade Discount)

Diskon yang didukung sistem adalah **trade discount** — potongan yang disepakati di titik invoice/Sales Order dibuat, bukan diskon bersyarat waktu bayar (**cash/settlement discount**, misal term "2/10 net 30"). Bedanya penting: trade discount gak pernah punya baris jurnal sendiri (invoice langsung dicatat di nilai net), sementara cash discount butuh invoice dicatat di nilai kotor dulu lalu diakui belakangan pas pembayaran lewat akun kontra terpisah. Sistem ini sengaja cuma mendukung trade discount — cash discount di luar scope sekarang.

**Cara Kerja**
- Staf gak bisa mengetik nilai diskon bebas untuk penjualan — diskon HARUS berasal dari daftar aturan diskon yang disiapkan admin lebih dulu sebagai data master, prinsipnya sama dengan kategori pendapatan tambahan (staf gak bebas pilih hal finansial sendiri).
- Tiap aturan diskon ditempelkan ke SATU barang spesifik ATAU SATU kategori barang (gak bisa dua-duanya dalam 1 aturan yang sama) — nilainya persen atau nominal Rupiah, dipilih admin saat aturan itu dibuat.
- Diskon diterapkan OTOMATIS per baris barang, begitu barang yang dipilih staf cocok dengan aturan yang aktif — staf gak memilih aturan mana yang dipakai secara manual, sistem yang mencocokkan.
- Kalau 1 barang cocok ke 2 aturan sekaligus (aturan khusus barang itu DAN aturan kategori yang menaunginya), aturan yang lebih spesifik (langsung ke barang) yang menang. Supaya konflik ini gak pernah numpuk jadi rumit, tiap barang cuma boleh punya SATU aturan aktif, dan tiap kategori juga cuma boleh punya SATU aturan aktif — jadi ambiguitas cuma bisa terjadi di 1 bentuk (barang vs kategori penaungnya), gak pernah aturan-vs-aturan di level yang sama.
- Nilai diskon per baris dihitung & disimpan permanen begitu barisnya dibuat (snapshot) — kalau aturan diskonnya diubah/diarsipkan belakangan, transaksi yang udah terlanjur dibuat gak ikut berubah, sama seperti pola snapshot harga/termin lain di sistem ini.
- Diskon di level dokumen (total invoice) bukan input terpisah — murni akumulasi dari diskon tiap baris barang yang kena aturan, ditampilkan sebagai 1 angka ringkasan di atas baris-baris item.
- Cuma berlaku buat invoice yang punya baris barang fisik (dari Sales Order, Jual Barang Langsung/Goods Issue, atau checkout kasir/POS) — invoice financial-only (jasa, tanpa referensi barang) gak pernah kena diskon ini karena gak ada barang yang bisa dicocokkan ke aturan.
- **Berlaku juga di kasir (POS)**, otomatis, tanpa kasir pilih apa pun — sama prinsipnya kayak sisi admin. Bedanya cuma di titik komputasinya: sisi admin (Sales Order/Goods Issue) dihitung di lapisan aplikasi lalu dipercaya oleh RPC (staf yang menjalankannya sudah role admin/accountant), sementara checkout POS dihitung ULANG di dalam RPC `create_pos_sale` sendiri (server-side, gak dipercaya dari aplikasi kasir) — karena RPC itu dirancang gak pernah mempercayai nilai apa pun dari sisi kasir sejak awal (role `cashier` akses lebih terbatas). Lihat `docs/architecture/item-discount-rules-schema.md` buat detail teknisnya.

**Aturan Bisnis**
- Staf tidak bisa menginput nilai diskon bebas untuk penjualan — hanya dari aturan diskon aktif yang sudah disiapkan admin.
- 1 barang cuma boleh dinaungi 1 aturan diskon aktif, 1 kategori juga cuma boleh dinaungi 1 aturan diskon aktif.
- Kalau barang match ke aturan barang DAN aturan kategori sekaligus, aturan barang (lebih spesifik) yang menang.
- Nilai diskon disimpan sebagai snapshot per baris transaksi — perubahan/pengarsipan aturan diskon di kemudian hari gak mengubah transaksi yang sudah terlanjur dibuat.
- Diskon penjualan gak pernah menghasilkan baris jurnal terpisah — nilai invoice yang tercatat sudah net dari awal.
- Berlaku di semua jalur penjualan barang fisik: Sales Order, Jual Barang Langsung, maupun checkout kasir (POS).

**Skenario**
- Barang "Kopi Robusta 250gr" punya aturan diskon aktif 10% — staf bikin Sales Order pilih barang ini, sistem otomatis potong 10% dari harga jual satuan itu di baris tersebut, invoice yang lahir dari situ sudah net.
- Kategori "Minuman Kemasan" punya aturan diskon aktif Rp2.000/unit, tapi barang "Teh Botol 350ml" (masuk kategori itu) juga punya aturan diskon khusus 5% — yang dipakai buat barang ini aturan barangnya (5%), aturan kategori diabaikan untuk barang ini.
- Invoice jasa (financial-only, gak ada baris barang) — gak ada diskon yang bisa diterapkan sama sekali, karena gak ada barang untuk dicocokkan ke aturan.

**Common Mistakes**
- Membiarkan staf mengetik nilai diskon bebas di form invoice/Sales Order — melanggar aturan "harus dari master data", buka celah diskon sembarangan tanpa kendali admin.
- Membolehkan 2 aturan aktif menaungi barang/kategori yang sama — bikin ambigu aturan mana yang harus dipakai.
- Menghitung ulang diskon dari aturan TERKINI tiap invoice lama dibuka — harusnya pakai nilai snapshot yang udah disimpan saat baris itu dibuat, bukan dihitung ulang.
- Membuat baris jurnal "Diskon Penjualan" terpisah — trade discount gak pernah punya baris jurnal sendiri, beda dari cash discount yang sengaja gak diimplementasi sekarang.
- Mempercayai nilai diskon yang dikirim aplikasi kasir apa adanya di `create_pos_sale` — beda dari RPC sisi admin, RPC ini `security definer` buat role `cashier` yang aksesnya terbatas, jadi WAJIB menghitung ulang sendiri aturan mana yang berlaku di server, bukan trust dari client.

### Beli N Gratis X (Bundle Promo)

Mekanisme promo kedua, **berbeda** dari Diskon Penjualan di atas — bukan variasi darinya. Diskon Penjualan berbasis **harga** (qty yang dibawa pulang customer tetap sama, cuma harga per unit yang dipotong). Bundle Promo berbasis **kuantitas** — customer bawa pulang barang LEBIH BANYAK dari yang dia bayar (misal "beli 2 Sabun gratis 1 Shampo"), sehingga ada dampak stok fisik ekstra (barang hadiah beneran keluar gudang) yang gak ada di Diskon Penjualan biasa.

**Cara Kerja**
- Barang pemicu (yang harus dibeli) SELALU barang spesifik, bukan kategori (beda dari Diskon Penjualan yang boleh kategori) — di dunia nyata promo jenis ini hampir selalu soal 1 produk spesifik, bukan "barang apa saja dari kategori X".
- Barang hadiah BOLEH beda dari barang pemicu (misal beli Sabun gratis Shampo), atau boleh juga barang yang sama (misal beli 2 Kopi gratis 1 Kopi yang sama) — keduanya sama-sama didukung lewat struktur yang sama, cuma beda apakah kedua sisinya nunjuk barang yang sama atau beda.
- Aturan promo terdiri dari: barang pemicu, qty beli minimal (N), barang hadiah, qty gratis per set (X). Sistem otomatis mencocokkan — staf gak pilih aturan mana yang dipakai secara manual, sama prinsipnya dengan Diskon Penjualan.
- **Berulang tiap kelipatan penuh** — kalau syarat "beli 2" dan customer beli 5 barang pemicu, itu dihitung 2 set penuh (4 unit terpakai, dapat 2 unit gratis) + sisa 1 unit yang gak cukup buat set berikutnya (dibayar penuh, gak dapat apa-apa). Bukan cuma berlaku 1x per transaksi berapa pun qty-nya.
- **Barang hadiah harus BENERAN ada sebagai baris tersendiri di invoice/keranjang** (staf/kasir tetap harus pilih/scan barang hadiahnya secara fisik seperti barang biasa) — sistem TIDAK PERNAH menambahkan barang ke invoice secara otomatis. Begitu syarat qty barang pemicu terpenuhi DAN barang hadiahnya ada di baris, sistem mengoreksi HARGA baris barang hadiah itu jadi Rp0 (sampai batas qty gratis yang didapat, gak melebihi qty barang hadiah yang beneran ada di baris itu). Kalau customer gak ambil barang hadiahnya sama sekali, gak ada apa pun yang terjadi — invoice tetap harga penuh, karena gak ada barang hadiah yang keluar dari gudang untuk dikoreksi harganya.
- **Ditangani dengan Cara A** (lihat perbandingan di bawah) — TIDAK ada baris jurnal "Beban Promosi" terpisah. Barang hadiah yang keluar tetap lewat jurnal HPP/Persediaan Barang Jadi yang sama seperti penjualan normal (HPP diakui dari cost barang yang keluar, gak peduli harga jualnya Rp0 atau bukan) — cuma Pendapatan Penjualan buat baris itu yang jadi Rp0.
- **Perbandingan Cara A vs Cara B** (2 cara akuntansi menangani barang gratis — sistem ini cuma mendukung Cara A):
  - **Cara A (dipakai sistem ini)** — barang gratis dianggap bagian dari penjualan biasa, harga baris itu dikoreksi jadi Rp0, HPP-nya tetap lewat akun HPP normal. Sederhana, gak butuh akun baru.
  - **Cara B (TIDAK diimplementasikan)** — barang gratis dipisah sebagai "Beban Promosi" (Debit Beban Promosi, Kredit Persediaan Barang Jadi), bukan lewat HPP. Lebih presisi buat lihat "total nilai barang gratis yang dikasih buat promo" sebagai angka laporan tersendiri, tapi butuh akun baru + pemisahan jurnal HPP normal vs promosi.
- Berlaku sama persis di sisi admin (Sales Order/Goods Issue) maupun kasir (POS) — sama seperti Diskon Penjualan, dengan perbedaan titik komputasi yang sama (admin: dihitung aplikasi lalu dipercaya RPC; POS: dihitung ulang di dalam `create_pos_sale`).
- 1 barang pemicu boleh punya LEBIH DARI 1 aturan bundle aktif sekaligus, dengan barang hadiah yang berbeda-beda (misal "beli 2 Sabun gratis 1 Shampo" DAN "beli 3 Sabun gratis 1 Kondisioner" boleh aktif bersamaan) — beda dari Diskon Penjualan yang dibatasi 1 aturan aktif per barang, karena di sini ambiguitasnya dicegah lewat kombinasi (barang pemicu, barang hadiah), bukan per barang pemicu doang.

**Aturan Bisnis**
- Barang pemicu wajib barang spesifik (gak boleh kategori).
- Barang hadiah wajib ada sebagai baris tersendiri di invoice/keranjang yang sama — sistem gak pernah menambahkan barang secara otomatis.
- Diskon (harga jadi Rp0) dibatasi qty gratis yang beneran didapat dari perhitungan kelipatan, DAN gak boleh melebihi qty barang hadiah yang ada di baris itu.
- Promo berulang tiap kelipatan penuh dari qty beli minimal, sisa yang gak cukup 1 kelipatan dibayar harga penuh.
- Gak ada baris jurnal "Beban Promosi" — barang hadiah tetap lewat HPP normal (Cara A).
- Berlaku di semua jalur penjualan barang fisik (Sales Order, Goods Issue, POS) — sama seperti Diskon Penjualan.
- Boleh lebih dari 1 aturan aktif per barang pemicu, asal kombinasi (barang pemicu, barang hadiah)-nya beda.

**Skenario**
- Beli 2 Sabun (Rp10.000/pcs), promo aktif "beli 2 Sabun gratis 1 Shampo" (Rp15.000/pcs), customer juga ambil 1 Shampo — baris Sabun tetap Rp20.000, baris Shampo jadi Rp0 (HPP Shampo tetap diakui normal).
- Customer beli 5 Sabun (bukan kelipatan bersih dari 2) dengan promo yang sama, ambil 2 Shampo — dapat 2 set penuh (4 Sabun terpakai) = 2 Shampo gratis, sisa 1 Sabun dibayar penuh. Kedua baris Shampo jadi Rp0 (pas dengan qty gratis yang didapat).
- Customer beli 2 Sabun tapi gak ambil Shampo sama sekali — invoice cuma ada baris Sabun, harga penuh, gak ada yang gratis.
- Customer beli 2 Sabun, ambil 3 Shampo — cuma 1 Shampo yang jadi Rp0 (sesuai qty gratis yang didapat dari 1 set), 2 Shampo lainnya dibayar harga penuh.

**Common Mistakes**
- Menambahkan barang hadiah otomatis ke invoice/keranjang tanpa staf/kasir pilih — barang fisik gak boleh "dipaksa keluar" dari gudang tanpa benar-benar dipilih.
- Mencatat barang hadiah sebagai Beban Promosi terpisah — sistem ini pakai Cara A, bukan Cara B.
- Membolehkan barang pemicu berupa kategori — sengaja dibatasi ke barang spesifik biar gak ada ambiguitas penjumlahan qty lintas barang beda dalam 1 kategori.
- Cuma menghitung 1x diskon berapa pun qty yang dibeli — harusnya berulang tiap kelipatan penuh dari qty beli minimal.
- Diskon baris hadiah melebihi qty yang beneran ada di baris itu — harus dibatasi qty barang hadiah yang benar-benar dipilih, gak boleh "berutang" gratis ke qty yang belum ada.

### Retur Barang (Credit Note)

Kalkulasi outstanding invoice (`ar_invoice_remaining()`) mengikutsertakan saldo excess retur yang direklasifikasi keluar dari Piutang Usaha, sama seperti di sisi AP.

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
    Nilai HPP yang dibalik pakai harga **snapshot asli** pas barang itu keluar, bukan harga sekarang — biar konsisten sama biaya yang beneran diakui waktu itu. Barang yang balik masuk lagi ke stok yang aktif — **semua barang retur jalur full selalu direstock**, gak ada lagi klasifikasi kondisi (layak jual/rusak) per baris di titik retur ini. Kalau ternyata barang yang balik itu rusak, itu ditangani belakangan lewat penyesuaian Stock Opname terpisah (submodule "Stock Opname" di `docs/domain/inventory.md`) — bukan bagian dari alur retur.
- Kenapa pakai akun kontra "Retur & Potongan Penjualan" (bukan langsung mengurangi Pendapatan Penjualan): biar "penjualan kotor" (nilai invoice asli) tetap keliatan utuh di histori, terpisah dari "berapa yang balik".
- Retur independen dari status bayar invoice — tetap bisa dibuat baik invoice-nya belum dibayar, sebagian, maupun udah lunas penuh.
- **Kalau invoice udah lunas, retur bikin sisa tagihan jadi negatif** — perusahaan "berutang" balik ke customer sejumlah itu. Butuh mekanisme sendiri buat ini, bukan cuma dibiarkan sebagai angka minus: tanpa itu, gak ada cara resmi buat customer mencairkan haknya, padahal secara bisnis dia berhak dapat refund atau ganti barang. Dicatat ke akun liability terpisah "Saldo Kredit Retur Customer" — biar riwayatnya tetap bisa ditelusuri balik ke retur mana yang jadi sumbernya.
- Kelebihan tagihan ini (**Saldo Kredit dari Retur**) terdeteksi otomatis begitu 1 retur bikin sisa tagihan invoice itu turun di bawah nol — bagian yang "kelebihan" (bukan seluruh nominal retur, cuma porsi yang gak ketampung sisa tagihan yang ada) langsung dicairkan jadi saldo resmi lewat jurnal reklasifikasi:
  ```
  Debit Piutang Usaha
    Kredit Saldo Kredit Retur Customer
  ```
- **Cuma SATU cara aktif nyelesaiin saldo ini** — TIDAK BOLEH "dititip"/dipakai motong invoice lain:
  1. **Direfund tunai** — Debit Saldo Kredit Retur Customer, Kredit Kas/Bank.

  Penukaran barang pasca-retur (lihat submodule "Penukaran Barang Pasca-Retur") gak berhubungan sama saldo kredit retur sama sekali — customer harus pilih SATU dari awal: retur (dapat kredit/diskon) atau ganti barang, gak bisa dua-duanya buat barang yang sama.
- Kenapa opsi "dipakai motong invoice lain" gak dibolehkan: sama alasan larangan overpay jadi saldo mengambang di Konsep Inti — gak mau ada saldo yang "ngambang" bisa dipakai kapan aja ke invoice mana aja.
- Sengaja gak ada batas waktu retur (umur invoice vs tanggal retur). Retur diterima/ditolak murni keputusan manual staf di luar sistem.
- Batasan yang tetap dijaga otomatis: retur gak boleh dicatat ke periode akuntansi yang udah ditutup — ini soal integritas pembukuan umum (semua transaksi tunduk aturan ini), bukan aturan khusus retur.
- Retur bukan penukaran barang — retur cuma "barang balik", gak otomatis bikin barang pengganti keluar lagi. Penukaran barang pasca-retur (garansi) adalah submodule terpisah.

**Aturan Bisnis**
- Total retur (akumulasi) terhadap 1 invoice gak boleh ngelebihin nilai invoice itu (jalur financial-only) atau qty yang beneran terjual (jalur full).
- Retur harus tetap bisa dibuat walau invoice udah lunas/ada pembayaran — beda dari pembatalan invoice biasa yang menolak kalau udah ada pembayaran.
- Retur gak boleh dicatat ke periode yang sudah ditutup.
- Saldo kredit retur cuma boleh diselesaikan lewat refund tunai — gak boleh dipakai motong invoice lain, dan gak berhubungan sama penukaran barang pasca-retur (2 mekanisme independen, lihat submodule "Penukaran Barang Pasca-Retur").
- Total yang dicairkan/disettle dari saldo kredit retur gak boleh melebihi nominal saldo yang tersisa.

**Skenario**
- Retur barang, invoice financial-only, belum lunas — sisa tagihan turun langsung dari nominal retur.
- Retur barang, invoice yang stoknya dilacak, udah lunas — 2 jurnal (kontra-revenue + reversal HPP), stok masuk lagi, sisa tagihan jadi negatif (jadi saldo kredit).
- Saldo kredit dari retur, direfund tunai — retur setelah invoice lunas bikin sisa tagihan negatif, excess-nya otomatis dicairkan jadi saldo resmi, lalu direfund tunai (satu-satunya cara aktif menyelesaikan saldo ini sekarang).

**Common Mistakes**
- Retur mereduksi Pendapatan Penjualan langsung (bukan lewat akun kontra) — bikin nilai "penjualan kotor" asli gak keliatan lagi di histori.
- Retur jalur full pakai harga sekarang buat reversal HPP/nilai stok balik (bukan harga snapshot asli) — bikin nilai stok gak konsisten kalau harga produksi udah berubah sejak barang itu keluar.
- Retur ditolak untuk invoice yang udah lunas/ada pembayaran — retur harus tetap bisa jalan, hasilnya boleh aja bikin saldo kredit.
- Bikin aturan baru "gak boleh retur ke periode tertutup" secara khusus — itu udah otomatis berlaku dari aturan umum integritas pembukuan, gak perlu aturan duplikat.
- Excess dari retur negatif dicatat ke akun saldo kredit yang sama dengan kelebihan bayar biasa — harus akun terpisah, beda asal jurnal.
- Excess dari retur dihitung dari seluruh nominal retur (bukan cuma bagian yang ngelebihin sisa tagihan) — bikin dobel hitung kalau sisa tagihannya masih ada sebagian.
- Kasih jalan lagi buat saldo kredit retur "dititip"/dipakai motong invoice lain — keputusan bisnis udah eksplisit cuma refund tunai.
- Nyoba klasifikasi kondisi barang (layak jual/rusak) di titik retur — itu bukan lagi tanggung jawab alur retur, barang rusak ditangani belakangan lewat Stock Opname setelah retur selesai direstock.

### Penukaran Barang Pasca-Retur (Garansi)

Penukaran barang berdiri sendiri dari retur, diseragamkan dengan cara pembelian menangani kasus serupa (tukar barang ke supplier) — customer harus pilih SATU jalan sejak awal: **retur (dapat kredit/diskon) ATAU ganti barang**, gak bisa dua-duanya buat barang yang sama. Karena pilihannya dipisah sejak awal, penukaran barang gak perlu "mengoreksi" apa pun.

**Cara Kerja**
- Customer punya barang bermasalah (garansi kualitas) DAN minta barang pengganti — bukan hadiah, customer memang berhak dapat barang layak jual sebagai ganti barang cacat. Bedanya sama retur biasa: retur murni "barang balik, tagihan berkurang"; ini "barang cacat ditukar barang baik" — secara net customer tetap bayar penuh nilai barang yang akhirnya dia terima, cuma gak ada penerbitan tagihan baru buat barang pengganti itu.
- Kenapa gak lewat proses pengeluaran barang/penjualan biasa: proses itu selalu bikin tagihan baru (Debit Piutang Usaha, Kredit Pendapatan). Barang pengganti bukan penjualan baru, jadi kalau dipaksa lewat situ, piutang customer numpuk palsu dan Pendapatan Penjualan kegedean padahal bukan penjualan beneran.
- Jurnal cost barang pengganti — **satu-satunya jurnal** yang tercipta, gak ada jurnal lain:
  ```
  Debit Harga Pokok Penjualan
    Kredit Persediaan Barang Jadi
  ```
  Piutang Usaha customer sama sekali gak disentuh oleh penukaran barang.
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
- Mengira penukaran barang perlu menunjuk retur yang sudah ada — keduanya berdiri sendiri-sendiri, gak saling bergantung.

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

Tidak ada mekanisme write-off untuk piutang yang beneran gak akan tertagih — piutang tetap tercatat apa adanya sampai dilunasi atau diretur, gak ada jalur khusus buat "menghapusnya" dari pembukuan.

### Kategori Campur & PPN

**Cara Kerja**
- 1 invoice ke customer kadang isinya campuran kategori pendapatan — misal Rp500.000 Pendapatan Penjualan Barang + Rp20.000 Pendapatan Jasa Pengiriman, kalau perusahaan mau memisahkan kedua kategori itu di laporan.
- Admin bisa menyiapkan daftar kategori pendapatan tambahan (misal "Jasa Pengiriman"), dan staf AR bisa menambahkan baris kategori itu saat membuat invoice — nominalnya tetap diinput manual per invoice, gak ada nilai default.
- PPN Keluaran (kalau relevan) dihitung otomatis oleh sistem dari tarif yang diset admin, ditambahkan ke Piutang Usaha (customer ikut berutang pajaknya) — bukan diketik manual.
- Berlaku juga untuk invoice yang lahir dari penjualan barang jadi (Goods Issue) — mekanismenya sama, cuma dipicu dari alur yang berbeda.

**Aturan Bisnis**
- Staf AR tidak memilih akun pembukuan bebas untuk kategori tambahan — hanya dari daftar yang sudah disiapkan admin.

**Skenario**
- Invoice ke sebuah customer berisi Rp500.000 barang + Rp20.000 jasa antar — dicatat sebagai 1 invoice dengan 2 baris kategori pendapatan, Piutang Usaha tetap 1 angka Rp520.000.

**Common Mistakes**
- Memaksa invoice campuran jadi 1 kategori saja — bikin laporan pendapatan per channel jadi gak akurat.
- Membiarkan PPN Keluaran diketik manual di luar invoice — beresiko lupa dicatat atau gak nempel ke dokumen sumber yang benar.
