# Cetak Dokumen (AR Invoice & Purchase Order)

## Kapan Melakukan Ini

Saat butuh salinan cetak/PDF dari invoice pelanggan atau purchase order ke supplier — mis. untuk dikirim fisik atau dilampirkan email.

## Prasyarat

- Login (semua role bisa mencetak, tidak perlu admin/accountant khusus).
- Popup browser tidak diblokir untuk halaman ini — cetakan dibuka lewat window/tab baru.
- Untuk hasil terbaik, isi dulu identitas perusahaan & penandatangan lewat [atur-kop-surat-cetakan.md](../settings/atur-kop-surat-cetakan.md) — kalau belum diisi, kop surat akan tampil kosong.

## Langkah-Langkah

1. Buka detail dokumen yang mau dicetak — `/ar-invoices/[id]` atau `/purchase-orders/[id]`.
2. Klik tombol **Cetak** di pojok kanan atas.
3. Kalau muncul pesan **"Popup diblokir browser"**, izinkan popup untuk halaman ini di pengaturan browser, lalu klik **Cetak** lagi.
4. Tab/window baru terbuka menampilkan dokumen siap cetak — pakai fungsi print browser (`Ctrl+P` atau menu print) untuk mencetak fisik atau simpan sebagai PDF.

## Hasil Akhir

- Dokumen menampilkan kop surat (nama/alamat/NPWP/logo perusahaan) dan blok tanda tangan sesuai yang diatur di [atur-kop-surat-cetakan.md](../settings/atur-kop-surat-cetakan.md).
- **Isi dokumen selalu dibaca live saat itu dicetak** — bukan snapshot beku dari saat dokumen pertama dibuat. Kalau invoice ini sudah pernah diretur/di-write-off/dibatalkan setelah pertama kali dicetak, cetakan berikutnya otomatis menunjukkan kondisi terkini itu, bukan angka waktu pertama dicetak.
- Untuk AR Invoice yang berasal dari Goods Issue dengan Sales Order (punya harga per item tercatat), tabel item di cetakan menampilkan kolom harga; untuk invoice financial-only atau tanpa harga per item, tabel cukup menampilkan qty tanpa kolom harga kosong.

## Kesalahan Umum

- **Bingung kenapa tidak ada apa-apa yang terjadi saat klik Cetak** — cek pesan error di halaman, kemungkinan besar popup diblokir browser; izinkan dulu popup untuk situs ini.
- **Mencetak ulang invoice lama dan bingung angkanya beda dari cetakan pertama** — itu bukan bug, cetakan memang selalu menampilkan kondisi terkini (termasuk efek retur/pembatalan yang terjadi belakangan), bukan snapshot waktu pertama cetak.
- **Kop surat tampil kosong** — isi dulu Identitas Perusahaan di [atur-kop-surat-cetakan.md](../settings/atur-kop-surat-cetakan.md); field yang belum diisi memang tampil kosong di cetakan, bukan error.
