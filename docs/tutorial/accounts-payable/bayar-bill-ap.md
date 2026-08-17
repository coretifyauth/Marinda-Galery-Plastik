# Bayar AP Bill

## Kapan Melakukan Ini

Saat kita membayar tagihan ke supplier yang masih outstanding — boleh dibayar penuh sekaligus atau dicicil bertahap.

## Prasyarat

- Login dengan role **admin** atau **accountant**.
- Bill-nya sudah ada dan belum lunas/dibatalkan (outstanding > 0). Kalau belum ada bill-nya, buat dulu lewat [buat-bill-ap.md](buat-bill-ap.md).

## Langkah-Langkah

1. Buka menu **AP Bills** (`/ap-bills`), klik baris bill yang mau dibayar untuk masuk ke halaman detailnya.
2. Klik tab **Pembayaran**.
3. Klik tombol **Bayar** (muncul kalau bill masih ada outstanding dan belum dibatalkan).
4. Cek panel preview jurnal di atas form.
5. Isi field:
   - **Tanggal** — tanggal pembayaran dilakukan.
   - **Jumlah dibayar** — boleh kurang dari sisa outstanding (dicicil), **tidak boleh lebih** (overpay ditolak sistem).
   - **Akun Kas/Bank** — klik tombol **Tunai** atau **Transfer Bank**; akun yang kepakai muncul otomatis di bawah tombol.
6. Klik **Simpan Pembayaran**.

## Hasil Akhir

- Baris pembayaran baru muncul di tab **Pembayaran** bill ini, dengan Source Ref otomatis.
- Jurnal otomatis terbentuk: debit Akun Utang Usaha, kredit Akun Kas/Bank (sesuai metode dipilih) — arahnya kebalik dari pembayaran AR karena di sini kita yang bayar, bukan menerima.
- Status bill berubah: **sebagian** kalau masih ada sisa outstanding, **lunas** kalau sudah dibayar penuh.
- Bill yang sudah punya minimal 1 pembayaran **tidak bisa lagi dibatalkan**.

## Kesalahan Umum

- **Mencoba bayar lebih dari sisa outstanding** — ditolak sistem (no-overpay), sama seperti pembayaran AR.
- **Salah pilih metode Tunai vs Transfer Bank** — pastikan sesuai kondisi fisik pembayaran, karena ini menentukan akun kas mana yang kena kredit.
