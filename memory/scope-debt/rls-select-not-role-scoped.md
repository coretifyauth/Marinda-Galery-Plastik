# RLS SELECT Policies Gak Role-Scoped di Seluruh Schema

**Modul asal:** Auth / Cross-cutting (semua modul). **Status:** Ditunda.

## Kasus

Ditemukan (2026-09-13) saat membangun signup whitelist (`supabase/migrations/0002_coa_schema.sql`, submodule "Registrasi & Manajemen User"): ~50 RLS policy `SELECT` tersebar di hampir semua tabel (`journal_entries`, `transactions`/invoice/bill, `accounts`/COA, `counterparties`, `items`, laporan keuangan, dll) cuma cek `auth.role() = 'authenticated'` — BUKAN role spesifik user. Whitelist menutup celah "siapa boleh punya akun sama sekali", tapi TIDAK menutup celah ini: user dengan role apa pun sekalipun (bahkan `cashier` doang, yang harusnya cuma boleh checkout POS) tetap bisa baca SEMUA data finansial lewat query langsung ke tabel (`SELECT` ke `items`, `accounts`, `transactions`, dst), karena RLS `SELECT`-nya emang gak pernah cek `role_name`, cuma cek "sudah login apa belum".

## Kenapa ditunda

Perubahan ini jauh lebih besar dari whitelist itu sendiri — nyentuh ~50 policy `SELECT` di puluhan file migration berbeda, dan butuh keputusan desain dulu soal role mana yang boleh baca apa (mis. apakah `cashier` boleh baca Chart of Accounts/jurnal, atau cuma boleh baca katalog item buat checkout). User cuma minta whitelist registrasi dulu di sesi ini (2026-09-13), belum minta penyempitan read access per-role.

Risikonya saat ini tetap dibatasi (bukan hilang total): sejak whitelist ada, akun cuma bisa dibuat lewat undangan manual oleh `master`, jadi populasi user tetap terkontrol meski READ-nya longgar begitu akun jadi.

## Kapan perlu digarap

Begitu ada kebutuhan bisnis nyata buat role rendah (`cashier`, atau role viewer-only di masa depan) yang gak boleh lihat data finansial sensitif.

## Referensi

- `supabase/migrations/0002_coa_schema.sql` (komentar header submodule "Registrasi & Manajemen User").
- `docs/architecture/coa-schema.md` (submodule Registrasi & Manajemen User).
