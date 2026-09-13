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
  ('master', 'Superuser -- semua akses ERP+POS+kelola user/role. Cuma disetup manual lewat database, gak pernah lewat whitelist/signup.'),
  ('admin', 'Full access ERP (transaksi + konfigurasi)'),
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
  updated_at timestamptz not null default now(),
  created_by text default (auth.jwt() ->> 'email')
);

comment on column accounts.created_by is 'Email snapshot saat insert (bukan FK) -- konvensi master data (items/counterparties/accounts/bom), beda dari created_by uuid FK di tabel transaksional sejak 0011+. NULL = data lama / insert di luar jalur aplikasi.';

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
            where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );

create policy accounts_update on accounts
  for update using (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );
-- sengaja gak ada policy DELETE -> RLS default deny -> hard delete tertutup total, cuma
-- lewat RPC delete_account() (security definer, ditambah bareng accounts_published_lock
-- di 0003_journal_entry_schema.sql karena fungsinya butuh cek journal_lines).

grant select, insert, update on accounts to authenticated;

-- Registrasi & Manajemen User. Ref: docs/architecture/coa-schema.md (submodule
-- "Registrasi & Manajemen User").
--
-- Kronologi (2026-09-13, sudah dipadatkan jadi final state -- bukan histori
-- incremental): self-service /signup awalnya kebuka tanpa validasi sama sekali. Sempat
-- dicoba admin-invite lewat email (Supabase Admin API + service role key), tapi
-- dibalikin ke self-service + whitelist karena gantung ke SMTP yang belum tentu
-- dikonfigurasi. Role 'accountant'/'viewer' dipensiunkan (permission-nya udah selalu
-- gabung sama 'admin' di hampir semua guard, 'viewer' malah gak pernah dicek di mana
-- pun) -- 'master' (superuser) ditambah gantiin posisi admin lama.
--
-- Kenapa 2 mekanisme (Auth Hook + trigger), bukan 1: hook "before-user-created" jalan
-- SEBELUM baris auth.users ada -- gak bisa insert ke user_roles di titik itu (FK bakal
-- gagal, baris user_id-nya belum ada). Insert ke auth.users sendiri gak bisa "dibatalkan
-- separuh jalan" dari sisi kita, jadi assignment role + tandain whitelist "consumed"
-- harus nunggu baris auth.users beneran ada -- trigger AFTER INSERT ON auth.users itu
-- pola resmi yang sama dipakai contoh Supabase sendiri buat sinkron ke tabel app.
--
-- Role "master": TIDAK dicek di satu pun policy/RPC modul lain di seluruh schema (semua
-- checknya berbentuk "role user termasuk salah satu dari [...]", row-existence, bukan
-- exact-match). Akun master cukup dikasih role 'admin' + 'cashier' sekaligus (manual
-- lewat SQL, gak pernah lewat whitelist/UI) -- otomatis lolos semua guard existing tanpa
-- nyentuh satu pun file lain. Trigger di bagian bawah (ensure_master_has_all_roles)
-- nutup risiko operator lupa pasangkan ini manual.
--
-- CATATAN: submodule ini menutup celah "siapa boleh punya akun sama sekali" DAN
-- "aplikasi mana yang boleh dia akses" (role juga jadi gate akses APLIKASI, lihat
-- apps/erp/src/lib/app-access.ts / apps/pos/src/lib/app-access.ts). Celah TERPISAH yang
-- masih terbuka: ~50 RLS policy SELECT di seluruh schema cuma cek
-- auth.role()='authenticated' (bukan role spesifik) -- lihat
-- memory/scope-debt/rls-select-not-role-scoped.md.

create table signup_whitelist (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  created_by text not null default (auth.jwt() ->> 'email'),
  created_at timestamptz not null default now(),
  consumed_at timestamptz,
  check (email = lower(email))
);

-- "Minimal 1 role per whitelist entry" cuma ditegakkan di add_whitelist_entry (RPC),
-- bukan constraint DB -- insert manual langsung ke signup_whitelist tanpa baris di sini
-- bakal bikin email itu lolos signup dengan 0 role (silent, gak error). Provisioning
-- manual lewat SQL harus sadar ini, sama kayak pairing admin+cashier buat akun master.
create table signup_whitelist_roles (
  whitelist_id uuid not null references signup_whitelist(id) on delete cascade,
  role_name text not null references roles(name),
  primary key (whitelist_id, role_name),
  check (role_name <> 'master')
);

alter table signup_whitelist enable row level security;
alter table signup_whitelist_roles enable row level security;

create policy signup_whitelist_select on signup_whitelist for select using (
  exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'master')
);
create policy signup_whitelist_roles_select on signup_whitelist_roles for select using (
  exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'master')
);

grant select on signup_whitelist, signup_whitelist_roles to authenticated;
-- Insert/update/delete SENGAJA gak ada policy (default-deny) -- satu-satunya jalur nulis
-- adalah RPC security definer di bawah, pola sama document_number_counters (0007).

-- before_user_created_hook -- Auth Hook resmi Supabase, nolak signup kalau email belum
-- ada di signup_whitelist. Owned by postgres (bukan supabase_auth_admin) supaya bisa
-- baca signup_whitelist lewat security definer -- supabase_auth_admin sendiri cuma
-- dikasih EXECUTE, gak perlu akses tabel langsung.
create function before_user_created_hook(event jsonb) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text;
begin
  v_email := lower(event -> 'user' ->> 'email');

  if v_email is null or not exists (
    select 1 from signup_whitelist sw where sw.email = v_email and sw.consumed_at is null
  ) then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', 'Email ini belum diizinkan buat daftar -- hubungi admin buat ditambahkan ke whitelist.'
      )
    );
  end if;

  return jsonb_build_object();
end;
$$;

grant usage on schema public to supabase_auth_admin;
grant execute on function before_user_created_hook(jsonb) to supabase_auth_admin;

-- handle_new_user_role_assignment -- jalan SETELAH auth.users beneran keluar baris baru
-- (lolos hook di atas berarti sudah pasti ada baris whitelist yang match). Assign role
-- yang dijanjikan whitelist + tandai entry itu consumed, dalam 1 transaksi yang sama
-- dengan proses signup (kalau ini gagal, seluruh signup ikut rollback -- gak ada akun
-- "nyangkut" tanpa role).
create function handle_new_user_role_assignment() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_whitelist_id uuid;
begin
  select id into v_whitelist_id
    from signup_whitelist
    where email = lower(new.email) and consumed_at is null
    for update;

  if v_whitelist_id is null then
    raise exception 'Email % gak ada di whitelist yang masih aktif -- signup seharusnya sudah ditolak hook', new.email;
  end if;

  insert into user_roles (user_id, role_name)
    select new.id, swr.role_name from signup_whitelist_roles swr where swr.whitelist_id = v_whitelist_id;

  update signup_whitelist set consumed_at = now() where id = v_whitelist_id;

  return new;
end;
$$;

create trigger on_auth_user_created_assign_role
  after insert on auth.users
  for each row execute function handle_new_user_role_assignment();

-- RPC User Management -- eksklusif master. list_app_users() gabungin auth.users+
-- user_roles (auth.users gak bisa di-query langsung dari client lewat PostgREST).
create function list_app_users() returns table (
  user_id uuid, email text, roles text[], user_created_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'master') then
    raise exception 'Cuma master yang boleh lihat daftar user';
  end if;

  return query
    select u.id, u.email::text, coalesce(array_agg(ur.role_name order by ur.role_name) filter (where ur.role_name is not null), '{}'),
           u.created_at
    from auth.users u
    left join user_roles ur on ur.user_id = u.id
    group by u.id, u.email, u.created_at
    order by u.created_at desc;
end;
$$;

-- set_user_roles -- ganti total set role (admin/cashier doang) milik 1 user. Gak pernah
-- nyentuh baris role 'master' siapa pun -- baik nambah maupun nyabut master WAJIB manual
-- lewat database. Enforce "1 akun 1 role": nolak array kosong ATAU >1 elemen (>1 = HARUS
-- lewat database manual, sama syarat kayak master) -- role juga jadi gate akses APLIKASI
-- (ERP vs POS), jadi 1 akun 1 role bikin "akun ini punya akses ke aplikasi mana" gak
-- ambigu.
create function set_user_roles(p_user_id uuid, p_roles text[]) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'master') then
    raise exception 'Cuma master yang boleh ubah role user';
  end if;

  if 'master' = any(p_roles) then
    raise exception 'Role master gak bisa di-assign lewat sini -- harus manual lewat database';
  end if;

  if p_roles is null or array_length(p_roles, 1) is null then
    raise exception 'User harus punya minimal 1 role -- gak bisa dikosongkan lewat sini';
  end if;

  if array_length(p_roles, 1) > 1 then
    raise exception '1 akun cuma boleh punya 1 role (admin ATAU cashier) -- multi-role cuma buat master, harus manual lewat database';
  end if;

  delete from user_roles where user_id = p_user_id and role_name <> 'master';
  insert into user_roles (user_id, role_name)
    select p_user_id, r from unnest(p_roles) r;
end;
$$;

-- add_whitelist_entry/remove_whitelist_entry -- master-only. add_whitelist_entry enforce
-- tepat 1 role juga (mirror set_user_roles).
create function add_whitelist_entry(p_email text, p_roles text[]) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if not exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'master') then
    raise exception 'Cuma master yang boleh kelola whitelist';
  end if;

  if 'master' = any(p_roles) then
    raise exception 'Role master gak bisa diberikan lewat whitelist -- harus manual lewat database';
  end if;

  if p_roles is null or array_length(p_roles, 1) is null then
    raise exception 'Pilih 1 role buat email ini';
  end if;

  if array_length(p_roles, 1) > 1 then
    raise exception '1 akun cuma boleh punya 1 role (admin ATAU cashier) -- multi-role cuma buat master, harus manual lewat database';
  end if;

  insert into signup_whitelist (email) values (lower(p_email)) returning id into v_id;
  insert into signup_whitelist_roles (whitelist_id, role_name)
    select v_id, r from unnest(p_roles) r;

  return v_id;
end;
$$;

create function remove_whitelist_entry(p_whitelist_id uuid) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'master') then
    raise exception 'Cuma master yang boleh kelola whitelist';
  end if;

  delete from signup_whitelist where id = p_whitelist_id and consumed_at is null;
  if not found then
    raise exception 'Undangan gak ditemukan atau sudah dipakai buat signup -- gak bisa dihapus';
  end if;
end;
$$;

grant execute on function list_app_users() to authenticated;
grant execute on function set_user_roles(uuid, text[]) to authenticated;
grant execute on function add_whitelist_entry(text, text[]) to authenticated;
grant execute on function remove_whitelist_entry(uuid) to authenticated;

-- ensure_master_has_all_roles -- begitu baris 'master' di-insert ke user_roles (jalur
-- satu-satunya: manual lewat database), 'admin' dan 'cashier' otomatis nyusul buat
-- user_id yang sama. Nutup risiko operator lupa pasangkan manual -- akibatnya kalau
-- kelupaan: akun BISA login (hasErpAccess/hasPosAccess eksplisit ngizinin 'master'),
-- tapi locked out dari hampir semua actual write action, karena guard lain di seluruh
-- schema gak pernah tau soal 'master' (lihat catatan di atas). Cuma nutup jalur INSERT
-- -- gak ada RPC/kode manapun yang pernah UPDATE role_name di user_roles langsung
-- (selalu delete+insert, lihat set_user_roles).
create function ensure_master_has_all_roles() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into user_roles (user_id, role_name)
  values (new.user_id, 'admin'), (new.user_id, 'cashier')
  on conflict do nothing;
  return new;
end;
$$;

create trigger user_roles_master_implies_all
  after insert on user_roles
  for each row
  when (new.role_name = 'master')
  execute function ensure_master_has_all_roles();

-- CATATAN OPERASIONAL: kalau nanti mau CABUT status master dari 1 akun, jangan cuma
-- delete baris 'master'-nya -- baris 'admin'+'cashier' yang otomatis nempel dari trigger
-- ini bakal TETAP nyangkut, bikin akun non-master itu balik melanggar kebijakan "1 akun
-- 1 role". Hapus ketiga baris role-nya sekaligus, baru assign 1 role baru yang sesuai
-- lewat set_user_roles kalau perlu.
