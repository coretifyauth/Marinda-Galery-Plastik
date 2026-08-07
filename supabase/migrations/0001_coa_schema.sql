-- Chart of Accounts schema.
-- Konsolidasi dari migration historis 0001-0002 + kolom is_contra/normal_balance dari 0014 (fixed assets) --
-- lihat git log untuk riwayat evolusi asli.
-- Ref: docs/architecture/coa-schema.md

create type account_category as enum ('asset','liability','equity','revenue','expense');
create type balance_side as enum ('debit','credit');

create table roles (
  name text primary key,
  description text
);

insert into roles (name, description) values
  ('admin', 'Full access, kelola user & role'),
  ('accountant', 'Create/edit transaksi & COA'),
  ('viewer', 'Read-only');

create table user_roles (
  user_id uuid not null references auth.users(id) on delete cascade,
  role_name text not null references roles(name),
  primary key (user_id, role_name)
);

create table accounts (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  category account_category not null,
  is_contra boolean not null default false,
  normal_balance balance_side generated always as (
    case
      when category in ('asset','expense') then
        case when is_contra then 'credit'::balance_side else 'debit'::balance_side end
      else
        case when is_contra then 'debit'::balance_side else 'credit'::balance_side end
    end
  ) stored,
  parent_id uuid references accounts(id),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index accounts_parent_id_idx on accounts(parent_id);

create function set_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

create trigger accounts_set_updated_at
  before update on accounts
  for each row execute function set_updated_at();

-- RLS

alter table accounts enable row level security;

create policy accounts_select on accounts
  for select using (auth.role() = 'authenticated');

create policy accounts_insert on accounts
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

create policy accounts_update on accounts
  for update using (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );
-- sengaja gak ada policy DELETE -> RLS default deny -> hard delete tertutup total

alter table user_roles enable row level security;

create policy user_roles_select_self on user_roles
  for select using (user_id = auth.uid());

-- roles = lookup table (nama role & deskripsi). Read-only buat authenticated,
-- gak ada policy insert/update/delete -> RLS default deny, assign role baru
-- tetap lewat migration/service role manual.
alter table roles enable row level security;

create policy roles_select on roles
  for select using (auth.role() = 'authenticated');

-- Grant: "Automatically expose new tables" dimatikan di project settings (sengaja,
-- kontrol akses manual). Tabel baru gak dapat grant privilege ke anon/authenticated
-- secara otomatis. RLS policy tetap jadi penentu akses per baris, tapi grant di bawah
-- wajib ada duluan biar PostgREST gak nolak request sebelum sempat ngecek RLS.

grant select, insert, update on accounts to authenticated;
grant select on user_roles to authenticated;
grant select on roles to authenticated;
