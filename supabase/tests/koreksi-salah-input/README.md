# Tes SQL — Jalan Keluar Salah Input (migration 0060)

Skrip psql biasa, dijalankan di **database lokal Docker saja** — jangan pernah diarahkan ke database live.

Dari root repo, setelah `npx supabase migration up --local`:

```
docker exec -i supabase_db_<project_id> psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 < supabase/tests/koreksi-salah-input/test-0060.sql
```

Seluruh skrip berjalan dalam satu transaksi yang di-`rollback` di akhir, jadi data lokal tidak berubah. Berhenti dengan error kalau ada yang bocor.

Cakupan: T1 batal berurutan sampai semua akun kembali, T2 Batalkan Tagihan satu tombol plus uang muka, T3 cascade atomik saat stok terjual, T4 koreksi qty, T5 koreksi harga dengan HPP, T6 Koreksi Tagihan, T7 akun retur, T8 penghalang pembatalan, T9 koreksi item salah, T10 pembayaran AR dan POS, plus invarian saldo Pembelian Belum Diterima dan jurnal seimbang.
