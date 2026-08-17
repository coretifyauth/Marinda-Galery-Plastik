# Tambah Aset Tetap Baru

## Kapan Melakukan Ini

Saat mencatat aset tetap baru yang dibeli/diperoleh perusahaan (kendaraan, peralatan, perabot toko, dll) yang akan disusutkan nilainya secara berkala.

## Prasyarat

- Login dengan role **admin** atau **accountant**.
- Sudah ada minimal 1 **Preset Aset** aktif di `/settings/charges` (kombinasi Akun Aset/Akumulasi Penyusutan/Beban Penyusutan) — kalau belum ada, form akan menampilkan peringatan dan dropdown Jenis Aset kosong.
- Tahu nilai perolehan, estimasi nilai residu (sisa nilai di akhir umur manfaat), umur manfaat dalam bulan, dan metode penyusutan yang akan dipakai (Straight-Line atau Declining Balance).

## Langkah-Langkah

1. Buka menu **Fixed Assets** (`/fixed-assets`).
2. Klik tombol **+ New**. Modal **Tambah Aset Tetap** terbuka.
3. Baca catatan di atas form: **form ini cuma menyimpan master data aset, bukan mencatat jurnal akuisisinya.** Jurnal akuisisi (debit Aset Tetap, kredit Kas/Utang) dicatat terpisah lewat [buat-jurnal-manual.md](../general-ledger/buat-jurnal-manual.md).
4. Isi field:
   - **Nama Aset** — mis. "Rak Display Toko".
   - **Jenis Aset** — pilih preset yang menentukan 3 akun sekaligus (Akun Aset/Akumulasi Penyusutan/Beban Penyusutan); begitu dipilih, ketiga akun itu ditampilkan sebagai konfirmasi di bawah dropdown.
   - **Nilai Perolehan** — harga beli aset.
   - **Nilai Residu** — estimasi nilai sisa di akhir umur manfaat (default `0`).
   - **Umur Manfaat (bulan)** — total bulan sebelum aset ini habis disusutkan.
   - **Tanggal Akuisisi**.
   - **Metode Penyusutan** — pilih **Straight-Line** (nilai perolehan dibagi rata tiap periode) atau **Declining Balance** (persentase dari nilai buku berjalan).
   - **Tarif per Periode Posting** — hanya muncul kalau metode Declining Balance dipilih, isi angka 0–1 (mis. `0.40` untuk 40%).
5. Klik **Simpan Aset**.

## Hasil Akhir

- Aset baru muncul di daftar Fixed Assets, siap untuk mulai diposting penyusutannya lewat [posting-penyusutan-aset.md](posting-penyusutan-aset.md).
- **Belum ada jurnal apa pun tercatat** — nilai perolehan di sini murni data master. Kalau akuisisinya perlu tercatat di pembukuan (mis. debit Aset Tetap/kredit Kas), itu harus dicatat manual terpisah lewat Journal Entries.
- Begitu aset ini pertama kali diposting penyusutan, field Nilai Perolehan/Nilai Residu/Umur Manfaat/Metode/Akun **langsung terkunci** (published-lock) — cuma Nama dan status arsip yang masih bisa diubah setelahnya.

## Kesalahan Umum

- **Mengira menyimpan aset di sini otomatis mencatat jurnal pembelian aset** — tidak, itu langkah terpisah yang harus dilakukan manual lewat Journal Entries.
- **Salah isi Nilai Perolehan/Umur Manfaat lalu baru sadar setelah penyusutan pertama diposting** — field-field ini terkunci setelah posting pertama, jadi pastikan benar sebelum posting penyusutan pertama kali.
- **Isi Tarif untuk metode Straight-Line** — field itu cuma relevan (dan cuma muncul) untuk Declining Balance; Straight-Line dihitung otomatis dari Nilai Perolehan ÷ Umur Manfaat.
