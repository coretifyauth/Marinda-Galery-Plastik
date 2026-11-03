# Tes SQL — Koreksi Barang Masuk Lama (migration 0069)

Skrip psql biasa, dijalankan di **database lokal Docker saja** — jangan pernah diarahkan ke database live.

Dari root repo, setelah `npx supabase migration up --local`:

```
docker exec -i supabase_db_<project_id> psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 < supabase/tests/koreksi-barang-masuk-lama/test-0069.sql
```

Seluruh skrip berjalan dalam satu transaksi yang di-`rollback` di akhir, jadi data lokal tidak berubah. Berhenti dengan error kalau ada yang bocor.

Cakupan: T1 koreksi satuan tanpa penjualan (tanpa jurnal, stok & harga rata-rata benar), T2 koreksi setelah sebagian terjual (jurnal koreksi HPP), T3 pembatalan tagihan setelah koreksi (dokumen lama tidak dibalik dua kali), T4 penolakan (sudah digantikan, baris tidak lengkap, qty nol, tanpa perubahan, alasan kosong).

Prasyarat: skrip menyiapkan akun default sendiri (`bootstrap_default_accounts` + `complete_onboarding`) kalau database lokal belum ter-onboard. Fixture barang masuk lama mematikan penjaga `goods_notes_inbound_from_bill_guard_trigger` hanya di sekitar insert fixture, meniru data live yang dibuat sebelum penjaga itu ada.

**Status:** dijalankan di Supabase lokal (CLI 3.0.0, `supabase start` dengan layanan minimal) pada 2026-11-03: semua tes 0069 lulus, begitu juga tes regresi `koreksi-salah-input/test-0060.sql` dan `batalkan-retur-supplier/test-0061/0062/0065.sql` dengan 0069 terpasang. Tes 0060 dkk. butuh pengguna uji di daftar putih pendaftaran dan onboarding; test-0069 menyiapkannya sendiri (dan membatalkannya di akhir).
