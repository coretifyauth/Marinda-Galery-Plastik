# Tambah Akun Baru di Chart of Accounts

## Kapan Melakukan Ini

Setiap kali butuh akun baru yang belum ada di daftar — misal buka kategori biaya baru, bikin sub-akun kas baru per lokasi, atau menambah akun yang ternyata belum tersedia saat mengisi form transaksi lain (Journal Entry, AR Invoice, dst).

## Prasyarat

- Login dengan role **admin** atau **accountant**. Role lain (mis. `cashier`) tetap bisa buka halaman ini dan lihat daftar akun, tapi submit form akan ditolak oleh RLS — halaman menampilkan peringatan kuning kalau role kamu belum memenuhi syarat ini.
- Tahu kategori akuntansi akun yang mau dibuat (Asset/Liability/Equity/Revenue/Expense) — kalau belum yakin, baca `docs/domain/chart-of-accounts.md` dulu.
- Kalau akun ini seharusnya jadi anak dari akun header yang sudah ada (mis. sub-akun di bawah `1000 Kas`), pastikan akun induknya sudah ada duluan.

## Langkah-Langkah

1. Buka menu **Chart of Accounts** (`/accounts`).
2. Klik tombol **+ New** di pojok kanan atas tabel. Sebuah modal **Tambah Akun** akan terbuka.
3. Isi field:
   - **Kode** — kode akun, mis. `1500`. Bebas format, tapi ikuti pola penomoran yang sudah dipakai di kategori yang sama supaya urutannya rapi.
   - **Nama akun** — nama yang tampil di laporan, mis. `Kas Toko Cabang 2`.
   - **Kategori** — pilih salah satu dari dropdown: `asset`, `liability`, `equity`, `revenue`, `expense`.
   - **Akun induk** — pilih dari dropdown kalau akun ini adalah anak dari akun lain, atau biarkan **"Tanpa parent (header baru)"** kalau ini akun header baru berdiri sendiri.
4. Klik **Simpan**.

Kalau input tidak valid (kode/nama kosong), pesan error muncul di bawah form dan modal tetap terbuka — perbaiki lalu submit ulang.

## Hasil Akhir

- Akun baru langsung muncul di tabel Chart of Accounts, sesuai posisi hierarkinya (menjorok ke dalam kalau punya akun induk).
- **Normal Balance** (debit/kredit) dan status **is_contra** ditentukan otomatis oleh sistem berdasarkan kategori — tidak ada field untuk mengisinya manual, jadi tidak akan muncul langsung setelah submit; cek dengan klik baris akun itu untuk lihat detailnya.
- Akun ini langsung bisa dipakai di form transaksi lain (Journal Entry, AR Invoice, dst) **kalau statusnya leaf account** (tidak punya anak). Akun header (yang nantinya jadi induk akun lain) tidak akan muncul di dropdown pemilihan akun form transaksi.

## Kesalahan Umum

- **Bikin akun sebagai leaf padahal niatnya jadi header (induk) buat akun-akun berikutnya** — tidak masalah selama belum ada transaksi yang posting ke situ; begitu ada akun anak ditambahkan di bawahnya, akun ini otomatis berhenti muncul di dropdown posting (karena sudah bukan leaf lagi).
- **Salah pilih Kategori** — kategori menentukan Normal Balance otomatis dan tidak bisa diubah lagi setelah akun ini pernah dipakai di jurnal (published-lock). Pastikan benar sebelum submit, terutama untuk akun yang akan langsung dipakai transaksi.
- **Lupa pilih Akun Induk** saat niatnya bikin sub-akun — kalau akun induk dibiarkan kosong, akun baru jadi header berdiri sendiri, bukan anak dari akun yang dimaksud.
