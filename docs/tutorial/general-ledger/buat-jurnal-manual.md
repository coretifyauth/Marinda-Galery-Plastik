# Buat Jurnal Manual (Journal Entry)

## Kapan Melakukan Ini

Untuk mencatat transaksi yang tidak punya form khusus di modul lain (AR/AP/Inventory/Fixed Assets) — misal setoran modal awal, koreksi antar akun, atau transaksi non-standar lain yang perlu dicatat langsung sebagai jurnal debit/kredit.

## Prasyarat

- Login dengan role **admin** atau **accountant**.
- Akun-akun yang akan dipakai sudah ada di Chart of Accounts dan berstatus **leaf account** (tidak punya akun anak) — cuma leaf account yang muncul di dropdown pemilihan akun. Kalau akun yang dibutuhkan belum ada, buat dulu lewat [tambah-akun-baru.md](../chart-of-accounts/tambah-akun-baru.md).
- Tahu akun mana yang didebit dan akun mana yang dikredit untuk transaksi ini — kalau belum yakin, baca `docs/domain/general-ledger.md`.

## Langkah-Langkah

1. Buka menu **Journal Entries** (`/journal-entries`).
2. Klik tombol **+ New**. Modal **Tambah Journal Entry** terbuka.
3. Isi **Tanggal** dan **Deskripsi** (mis. "Setoran modal awal").
4. Isi baris jurnal (minimal 2 baris, sudah tersedia 2 baris kosong secara default):
   - Pilih **Akun** dari dropdown (hanya leaf account yang muncul).
   - Isi salah satu dari **Debit** atau **Kredit** (bukan dua-duanya) sesuai efek transaksinya ke akun itu.
   - Klik **+ Tambah baris** kalau transaksinya perlu lebih dari 2 baris (compound entry, mis. 1 debit dipecah ke beberapa akun kredit).
   - Klik ikon **✕** di ujung baris untuk menghapus baris itu (baris tidak bisa dihapus sampai tersisa kurang dari 2 baris).
5. Perhatikan indikator **Total debit / Total kredit** di bawah daftar baris — harus menunjukkan **"Balance ✓"** (hijau). Selama masih **"Belum balance"** (merah), tombol **Simpan Entry** tetap disabled.
6. Setelah balance, klik **Simpan Entry**.

## Hasil Akhir

- Entry baru muncul di tabel Journal Entries, dengan **Source Ref** yang di-generate otomatis oleh sistem (tidak perlu diisi manual).
- Saldo akun-akun yang kena baris jurnal ini langsung ter-update — cek lewat halaman **General Ledger** (`/general-ledger`) atau tab **Ledger** di halaman detail akun terkait.
- Entry yang sudah tersimpan **tidak bisa diedit atau dihapus** (immutability) — kalau ada kesalahan, buat entry pembalik (reversing entry) untuk mengoreksinya, bukan mengubah entry lama.

## Kesalahan Umum

- **Isi Debit dan Kredit sekaligus di satu baris** — satu baris jurnal hanya boleh punya salah satu (debit ATAU kredit), bukan dua-duanya.
- **Lupa cek indikator balance sebelum submit** — tombol Simpan memang otomatis disabled kalau belum balance, tapi kalau bingung kenapa tombolnya tidak bisa diklik, cek dulu angka Total debit vs Total kredit.
- **Salah pilih akun karena mengetik kategori bahasa Inggris di kepala** — dropdown akun menampilkan kode + nama akun (bukan kategori), pastikan cari berdasarkan kode/nama yang benar, bukan menebak dari urutan.
- **Salah asumsi bisa mengedit entry yang salah** — begitu tersimpan, entry tidak bisa diubah lagi. Jangan cari tombol edit; buat entry pembalik baru.
