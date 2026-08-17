# Arsipkan atau Hapus Master Data (Akun, Pelanggan, Supplier, Barang)

## Kapan Melakukan Ini

Saat sebuah data master (akun COA, pelanggan, supplier, atau item barang) sudah tidak dipakai lagi dan mau dibersihkan dari daftar aktif — mis. supplier yang sudah tidak berlangganan lagi, atau item yang salah input dan belum sempat dipakai transaksi apa pun.

## Prasyarat

- Login dengan role **admin** atau **accountant** (tergantung entitasnya — semua entitas di bawah ini mengikuti aturan role yang sama seperti mengeditnya).
- Berlaku untuk 4 jenis data: **Accounts** (`/accounts/[id]`), **Customers** (`/customers/[id]`), **Suppliers** (`/suppliers/[id]`), **Items** (`/items/[id]`) — keempatnya punya tombol Hapus dengan perilaku yang sama persis.

## Langkah-Langkah

1. Buka halaman detail data yang mau dihapus.
2. Klik tombol **Hapus**.
3. Konfirmasi dialog yang muncul.
4. Sistem otomatis memutuskan salah satu dari dua hal (**smart delete**, tidak perlu kamu pilih manual):
   - Kalau data ini **belum pernah dipakai** di transaksi apa pun → **benar-benar dihapus permanen**, langsung diarahkan kembali ke halaman daftar.
   - Kalau data ini **sudah pernah dipakai** di transaksi → **tidak dihapus**, melainkan otomatis **diarsipkan** (muncul pesan pemberitahuan), supaya jejak transaksi lama tetap valid dan bisa dibaca.

## Hasil Akhir

- Data yang dihapus permanen tidak akan muncul lagi di mana pun, termasuk riwayat (karena memang belum pernah dipakai).
- Data yang diarsipkan tetap ada dan tetap muncul utuh di transaksi lama yang sudah memakainya — cuma disembunyikan dari dropdown pemilihan transaksi baru (mis. supplier yang diarsipkan tidak muncul lagi di dropdown "Buat Purchase Order").
- Data yang diarsipkan bisa **diaktifkan kembali** kapan saja — tombol yang sama berubah jadi **Aktifkan** di halaman detailnya begitu berstatus arsip.

## Kesalahan Umum

- **Khawatir data hilang kalau tombol Hapus diklik untuk data yang sudah pernah dipakai transaksi** — tidak akan hilang, sistem otomatis mengarsipkan (bukan menghapus) begitu terdeteksi ada keterkaitan transaksi; baca pesan konfirmasi yang muncul setelah klik.
- **Mencari opsi "arsipkan" terpisah dari "hapus"** — di keempat halaman ini cuma ada 1 tombol yang perilakunya otomatis menyesuaikan (smart delete), bukan 2 tombol terpisah.
- **Bingung kenapa supplier/item lama tidak muncul lagi di dropdown form transaksi baru** — cek dulu apakah statusnya sudah diarsipkan; kalau memang masih perlu dipakai, aktifkan kembali dulu dari halaman detailnya.
