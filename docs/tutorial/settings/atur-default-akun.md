# Atur Default Akun & Preset Aset Tetap

## Kapan Melakukan Ini

Sebelum modul transaksi (AR, AP, Inventory, Fixed Assets) bisa dipakai dengan benar — hampir semua form transaksi (AR Invoice, AP Bill, pembayaran, Goods Receipt, dst) memakai akun yang **dikunci otomatis** dari sini, bukan dropdown akun bebas. Kalau slot ini belum diisi, field akun terkait di form transaksi akan menampilkan peringatan "akun belum diset admin".

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

### Preset Akun Aset Tetap (bisa tambah preset baru)

1. Masih di halaman yang sama, klik tab **Aset Tetap**.
2. Klik **+ Tambah** untuk membuat jenis aset baru (mis. "Kendaraan Operasional", "Perlengkapan Toko") — beda dari Default Akun, di sini boleh menambah preset sebanyak jenis aset yang dibutuhkan.
3. Isi **Nama Jenis Aset**, lalu pilih ketiga akunnya sekaligus: **Akun Aset**, **Akun Akumulasi Penyusutan**, **Akun Beban Penyusutan**.
4. Klik **+ Tambah**.
5. Preset yang tidak lagi dipakai bisa dinonaktifkan lewat tombol **Nonaktifkan** di baris itu (bukan dihapus).

## Hasil Akhir

- Slot Default Akun yang sudah diisi langsung dipakai otomatis oleh field terkunci di form transaksi (mis. field "Akun Piutang Usaha" di [buat-invoice-ar.md](../accounts-receivable/buat-invoice-ar.md)) — user form transaksi tidak lagi memilih akun bebas, cukup lihat konfirmasinya.
- Preset Aset Tetap yang baru dibuat langsung muncul di dropdown **Jenis Aset** saat [tambah-aset-tetap.md](../fixed-assets/tambah-aset-tetap.md).
- Perubahan di sini **tidak retroaktif** — transaksi yang sudah pernah dibuat sebelumnya tetap memakai akun yang berlaku saat itu dibuat (tersimpan di jurnalnya masing-masing), cuma transaksi baru setelah perubahan ini yang ikut akun baru.

## Kesalahan Umum

- **Login sebagai accountant lalu bingung kenapa tombol Ubah tidak muncul** — tab ini memang read-only untuk role selain admin.
- **Mengira mengubah Default Akun di sini akan mengoreksi jurnal transaksi lama** — tidak, ini cuma memengaruhi transaksi baru ke depan.
- **Bikin 1 preset aset dipakai untuk banyak jenis aset yang berbeda karakter penyusutannya** — preset cuma menentukan 3 akun, bukan metode/tarif penyusutan (itu diisi per aset di [tambah-aset-tetap.md](../fixed-assets/tambah-aset-tetap.md)); tapi tetap disarankan 1 preset per jenis aset yang akun-akunnya memang beda, supaya laporan per jenis aset tetap terpisah rapi.
