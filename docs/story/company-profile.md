# Company Profile — CV Roti Barokah

Skenario riil yang dipakai berulang di tiap fase roadmap (`AGENT.md` > Domain Roadmap). Satu bisnis yang sama, datanya nempel terus dari COA sampai nanti Financial Reports — biar tiap modul baru punya konteks konkret, bukan angka acak.

## Profil Bisnis

**CV Roti Barokah** — usaha roti rumahan di Bandung, dirintis Bu Nur tahun 2023. Awalnya jualan online lewat WhatsApp doang, sekarang punya:

- 1 kios kecil (jualan langsung ke pelanggan, bayar cash/QRIS di tempat)
- 3 warung langganan yang ambil roti buat dijual ulang (bayar termin, gak cash — ini yang bikin butuh Piutang Usaha)
- 1 oven tambahan + 1 motor buat antar ke warung, dibeli 2025 pakai pinjaman KUR dari bank
- Bahan baku (tepung, gula, mentega, dst) dibeli dari 2 supplier langganan, sering ambil dulu bayar belakangan (Utang Usaha)

## Kenapa Butuh Sistem Ini (motivasi cerita)

Pembukuan Bu Nur masih di buku tulis + catatan HP. Sekarang mau ajukan pinjaman modal lebih besar ke bank buat sewa ruko, tapi bank minta laporan keuangan yang rapi (Neraca, Laba Rugi) — gak bisa cuma modal catatan manual. Ini alasan bisnis di balik tiap fase roadmap:

1. **COA** (fase sekarang) — benerin dulu daftar akunnya, biar semua transaksi ke depan punya "kantong" yang jelas dan konsisten.
2. **General Ledger + Journal Entries** — baru bisa mulai catat transaksi harian (jual roti, beli tepung, bayar gaji) dengan benar.
3. **AR** — nagih ke 3 warung langganan tadi.
4. **AP** — utang ke 2 supplier tepung/gula.
5. **Inventory** — hitung HPP roti (bahan baku jadi barang jadi), butuh weighted average karena harga tepung naik-turun.
6. **Fixed Assets** — oven + motor disusutkan (depresiasi), bukan langsung jadi beban semua di tahun beli.
7. **Financial Reports** — inilah tujuan akhirnya: Neraca + Laba Rugi yang bisa dibawa ke bank.

## Cara Pakai Story Ini

Tiap file lain di `docs/story/` bakal ngerujuk balik ke profil ini. Kalau ada detail baru soal bisnisnya (karyawan baru, cabang baru, dll) — update di sini, jangan duplikat di file fase lain.
