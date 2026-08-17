# Terima Pembayaran AR Invoice

## Kapan Melakukan Ini

Saat pelanggan membayar invoice yang masih outstanding — boleh dibayar penuh sekaligus atau dicicil bertahap.

## Prasyarat

- Login dengan role **admin** atau **accountant**.
- Invoice-nya sudah ada dan belum lunas/dibatalkan (outstanding > 0). Kalau belum ada invoice-nya, buat dulu lewat [buat-invoice-ar.md](buat-invoice-ar.md).

## Langkah-Langkah

1. Buka menu **AR Invoices** (`/ar-invoices`), klik baris invoice yang mau dibayar untuk masuk ke halaman detailnya.
2. Klik tab **Pembayaran**.
3. Klik tombol **Bayar** (tombol ini cuma muncul kalau invoice masih ada outstanding dan belum dibatalkan).
4. Di modal **Catat Pembayaran**, cek dulu panel preview jurnal di atas form — menunjukkan akun mana yang bakal didebit/dikredit.
5. Isi field:
   - **Tanggal** — tanggal pembayaran diterima.
   - **Jumlah dibayar** — boleh kurang dari sisa outstanding (dicicil), **tidak boleh lebih** (overpay ditolak sistem). Batas maksimum ditampilkan di label field ini.
   - **Akun Kas/Bank** — klik tombol **Tunai** atau **Transfer Bank** untuk memilih metode pembayaran; akun yang kepakai muncul otomatis di bawah tombol (tidak perlu pilih akun manual).
6. Klik **Simpan Pembayaran**.

## Hasil Akhir

- Baris pembayaran baru muncul di tab **Pembayaran** invoice ini, dengan Source Ref otomatis.
- Jurnal otomatis terbentuk: debit Akun Kas/Bank (sesuai metode dipilih), kredit Akun Piutang Usaha.
- Status invoice di daftar **AR Invoices** berubah: **sebagian** kalau masih ada sisa outstanding, **lunas** kalau sudah dibayar penuh.
- Invoice yang sudah punya minimal 1 pembayaran **tidak bisa lagi dibatalkan** — piutangnya sudah "kesentuh" transaksi lain.

## Kesalahan Umum

- **Mencoba bayar lebih dari sisa outstanding** — sistem menolak keras (no-overpay), bukan otomatis dianggap DP/kelebihan bayar. Kalau memang ada pembayaran lebih, catat sisanya lewat mekanisme DP terpisah, bukan dipaksa masuk ke pelunasan invoice ini.
- **Salah pilih metode Tunai vs Transfer Bank** — ini menentukan akun kas mana yang kena debit; kalau salah pilih, saldo Kas Toko dan Kas di Bank bisa jadi tidak sesuai kondisi fisik/rekening yang sebenarnya.
- **Berharap bisa membatalkan invoice setelah ada pembayaran masuk** — begitu ada 1 baris pembayaran, tombol batalkan invoice tidak akan tersedia lagi.
