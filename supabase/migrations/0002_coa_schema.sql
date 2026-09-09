-- Chart of Accounts. Ref: memory/architecture/data/coa-schema.md.
--
-- accounts.is_contra + rumus normal_balance final digabung LANGSUNG di sini (bukan ALTER
-- belakangan kayak riwayat aslinya migration 0014_fixed_assets_schema.sql) -- file ini
-- representasi FINAL STATE, bukan histori incremental.

create type account_category as enum ('asset','liability','equity','revenue','expense');
create type balance_side as enum ('debit','credit');

-- roles -- lookup table (bukan enum Postgres) biar nambah role baru = INSERT baris, bukan
-- migration ALTER TYPE.
create table roles (
  name text primary key,
  description text
);

insert into roles (name, description) values
  ('admin', 'Full access, kelola user & role'),
  ('accountant', 'Create/edit transaksi & COA'),
  ('viewer', 'Read-only'),
  ('cashier', 'Checkout POS doang, lewat create_pos_sale (security definer)');

alter table roles enable row level security;

create policy roles_select on roles
  for select using (auth.role() = 'authenticated');

grant select on roles to authenticated;

-- user_roles -- PK gabungan (user_id, role_name): 1 user boleh >1 role sekaligus.
create table user_roles (
  user_id uuid not null references auth.users(id) on delete cascade,
  role_name text not null references roles(name),
  primary key (user_id, role_name)
);

alter table user_roles enable row level security;

create policy user_roles_select_self on user_roles
  for select using (user_id = auth.uid());

grant select on user_roles to authenticated;

-- accounts -- tabel inti COA. normal_balance generated column, gak bisa diisi manual --
-- nutup celah "salah kategori". is_contra membalik arah normal_balance (kategori
-- asset/expense yang is_contra=true jadi normal kredit, sebaliknya kategori
-- liability/equity/revenue yang is_contra=true jadi normal debit).
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

create trigger accounts_set_updated_at
  before update on accounts
  for each row execute function set_updated_at();

-- accounts_published_lock/accounts_no_retroactive_header (butuh journal_lines, ditambah
-- di 0003_journal_entry_schema.sql begitu tabel itu ada) + Smart Delete (delete_account,
-- ditambah di file yang sama karena butuh pola foreign_key_violation generic).

-- Seed Chart of Accounts (39 akun) -- padanan 0002_seed_coa.sql historis + akun tambahan
-- yang sudah eksis di database live (1360/4400/5800/5900/6000, dulu ditambah manual/migration
-- terpisah, sekarang digabung langsung sebagai seed final). 2 pass: akun tanpa parent dulu,
-- baru akun anak (lookup parent_id via subquery by code, bukan hardcode UUID).
insert into accounts (code, name, category, is_contra) values
  ('1000', 'Kas', 'asset', false),
  ('1300', 'Piutang Usaha', 'asset', false),
  ('1350', 'Piutang Retur Supplier', 'asset', false),
  ('1360', 'Uang Muka Pembelian', 'asset', false),
  ('1400', 'Persediaan Bahan Baku', 'asset', false),
  ('1420', 'Persediaan Barang Jadi', 'asset', false),
  ('1500', 'PPN Masukan', 'asset', false),
  ('1600', 'Aset Tetap', 'asset', false),
  ('2100', 'Utang Usaha', 'liability', false),
  ('2200', 'Utang Bank', 'liability', false),
  ('2300', 'Uang Muka Penjualan', 'liability', false),
  ('2400', 'PPN Keluaran', 'liability', false),
  ('2500', 'Saldo Kredit Retur Customer', 'liability', false),
  ('3100', 'Modal Pemilik', 'equity', false),
  ('3200', 'Laba Ditahan', 'equity', false),
  ('4100', 'Pendapatan Penjualan Toko', 'revenue', false),
  ('4200', 'Pendapatan Penjualan Grosir', 'revenue', false),
  ('4300', 'Pendapatan Lain-lain', 'revenue', false),
  ('4400', 'Pendapatan Selisih Persediaan', 'revenue', false),
  ('4900', 'Retur & Potongan Penjualan', 'revenue', true),
  ('5100', 'Harga Pokok Penjualan', 'expense', false),
  ('5200', 'Beban Gaji Karyawan', 'expense', false),
  ('5300', 'Beban Sewa Toko', 'expense', false),
  ('5400', 'Beban Listrik dan Air', 'expense', false),
  ('5500', 'Beban Bunga Bank', 'expense', false),
  ('5600', 'Beban Penyusutan Rak Display Toko', 'expense', false),
  ('5610', 'Beban Penyusutan Mobil Pickup Antar Barang', 'expense', false),
  ('5700', 'Beban Piutang Tak Tertagih', 'expense', false),
  ('5800', 'Beban Kerugian Uang Muka', 'expense', false),
  ('5900', 'Beban Kerugian Barang Rusak', 'expense', false),
  ('6000', 'Beban Selisih Persediaan', 'expense', false),
  ('6100', 'Beban Biaya Pembelian', 'expense', false),
  ('6200', 'Rugi Pelepasan Aset Tetap', 'expense', false);

insert into accounts (code, name, category, is_contra, parent_id)
  select v.code, v.name, v.category, v.is_contra, p.id
  from (values
    ('1100', 'Kas Toko', 'asset'::account_category, false, '1000'),
    ('1200', 'Kas di Bank', 'asset'::account_category, false, '1000'),
    ('1610', 'Rak Display Toko', 'asset'::account_category, false, '1600'),
    ('1620', 'Mobil Pickup Antar Barang', 'asset'::account_category, false, '1600'),
    ('1630', 'Akumulasi Penyusutan Rak Display Toko', 'asset'::account_category, true, '1600'),
    ('1640', 'Akumulasi Penyusutan Mobil Pickup Antar Barang', 'asset'::account_category, true, '1600')
  ) as v(code, name, category, is_contra, parent_code)
  join accounts p on p.code = v.parent_code;

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
-- sengaja gak ada policy DELETE -> RLS default deny -> hard delete tertutup total, cuma
-- lewat RPC delete_account() (security definer, ditambah bareng accounts_published_lock
-- di 0003_journal_entry_schema.sql karena fungsinya butuh cek journal_lines).

grant select, insert, update on accounts to authenticated;
