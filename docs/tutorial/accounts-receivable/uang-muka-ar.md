# Terima & Kelola Uang Muka (DP) dari Pelanggan

## Kapan Melakukan Ini

Saat pelanggan membayar sebagian di muka sebelum invoice-nya ada (mis. DP pemesanan). DP yang sudah diterima nanti punya 3 kemungkinan disposisi: diterapkan ke invoice yang muncul belakangan, direfund tunai, atau dihanguskan.

## Prasyarat

- Login dengan role **admin** atau **accountant**.
- Customer-nya sudah ada — kalau belum, buat dulu lewat [tambah-pelanggan-baru.md](tambah-pelanggan-baru.md).

## Langkah-Langkah

### 1. Terima DP

1. Buka menu **AR Deposits** (`/ar-deposits`), klik **+ New**.
2. Isi **Customer**, **Tanggal**, **Jumlah**.
3. Pilih metode **Akun Kas/Bank** (Tunai/Transfer Bank).
4. Klik **Simpan**.

### 2a. Terapkan DP ke invoice yang sudah ada

1. Buka detail invoice (`/ar-invoices/[id]`) yang mau dikurangi pakai DP ini.
2. Klik tombol **Terapkan DP**. Baca catatan di modal: ini reklasifikasi uang muka jadi pengurang piutang, **bukan pembayaran baru**.
3. Pilih **Deposit** dari dropdown (menampilkan sisa saldo tiap deposit yang masih aktif untuk customer ini).
4. **Nominal Diterapkan** otomatis terisi sebesar sisa deposit atau outstanding invoice (mana yang lebih kecil) — bisa diubah manual selama tidak melebihi keduanya.
5. Isi **Tanggal**, klik **Terapkan DP**.

### 2b. Refund tunai sisa DP (kalau tidak jadi dipakai)

1. Buka detail deposit (`/ar-deposits/[id]`), klik tombol **Refund** di tab terkait.
2. Isi **Nominal Refund** (maksimum sisa deposit, boleh sebagian), **Tanggal**, pilih metode **Akun Kas/Bank**.
3. Klik **Refund**.

### 2c. Hanguskan sisa DP (customer batal, DP tidak dikembalikan)

1. Buka detail deposit (`/ar-deposits/[id]`), tab **Hangus**, klik **Hanguskan**.
2. Isi **Nominal Hangus** (maksimum sisa deposit, boleh sebagian) dan **Tanggal**.
3. Klik **Hanguskan**.

## Hasil Akhir

- **Terima DP**: jurnal debit Kas/Bank, kredit Akun Uang Muka Penjualan (liability, bukan pendapatan — belum ada barang/jasa yang berpindah).
- **Terapkan DP**: jurnal debit Akun Uang Muka Penjualan, kredit Piutang Usaha — outstanding invoice berkurang tanpa ada kas baru masuk.
- **Refund**: jurnal debit Akun Uang Muka Penjualan, kredit Kas/Bank — murni reklasifikasi aset, tidak menyentuh Laba Rugi.
- **Hangus**: jurnal debit Akun Uang Muka Penjualan, kredit **Akun Pendapatan Lain-lain** (bukan Pendapatan Penjualan) — beda sumber pendapatan karena ini bukan hasil jual barang/jasa.
- Ketiga disposisi (terapkan/refund/hangus) boleh dilakukan sebagian — sisa deposit yang belum habis tetap bisa dipakai lagi lewat salah satu dari ketiganya di kemudian hari.

## Kesalahan Umum

- **Mengira "Terapkan DP" sama dengan mencatat pembayaran baru** — itu cuma reklasifikasi saldo yang sudah ada, beda dari [terima-pembayaran-ar.md](terima-pembayaran-ar.md) yang mencatat kas baru masuk.
- **Menghanguskan DP padahal customer masih mungkin balik pakai** — hangus sifatnya final untuk nominal yang dihanguskan (jadi pendapatan lain-lain); pastikan memang sudah tidak akan dipakai/direfund lagi.
- **Bingung kenapa deposit tidak muncul di dropdown "Terapkan DP"** — dropdown itu cuma menampilkan deposit milik customer yang sama dengan invoice-nya dan masih ada sisa saldo.
