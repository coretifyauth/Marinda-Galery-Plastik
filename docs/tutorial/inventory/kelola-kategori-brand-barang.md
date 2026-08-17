# Kelola Kategori & Brand Barang

## Kapan Melakukan Ini

Saat mengelompokkan item untuk memudahkan filter/pencarian di halaman Items — mis. bikin kategori baru, atau cek barang apa saja yang masuk 1 kategori/brand tertentu.

## Prasyarat

- Login dengan role **admin** — beda dari kebanyakan form master data lain, mengelola kategori/brand (tambah, nonaktifkan) **cuma bisa role admin**, bukan accountant.

## Langkah-Langkah

### Tambah kategori/brand baru

1. Buka menu **Items** (`/items`), klik tab **Kategori** atau **Brand**.
2. Klik **+ New**.
3. Isi **Nama Kategori**/**Nama Brand**.
4. Klik **Simpan**.

### Lihat detail & barang anggotanya

1. Di tab **Kategori**/**Brand**, klik salah satu baris untuk masuk ke halaman detailnya (`/item-categories/[id]` atau `/item-brands/[id]`).
2. Halaman detail menampilkan **Jumlah Barang** dan tabel semua item yang masuk kategori/brand ini — klik salah satu barisnya untuk langsung ke detail item itu.

### Nonaktifkan/aktifkan kategori/brand

1. Di halaman detail kategori/brand, klik tombol **Nonaktifkan** (atau **Aktifkan** kalau sedang nonaktif) di pojok kanan atas.

## Hasil Akhir

- Kategori/brand baru langsung muncul di dropdown **Kategori**/**Brand** saat [tambah-item-master.md](tambah-item-master.md) atau mengedit item.
- Kategori/brand yang dinonaktifkan tidak muncul lagi di dropdown pemilihan untuk item baru, tapi item yang sudah terlanjur memakainya **tetap menampilkan kategori/brand itu apa adanya** — tidak ikut berubah/hilang.
- Menonaktifkan kategori/brand **tidak memengaruhi item anggotanya** — item-nya tetap ada dan aktif seperti biasa, cuma kategorinya saja yang tidak bisa dipakai lagi untuk item baru.

## Kesalahan Umum

- **Login sebagai accountant lalu bingung tidak bisa tambah kategori/brand** — memang sengaja cuma admin yang boleh, beda dari kebanyakan master data lain di sistem ini yang admin+accountant sama-sama boleh.
- **Mengira menonaktifkan kategori akan menyembunyikan/menghapus barang-barangnya** — tidak, barangnya tetap aktif dan tetap tercatat masuk kategori itu; cuma kategorinya yang tidak bisa dipilih lagi untuk barang baru.
- **Mencari tombol Hapus permanen di halaman kategori/brand** — tidak ada, kategori/brand cuma bisa dinonaktifkan/diaktifkan (beda dari [arsipkan-hapus-master-data.md](../lintas-modul/arsipkan-hapus-master-data.md) yang berlaku untuk Accounts/Customers/Suppliers/Items yang punya opsi hapus permanen kalau belum pernah dipakai).
