# Tes SQL — Tagihan Dulu, Barang Menyusul (migration 0057 dan 0058)

Skrip psql biasa (bukan pgTAP), dijalankan di **database lokal Docker saja** — jangan pernah diarahkan ke database live.
Menggantikan tes lama `goods-received-not-invoiced/` (alur barang masuk tanpa tagihan, sudah dibuang; ada di riwayat git).

Urutan (dari root repo; `<db>` = `supabase_db_<project_id>`, `run` = `docker exec -i <db> psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1`):

1. `npx supabase db reset --local --version 0055 --no-seed --yes` — database lokal sampai 0055.
2. `run < fixtures-live-like.sql` — meniru data live: 16 barang masuk lama (alur "dibuat bareng tagihan") dan sebagian stok terjual.
3. `run -1 < supabase/migrations/0056_goods_received_not_invoiced.sql`.
4. `run < stage-0056.sql` — satu barang masuk alur `deferred` yang dibatalkan + snapshot (`snap`). Angka sesudahnya sama dengan live (17 barang masuk, 16 penghubung, 1 pembatalan, 2 jurnal di akun 2150).
5. `run -1 < supabase/migrations/0057_tagihan_dulu_barang_menyusul.sql`, lalu `run < test-0057.sql` (T0–T11: data lama utuh, alur kolam, penolakan, avg tertimbang, pembatalan, pelepasan sisa, PO, retur, invarian, RLS).
6. `run < stage-0057.sql` — snapshot sebelum 0058.
7. (Opsional) tes negatif: `( cat negative-0058-setup.sql; cat supabase/migrations/0058_*.sql ) | run` — harus **gagal** di pagar bentuk data dan tidak meninggalkan apa pun.
8. `run -1 < supabase/migrations/0058_hapus_alur_barang_masuk_tanpa_tagihan.sql`, lalu `run < test-0058.sql` (data utuh, arsip lengkap dan tertutup, objek lama hilang, alur stok, klasifikasi tanpa `inbound_flow`, invarian).

Jalur live yang sebenarnya adalah langkah 1–6 lalu 8 tanpa `test-0057.sql` di antaranya (`test-0058.sql` lulus di kedua jalur).
Tiap tes memeriksa invarian buku besar (lihat `docs/architecture/goods-notes-schema.md`) dan berhenti dengan error jika ada yang bocor.

**Penting — meniru `db push` dengan benar:** Supabase CLI menjalankan tiap statement migration TERPISAH (autocommit), bukan satu transaksi per file. Jangan menguji migration destruktif dengan `psql -1` saja (itu menyembunyikan masalah seperti `LOCK TABLE` di luar transaksi). Cara yang setia: terapkan 0056 dan 0057 lewat `psql` biasa (tanpa `-1`) lalu catat versinya di `supabase_migrations.schema_migrations`, jalankan `stage-0057.sql`, kemudian biarkan CLI menerapkan sisanya: `npx supabase migration up --local`. Migration destruktif wajib punya `begin; … commit;` eksplisit; uji kegagalan di tengah dengan menambahkan `select 1/0;` sebelum `commit;` dan pastikan tidak ada yang berubah.
