# Tes SQL — Barang Masuk Belum Ditagih (migration 0056)

Skrip psql biasa (bukan pgTAP), dijalankan di **database lokal Docker saja** — jangan pernah diarahkan ke database live.

Urutan:
1. `npx supabase db reset --local` dengan migration 0001–0055 saja (pindahkan 0056 sementara).
2. `fixtures-legacy.sql` — user admin uji, COA template, supplier/item, dan 2 barang masuk + tagihan gaya lama (supaya backfill 0056 teruji pada data lama).
3. `npx supabase migration up --local` — menerapkan 0056.
4. `test-grni.sql` (T1–T9: skenario utama, kasus ekstrem, harga 0, pembatalan, retur, opname, alur lama), `test-rls.sql` (admin vs non-admin), `test-po.sql` (Purchase Order + produksi), `test-extra.sql` (T10–T12: pengembalian stok, retur customer, periode tertutup).

Jalankan tiap file lewat `docker exec -i supabase_db_<project_id> psql -U postgres -d postgres -X -q < file.sql`. Tiap tes memeriksa invarian buku besar (lihat `docs/architecture/goods-notes-schema.md`, section "Barang Masuk Belum Ditagih") dan berhenti dengan error jika ada yang bocor.
