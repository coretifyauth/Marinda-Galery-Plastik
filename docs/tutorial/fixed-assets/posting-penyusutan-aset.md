# Posting Penyusutan Aset Tetap

## Kapan Melakukan Ini

Secara berkala (sesuai cadence yang dipakai bisnis — bulanan atau tahunan), untuk mencatat beban penyusutan periode berjalan atas aset tetap yang sudah ada.

## Prasyarat

- Login dengan role **admin** atau **accountant**.
- Asetnya sudah ada di master data — kalau belum, buat dulu lewat [tambah-aset-tetap.md](tambah-aset-tetap.md).

## Langkah-Langkah

1. Buka menu **Fixed Assets** (`/fixed-assets`), klik baris aset yang mau diposting penyusutannya untuk masuk ke halaman detail.
2. Klik tombol **Posting Penyusutan**.
3. Baca catatan di modal: jumlah penyusutan **dihitung otomatis** sesuai metode aset ini (Straight-Line: nilai perolehan ÷ umur manfaat; Declining Balance: nilai buku dikali tarif) — biasanya tidak perlu isi apa pun selain periode.
4. Isi **Periode** — tanggal posting penyusutan ini.
5. **Biarkan kosong** field **Jumlah Manual** — ini cuma diisi manual untuk kasus khusus (periode terakhir aset Declining Balance, supaya nilai buku pas berhenti tepat di nilai residu, bukan sisa desimal kecil). Untuk posting rutin biasa, selalu kosongkan.
6. Klik **Post**.

## Hasil Akhir

- Jurnal penyusutan otomatis terbentuk: debit Akun Beban Penyusutan, kredit Akun Akumulasi Penyusutan (bukan mengurangi Akun Aset langsung — nilai buku dihitung dari Nilai Perolehan dikurangi Akumulasi).
- Nilai **Akumulasi Penyusutan** dan **Nilai Buku** aset ini di halaman detail langsung ter-update.
- Setelah posting pertama, field master data aset ini terkunci (published-lock) — lihat [tambah-aset-tetap.md](tambah-aset-tetap.md).

## Kesalahan Umum

- **Isi Jumlah Manual padahal ini posting rutin biasa** — field ini cuma untuk kasus khusus periode terakhir aset Declining Balance; mengisinya di posting biasa akan menggantikan perhitungan otomatis dengan angka yang mungkin salah.
- **Posting penyusutan lebih dari sekali untuk periode yang sama** — sistem tidak otomatis mendeteksi duplikasi periode; pastikan cek riwayat penyusutan aset ini dulu sebelum posting ulang, supaya tidak dobel catat beban.
- **Lupa aset dengan nilai buku sudah mendekati nilai residu** — untuk aset Declining Balance yang mendekati akhir umur manfaat, cek dulu apakah posting rutin berikutnya perlu jumlah manual supaya tidak menyusut sampai di bawah nilai residu.
