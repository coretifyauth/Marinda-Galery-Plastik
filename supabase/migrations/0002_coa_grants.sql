-- "Automatically expose new tables" dimatikan di project settings (sengaja, kontrol akses manual).
-- Akibatnya tabel baru gak dapat grant privilege ke anon/authenticated secara otomatis.
-- RLS policy tetap jadi penentu akses per baris, tapi grant di bawah wajib ada duluan
-- biar PostgREST gak nolak request sebelum sempat ngecek RLS.

grant select, insert, update on accounts to authenticated;
grant select on user_roles to authenticated;
grant select on roles to authenticated;

-- roles = lookup table (nama role & deskripsi), belum ada RLS di migration 0001 - celah,
-- karena prinsip project: tiap tabel wajib RLS sejak awal (tech-stack-decisions.md).
-- Read-only buat authenticated, gak ada policy insert/update/delete -> RLS default deny,
-- assign role baru tetap lewat migration/service role manual.
alter table roles enable row level security;

create policy roles_select on roles
  for select using (auth.role() = 'authenticated');
