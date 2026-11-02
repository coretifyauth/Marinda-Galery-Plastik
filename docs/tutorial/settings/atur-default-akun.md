# Atur Default Akun

## Kapan Melakukan Ini

Sebelum modul transaksi (AR, AP, Inventory) bisa dipakai dengan benar — hampir semua form transaksi (AR Invoice, AP Bill, pembayaran, Goods Receipt, dst) memakai akun yang **dikunci otomatis** dari sini, bukan dropdown akun bebas. Kalau slot ini belum diisi, field akun terkait di form transaksi akan menampilkan peringatan "akun belum diset admin".

## Prasyarat

- Login dengan role **admin** (beda dari kebanyakan form transaksi lain, tab pengaturan ini **tidak bisa diubah oleh role accountant**, cuma bisa dilihat).
- Akun-akun yang akan dipakai sudah ada di Chart of Accounts — kalau belum, buat dulu lewat [tambah-akun-baru.md](../chart-of-accounts/tambah-akun-baru.md).

## Langkah-Langkah

### Default Akun (slot tunggal per peran)

1. Buka menu **Settings** (`/settings/charges`), tab **Default Akun** (tab default saat halaman dibuka).
2. Tabel menampilkan daftar **Slot** (mis. Piutang Usaha, Utang Usaha, Kas Tunai, Kas Bank, Persediaan Bahan Baku, dst — baris-baris ini sudah disiapkan sistem, tidak bisa ditambah/dihapus dari sini) beserta akun yang sedang terpasang.
3. Klik **Ubah** pada baris slot yang mau diganti akunnya.
4. Pilih akun baru dari dropdown (hanya leaf account yang muncul).
5. Klik **Simpan**.

### Toko jual-beli: satu akun persediaan

Kalau toko hanya membeli lalu menjual (tidak produksi), arahkan dua slot persediaan ke akun yang sama supaya saldo persediaan tidak terpecah dan tidak ada akun yang minus.

> Untuk database yang sudah berjalan, langkah 1 sampai 3 di bawah dikerjakan otomatis oleh migration `0064_satukan_akun_persediaan.sql` (ganti nama akun 1400, pindahkan slot, dan jurnal reklasifikasi dengan nominal dihitung dari buku besar). Yang tetap manual: deploy POS versi baru lebih dulu, dan mengarsipkan akun 1420 setelah semua kasir memakai versi baru.

1. Pilih satu akun persediaan (mis. ganti nama akun Persediaan Bahan Baku menjadi **Persediaan Barang Dagang** lewat halaman Akun).
2. Di tab **Default Akun**, ubah slot **Persediaan Bahan Baku** dan slot **Persediaan Barang Jadi** supaya keduanya menunjuk akun itu.
3. Kalau sebelumnya sudah ada saldo minus di akun lama, pindahkan dengan satu jurnal reklasifikasi lewat preset jurnal (Debit akun yang minus, Kredit akun yang kelebihan, sebesar saldo minusnya).
4. Perbarui aplikasi kasir (POS) ke versi terbaru. POS versi lama masih mengkredit akun Barang Jadi dan membuat saldo minus kembali.

## Hasil Akhir

- Slot Default Akun yang sudah diisi langsung dipakai otomatis oleh field terkunci di form transaksi (mis. field "Akun Piutang Usaha" di [buat-invoice-ar.md](../accounts-receivable/buat-invoice-ar.md)) — user form transaksi tidak lagi memilih akun bebas, cukup lihat konfirmasinya.
- Perubahan di sini **tidak retroaktif** — transaksi yang sudah pernah dibuat sebelumnya tetap memakai akun yang berlaku saat itu dibuat (tersimpan di jurnalnya masing-masing), cuma transaksi baru setelah perubahan ini yang ikut akun baru.

## Kesalahan Umum

- **Login sebagai accountant lalu bingung kenapa tombol Ubah tidak muncul** — tab ini memang read-only untuk role selain admin.
- **Mengira mengubah Default Akun di sini akan mengoreksi jurnal transaksi lama** — tidak, ini cuma memengaruhi transaksi baru ke depan.
