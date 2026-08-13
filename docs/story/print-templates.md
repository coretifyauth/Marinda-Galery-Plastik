# Cetak Dokumen Fisik — Toko Plastik Makmur Jaya

Pak Herman sering butuh kertas fisik buat diserahkan ke pelanggan grosir atau supplier — bukan cuma catatan di layar. Sekarang tiap halaman detail AR Invoice dan Purchase Order punya tombol **Cetak**.

## Skenario 1 — Cetak Invoice buat Toko Kelontong Sumber Rejeki

Toko Kelontong Sumber Rejeki baru saja ambil barang dan invoicenya sudah dibuat (`ARI-2026-00012`). Pak Herman buka **AR Invoices** → klik baris invoice itu → masuk halaman detail:

1. Di kanan atas, klik tombol **Cetak**.
2. Window baru terbuka menampilkan: nomor invoice, nama customer, tanggal invoice & jatuh tempo, tabel barang yang dikirim (kalau invoice ini lahir dari Goods Issue — ada barang fisik), dan ringkasan (Jumlah Invoice, Terbayar, DP Diterapkan, Retur, Outstanding).
3. Dialog print browser otomatis muncul — Pak Herman print langsung atau simpan sebagai PDF, lalu kasih ke Toko Kelontong Sumber Rejeki sebagai bukti tagihan.

**Kalau invoice-nya sudah ada perubahan status** (misal sudah dibatalkan atau dihapusbukukan sebagai piutang tak tertagih), cetakan otomatis menampilkan banner merah bertuliskan status itu — supaya siapa pun yang pegang kertasnya tahu dokumen ini sudah gak berlaku normal.

## Skenario 2 — Cetak PO buat PT Plastindo Jaya

Pak Herman baru bikin Purchase Order buat pesan ember plastik dari PT Plastindo Jaya (`PO-2026-00005`). Sebelum dikirim ke supplier, dia cetak dulu:

1. Buka **Purchase Orders** → klik PO itu → halaman detail.
2. Klik **Cetak**.
3. Window baru menampilkan: nomor PO, nama supplier, tanggal PO & estimasi tiba, tabel item pesanan (nama barang, qty, harga per unit, subtotal), dan total keseluruhan.
4. Dokumen ini yang dikirim/ditunjukkan ke PT Plastindo Jaya sebagai perintah beli resmi.

## Skenario 3 — Cetak Ulang Setelah Ada Retur

Invoice `ARI-2026-00012` (Skenario 1) dicetak tanggal 1 Agustus dengan Outstanding Rp1.110.000. Tanggal 5 Agustus, Toko Kelontong Sumber Rejeki retur sebagian barang. Kalau Pak Herman cetak ulang invoice yang sama tanggal 10 Agustus, angka Outstanding yang muncul **sudah otomatis terkoreksi** (dikurangi retur) — bukan angka lama tanggal 1 Agustus. Ini disengaja: cetakan selalu ambil data terkini, biar kertas yang dipegang gak menyesatkan soal berapa sisa tagihan yang benar.

## Skenario 4 — Invoice dari Sales Order Tampilkan Harga per Barang

Warung Bu Siti sempat pesan duluan lewat Sales Order (5 Ember Plastik @Rp60.000, 3 Kursi Plastik Lipat @Rp150.000) sebelum barangnya dikirim. Begitu invoicenya dicetak, tabel item **ikut menampilkan harga per barang & subtotal** — beda dari invoice jual langsung (walk-in) yang tabelnya cuma qty tanpa harga, karena SO memang mencatat harga per barang di depan waktu dipesan.

Ringkasan di cetakan juga cuma menampilkan baris yang relevan — kalau invoice ini belum pernah dibayar sebagian, belum ada DP, dan belum ada retur, baris "Terbayar"/"DP Diterapkan"/"Retur" gak ikut muncul di kertas. Yang selalu ada cuma Jumlah Invoice dan Outstanding.

## Yang Belum Ada (sengaja)

Cetakan belum punya kop surat resmi (nama toko, alamat, logo) atau kolom tanda tangan — untuk sekarang cetakan murni isi data transaksi. Dua hal ini dicatat sebagai pekerjaan lanjutan, belum jadi kebutuhan mendesak Pak Herman.
