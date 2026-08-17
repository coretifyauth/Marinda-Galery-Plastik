# Atur Kop Surat & Penandatangan Cetakan

## Kapan Melakukan Ini

Sebelum mencetak dokumen (AR Invoice, Purchase Order, dll) untuk pertama kali — supaya identitas perusahaan dan blok tanda tangan tampil benar di hasil cetakan.

## Prasyarat

- Login dengan role **admin**.
- Kalau mau pakai logo, logo-nya sudah di-upload ke tempat lain (Google Drive publik, image hosting, dst) dan sudah punya URL langsung ke gambarnya — fase ini belum ada fitur upload file langsung ke sistem.

## Langkah-Langkah

### Identitas Perusahaan (Kop Surat)

1. Buka menu **Settings** (`/settings/charges`), tab **Dokumen Cetak**.
2. Di kartu **Identitas Perusahaan (Kop Surat)**, isi **Nama Perusahaan**, **NPWP**, **Alamat**.
3. (Opsional) Isi **URL Logo** — preview logo langsung muncul di bawah field kalau URL valid.
4. Klik **Simpan Identitas Perusahaan**.

### Penandatangan Cetakan

1. Di kartu **Penandatangan Cetakan** (halaman yang sama), klik **+ Tambah**.
2. Isi **Jabatan** (mis. "Kepala Toko", "Bagian Gudang") — ini cuma label jabatan + garis kosong untuk tanda tangan manual, bukan nama pegawai tertentu.
3. Isi **Urutan** — menentukan posisi kolom tanda tangan dari kiri ke kanan di cetakan.
4. Klik **+ Tambah**.
5. Jabatan yang tidak lagi dipakai bisa **Nonaktifkan**, atau **Hapus** permanen kalau memang salah input (beda dari kebanyakan katalog lain di sistem ini yang cuma bisa dinonaktifkan, jabatan penandatangan boleh dihapus total karena tidak ada data lain yang terikat ke situ).

## Hasil Akhir

- Kop surat (nama, alamat, NPWP, logo) langsung tampil di cetakan AR Invoice dan Purchase Order — data ini dibaca live tiap kali dokumen dicetak, bukan snapshot beku, jadi perubahan di sini langsung berlaku ke semua cetakan berikutnya (termasuk dokumen lama yang dicetak ulang).
- Blok tanda tangan di cetakan menampilkan kolom sesuai jabatan aktif, terurut sesuai **Urutan** yang diisi.

## Kesalahan Umum

- **Isi nama pegawai spesifik di field Jabatan** — field ini memang cuma label jabatan (garis kosong untuk ditandatangani manual), bukan field nama orang.
- **Mengira perubahan kop surat cuma berlaku ke dokumen baru** — karena datanya dibaca live saat cetak (bukan snapshot), dokumen lama yang dicetak ulang setelah perubahan ini juga akan menampilkan kop surat yang baru, bukan yang berlaku saat dokumen itu pertama dibuat.
- **Menghapus jabatan penandatangan yang salah, padahal maksudnya cuma reorder** — kalau cuma mau ubah urutan kolom, edit angka **Urutan**-nya saja, tidak perlu hapus lalu buat ulang.
