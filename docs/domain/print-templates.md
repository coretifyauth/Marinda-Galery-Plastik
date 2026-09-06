# Cetak Dokumen Fisik

## Masalah yang Diselesaikan

Semua dokumen transaksional (AR Invoice, Purchase Order, dan seterusnya) hidup sebagai data digital di sistem. Tapi di dunia nyata, banyak dokumen ini butuh wujud fisik/cetak karena fungsinya beda-beda tergantung siapa pembacanya:

- **AR Invoice** — diserahkan ke customer sebagai bukti tagihan sah, sering jadi dasar customer klaim PPN masukan mereka sendiri.
- **Purchase Order** — dikirim ke supplier sebagai perintah beli resmi, jadi dasar supplier mulai proses kirim barang.
- Dokumen serah-terima fisik (Goods Receipt/Goods Issue) — dokumen yang ditandatangani langsung di tempat sebagai bukti barang berpindah tangan. **Belum dicakup fase ini.**

Solusinya: tiap halaman detail dokumen yang relevan dapat tombol "Cetak" yang membuka tampilan siap-print di window terpisah.

## Konsep Inti

Fitur ini pada dasarnya murni **layer presentasi** — gak ada tabel/data baru yang disimpan, cetakan dirender langsung dari data yang sudah ada di sistem (`ar_invoices`, `purchase_orders`, dst). Submodule "Kop Surat & Blok Tanda Tangan" di bawah nambahin 2 baris config (identitas perusahaan, daftar penandatangan) — tapi prinsipnya tetap sama: gak ada hasil cetak yang disimpan/di-generate terpisah, sumber datanya cuma ada 2 (data transaksi + config cetakan).

### Live Data, Bukan Snapshot Beku

**Cara Kerja**
- Setiap kali tombol "Cetak" ditekan, tampilan cetak dirender dari data **saat itu juga** (state yang sudah dimuat halaman detail) — bukan dari salinan/snapshot yang dibekukan waktu pertama kali dicetak.
- Konsekuensinya: mencetak ulang dokumen yang sama di waktu berbeda bisa menampilkan angka yang berbeda, kalau kondisi dokumennya berubah di antara dua waktu cetak itu (misal ada retur, pembayaran baru, atau pembatalan).

**Aturan Bisnis**
- Dokumen fisik hasil cetak adalah **representasi** dari data sistem, bukan sumber kebenaran independen. Sumber kebenaran selalu data di sistem — sejalan dengan prinsip "tiap transaksi harus tertelusuri ke dokumen sumber".
- Status non-normal (dibatalkan, dihapusbukukan) **wajib** ditampilkan jelas di cetakan (bukan disembunyikan) — supaya kertas yang beredar gak menyesatkan pembacanya.

**Skenario**
- Invoice `ARI-2026-00010` dicetak tanggal 1 Agustus (Total Rp1.110.000). Tanggal 5 Agustus ada retur sebagian. Kalau dicetak ulang tanggal 10 Agustus, yang keluar adalah outstanding **terkini** (sudah dikurangi retur) — bukan angka tanggal 1 Agustus.

**Common Mistakes**
- Berasumsi cetakan yang sudah beredar perlu "diawetkan" persis sama di sistem. Gak perlu — riwayat lengkapnya tetap ada lewat jurnal (invoice awal + jurnal retur/pembayaran), cuma cetakannya yang gak dibekukan.
- Mencetak dokumen yang sudah dibatalkan/dihapusbukukan tanpa indikasi apa pun di kertasnya — berisiko dianggap dokumen masih berlaku.

### Aturan Tampilan (berlaku di semua cetakan)

**Cara Kerja**
- **Harga per item wajib ditampilkan, bukan cuma qty** — kalau tabel item di sebuah cetakan punya data harga per unit yang tersedia (PO, GRN, Sales Order semuanya menyimpan harga/cost per unit di baris itemnya), harga & subtotal per baris harus ikut ditampilkan, gak cukup nama barang + qty saja.
- **Baris ringkasan yang nilainya kosong/nol gak ditampilkan** — kalau sebuah cetakan punya baris ringkasan yang datanya berasal dari relasi ke objek lain (misal Retur, DP Diterapkan), baris itu cuma muncul kalau nilainya benar-benar ada (> 0). Dokumen yang belum pernah kena retur gak perlu nunjukkan baris "Retur: Rp0" di kertas — bikin cetakan lebih ringkas dan gak menyiratkan seolah-olah ada retur yang nilainya nol.

**Aturan Bisnis**
- AR Invoice: harga per item cuma ada kalau baris itu fulfillment dari Sales Order (satu-satunya tempat harga jual per item tersimpan). Invoice dari jalur jual langsung (walk-in, gak lewat SO) gak punya harga per item di mana pun (nominal invoice cuma tersimpan sebagai total lump-sum per kategori) — tabel itemnya tetap qty-only, bukan berarti fiturnya belum lengkap.
- Baris ringkasan AR Invoice yang ikut aturan sembunyikan-kalau-nol: Terbayar, DP Diterapkan, Retur. Jumlah Invoice dan Outstanding SELALU tampil (bukan data relasi, itu angka inti dokumennya sendiri).
- Invoice yang punya kategori pendapatan tambahan (mis. ongkir) dan/atau PPN Keluaran wajib nampilin rinciannya per baris di cetakan, bukan cuma 1 angka total gabungan — pembaca kertas (customer) berhak tahu berapa yang murni harga barang vs biaya tambahan vs pajak.

**Common Mistakes**
- Mengira semua tabel item di semua cetakan otomatis dapat kolom harga — cuma kalau harga per unit itu memang tersimpan di data sumbernya. Mengarang harga (misal pakai cost/HPP sebagai pengganti harga jual) MALAH salah — HPP itu biaya kita, bukan harga yang ditagih ke customer, jangan ditampilkan sebagai "harga" di dokumen customer-facing.

### Cakupan Dokumen

**Cara Kerja**
- Baru **AR Invoice** dan **Purchase Order** yang punya tombol cetak. Dokumen transaksional lain (AP Bill, Goods Receipt, Goods Issue, dst) belum dicakup — pola implementasinya sama (reuse mekanisme yang sama, cukup tambah 1 handler per halaman detail) kalau suatu saat mau diperluas.

**Aturan Bisnis**
- AR Invoice: cetakan menampilkan info invoice (nomor, tanggal, jatuh tempo, customer), rincian barang (kalau invoice-nya "Full" — ada Goods Issue di baliknya) atau catatan "financial-only" (kalau gak ada barang fisik), dan ringkasan (jumlah, terbayar, DP, retur, write-off, outstanding).
- Purchase Order: cetakan menampilkan info PO (nomor, tanggal, estimasi tiba, supplier) dan tabel item pesanan (nama, qty, harga/unit, subtotal, total).

**Common Mistakes**
- Mengira semua dokumen transaksional otomatis bisa dicetak begitu fitur ini ada — cuma 2 jenis dokumen yang saat ini didukung.

### Kop Surat & Blok Tanda Tangan

**Cara Kerja**
- Cetakan AR Invoice dan Purchase Order sekarang punya **kop surat resmi** di atas (nama perusahaan, alamat, NPWP, logo kalau ada) dan **blok tanda tangan** di bawah (kolom per jabatan penandatangan, masing-masing cuma judul jabatan + garis kosong buat ditandatangani manual — bukan e-signature).
- Identitas perusahaan disimpan sebagai 1 baris konfigurasi tunggal (mirip pengaturan PPN) — admin isi/ubah lewat halaman Settings, bukan lewat kode.
- Daftar jabatan penandatangan (misal "Kepala Toko", "Bagian Gudang") juga dikelola admin lewat Settings — bisa ditambah, diurutkan (menentukan urutan kolom di kertas dari kiri ke kanan), dinonaktifkan sementara, atau dihapus permanen kalau memang gak relevan lagi.
- Sengaja **tanpa kolom nama pegawai** di daftar jabatan — cetakan cuma butuh nunjukkan siapa yang HARUS tanda tangan di posisi apa (berdasarkan jabatan), bukan mencatat nama orangnya di sistem.

**Aturan Bisnis**
- Kop surat & blok tanda tangan ikut aturan "Live Data" di atas — perubahan nama perusahaan atau daftar jabatan langsung kepakai di cetakan berikutnya, gak perlu update kode.
- Cuma jabatan yang statusnya aktif yang muncul di blok tanda tangan; jabatan yang dinonaktifkan sementara (bukan dihapus) gak muncul tapi datanya tetap ada kalau mau diaktifkan lagi.

**Skenario**
- Toko ganti alamat — admin update di Settings, cetakan invoice/PO berikutnya langsung pakai alamat baru, gak perlu ada yang deploy kode.
- Ada jabatan baru yang perlu ikut tanda tangan (misal "Bagian Gudang" ditambah selain "Kepala Toko") — admin tambah 1 baris di Settings, kolom tanda tangan baru otomatis muncul di cetakan berikutnya tanpa ubah apa pun di halaman invoice/PO.

**Common Mistakes**
- Menganggap blok tanda tangan butuh nama pegawai tersimpan di sistem — cukup jabatan, penandatanganan fisiknya manual di kertas.
- Mengira logo perusahaan bisa diunggah langsung ke sistem — fase ini cuma nerima link ke gambar yang sudah di-host di tempat lain.

## Glossary

- **Cetak (print template)**: tampilan siap-print 1 dokumen transaksi, dibuka di window baru, dirender live dari data terkini — bukan file/snapshot yang disimpan.
- **Kop surat**: identitas perusahaan (nama, alamat, NPWP, logo) yang muncul di bagian atas cetakan, dikelola sebagai 1 baris konfigurasi tunggal.
- **Blok tanda tangan**: kolom-kolom di bagian bawah cetakan (1 kolom per jabatan penandatangan aktif) — judul jabatan + garis kosong, ditandatangani manual di kertas.
