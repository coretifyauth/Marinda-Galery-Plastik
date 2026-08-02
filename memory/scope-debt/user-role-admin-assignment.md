# Auth — Policy Admin buat Assign Role User Lain

**Modul asal:** Chart of Accounts / Auth (Fase 1). **Status:** Ditunda.

## Kasus

Sekarang assign role ke user (`user_roles`) cuma bisa manual/lewat migration langsung ke database — belum ada policy RLS yang ngizinin admin nge-assign role ke user lain lewat aplikasi (misal screen "User Management").

## Kenapa ditunda

`user_roles_select_self` (`memory/architecture/data/coa-schema.md`) cuma ngizinin user liat role dirinya sendiri. Bikin policy INSERT/UPDATE buat admin assign role user lain butuh `security definer` function — kalau langsung pakai RLS policy biasa yang subquery ke `user_roles` buat cek "apakah pemanggil admin", itu circular-check (nge-cek tabel yang lagi mau di-insert/update pakai tabel yang sama).

## Kapan perlu digarap

Begitu ada kebutuhan screen "User Management" di UI — sampai sekarang role masih diassign manual lewat Supabase Studio/migration.

## Referensi

- `memory/architecture/data/coa-schema.md` (bagian "Belum termasuk")
