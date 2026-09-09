-- Fixed Assets. Ref: memory/architecture/data/fixed-assets-schema.md.
--
-- accounts.is_contra + accounts_published_lock versi final (is_contra ikut dikunci) SUDAH
-- ADA sejak 0002_coa_schema.sql / 0003_journal_entry_schema.sql (file-file itu representasi
-- final state) -- gak perlu ALTER/CREATE OR REPLACE ulang di sini.
--
-- disposed_at digabung LANGSUNG ke CREATE TABLE fixed_assets utama di sini (riwayat asli
-- nambah belakangan lewat ALTER migration 0054 buat fitur Disposal) -- file ini
-- representasi final state, bukan histori incremental.

create type depreciation_method as enum ('straight_line', 'declining_balance');

create table fixed_assets (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  asset_account_id uuid not null references accounts(id),
  accumulated_depreciation_account_id uuid not null references accounts(id),
  depreciation_expense_account_id uuid not null references accounts(id),
  acquisition_cost numeric(14,2) not null check (acquisition_cost > 0),
  salvage_value numeric(14,2) not null default 0 check (salvage_value >= 0),
  useful_life_months int not null check (useful_life_months > 0),
  acquisition_date date not null,
  depreciation_method depreciation_method not null default 'straight_line',
  depreciation_rate numeric(5,4) check (depreciation_rate > 0 and depreciation_rate <= 1),
  disposed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (depreciation_method = 'straight_line' and depreciation_rate is null)
    or
    (depreciation_method = 'declining_balance' and depreciation_rate is not null)
  ),
  check (salvage_value < acquisition_cost)
);

create index fixed_assets_asset_account_id_idx on fixed_assets(asset_account_id);

create trigger fixed_assets_set_updated_at
  before update on fixed_assets
  for each row execute function set_updated_at();

-- depreciation_entries -- histori posting penyusutan per periode. amount disimpan eksplisit
-- (bukan re-derive dari formula) -- declining_balance (nilainya beda tiap periode) gak butuh
-- kolom tambahan apapun dibanding straight_line.

create table depreciation_entries (
  id uuid primary key default gen_random_uuid(),
  fixed_asset_id uuid not null references fixed_assets(id),
  period date not null,
  amount numeric(14,2) not null check (amount > 0),
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (fixed_asset_id, period)
);

create index depreciation_entries_fixed_asset_id_idx on depreciation_entries(fixed_asset_id);

-- fixed_assets_validate_accounts -- pastikan 3 akun yang dipetakan sesuai peran masing-masing
-- (cek query tabel lain, gak bisa pakai CHECK constraint biasa).

create function fixed_assets_validate_accounts() returns trigger as $$
declare
  v_asset_category account_category;
  v_asset_is_contra boolean;
  v_accum_category account_category;
  v_accum_is_contra boolean;
  v_expense_category account_category;
begin
  select category, is_contra into v_asset_category, v_asset_is_contra
    from accounts where id = new.asset_account_id;
  if v_asset_category <> 'asset' or v_asset_is_contra then
    raise exception 'asset_account_id harus akun kategori asset, non-kontra';
  end if;

  select category, is_contra into v_accum_category, v_accum_is_contra
    from accounts where id = new.accumulated_depreciation_account_id;
  if v_accum_category <> 'asset' or not v_accum_is_contra then
    raise exception 'accumulated_depreciation_account_id harus akun kategori asset DAN is_contra=true';
  end if;

  select category into v_expense_category
    from accounts where id = new.depreciation_expense_account_id;
  if v_expense_category <> 'expense' then
    raise exception 'depreciation_expense_account_id harus akun kategori expense';
  end if;

  return new;
end;
$$ language plpgsql;

create trigger fixed_assets_validate_accounts_trigger
  before insert or update on fixed_assets
  for each row execute function fixed_assets_validate_accounts();

-- depreciation_entries_cap_check -- versi final pasca migration 0054 (Disposal): akumulasi
-- gak boleh melebihi acquisition_cost - salvage_value, DAN aset yang sudah disposed_at gak
-- boleh diposting penyusutan lagi. Ditegakkan di level trigger DB, bukan cuma dipercaya dari
-- perhitungan RPC.

create function depreciation_entries_cap_check() returns trigger as $$
declare
  v_cost numeric;
  v_salvage numeric;
  v_disposed_at timestamptz;
  v_accumulated numeric;
begin
  select acquisition_cost, salvage_value, disposed_at into v_cost, v_salvage, v_disposed_at
    from fixed_assets where id = new.fixed_asset_id;

  if v_disposed_at is not null then
    raise exception 'Aset % sudah di-disposal, gak bisa diposting penyusutan lagi', new.fixed_asset_id;
  end if;

  select coalesce(sum(amount), 0) into v_accumulated
    from depreciation_entries where fixed_asset_id = new.fixed_asset_id;

  if v_accumulated + new.amount > v_cost - v_salvage then
    raise exception 'Penyusutan aset % melebihi batas (sisa %, coba %)',
      new.fixed_asset_id, (v_cost - v_salvage) - v_accumulated, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger depreciation_entries_cap_check_trigger
  before insert on depreciation_entries
  for each row execute function depreciation_entries_cap_check();

-- Immutability -- reuse block_edit_delete().

create trigger depreciation_entries_block_edit_delete
  before update or delete on depreciation_entries
  for each row execute function block_edit_delete();

-- fixed_assets_published_lock -- begitu punya minimal 1 depreciation_entries, field penentu
-- nilai (3 kolom akun, acquisition_cost, salvage_value, useful_life_months, acquisition_date,
-- depreciation_method, depreciation_rate) terkunci. name/archived_at tetap bebas.

create function fixed_assets_published_lock() returns trigger as $$
begin
  if (old.asset_account_id, old.accumulated_depreciation_account_id, old.depreciation_expense_account_id,
      old.acquisition_cost, old.salvage_value, old.useful_life_months, old.acquisition_date,
      old.depreciation_method, old.depreciation_rate)
     is distinct from
     (new.asset_account_id, new.accumulated_depreciation_account_id, new.depreciation_expense_account_id,
      new.acquisition_cost, new.salvage_value, new.useful_life_months, new.acquisition_date,
      new.depreciation_method, new.depreciation_rate) then
    if exists (select 1 from depreciation_entries where fixed_asset_id = old.id) then
      raise exception 'Aset % sudah punya penyusutan — field nilai/akun/metode terkunci', old.id;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger fixed_assets_published_lock_trigger
  before update on fixed_assets
  for each row execute function fixed_assets_published_lock();

-- create_fixed_asset -- insert master data doang, gak ada jurnal. Akuisisi (Debit Aset Tetap,
-- Kredit Kas/Utang) dicatat manual lewat create_journal_entry biasa -- itu transaksi generik,
-- gak butuh RPC khusus.

create function create_fixed_asset(
  p_name text,
  p_asset_account_id uuid,
  p_accumulated_depreciation_account_id uuid,
  p_depreciation_expense_account_id uuid,
  p_acquisition_cost numeric,
  p_salvage_value numeric,
  p_useful_life_months int,
  p_acquisition_date date,
  p_depreciation_method depreciation_method default 'straight_line',
  p_depreciation_rate numeric default null
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_asset_id uuid;
begin
  insert into fixed_assets (
    name, asset_account_id, accumulated_depreciation_account_id, depreciation_expense_account_id,
    acquisition_cost, salvage_value, useful_life_months, acquisition_date,
    depreciation_method, depreciation_rate
  )
  values (
    p_name, p_asset_account_id, p_accumulated_depreciation_account_id, p_depreciation_expense_account_id,
    p_acquisition_cost, p_salvage_value, p_useful_life_months, p_acquisition_date,
    p_depreciation_method, p_depreciation_rate
  )
  returning id into v_asset_id;

  return v_asset_id;
end;
$$;

-- post_depreciation -- hitung (atau terima override) + bikin jurnal + insert entry, atomik.
-- Formula otomatis per depreciation_method; p_amount_override dipakai buat penyesuaian
-- manual periode terakhir (declining balance, potongan biar pas residu) -- kalau null,
-- dihitung otomatis.

create function post_depreciation(
  p_fixed_asset_id uuid,
  p_period date,
  p_source_ref text,
  p_amount_override numeric default null
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_asset fixed_assets%rowtype;
  v_accumulated numeric;
  v_book_value numeric;
  v_amount numeric;
  v_cap numeric;
  v_entry_id uuid;
  v_de_id uuid;
begin
  select * into v_asset from fixed_assets where id = p_fixed_asset_id;

  select coalesce(sum(amount), 0) into v_accumulated
    from depreciation_entries where fixed_asset_id = p_fixed_asset_id;

  v_cap := v_asset.acquisition_cost - v_asset.salvage_value;
  v_book_value := v_asset.acquisition_cost - v_accumulated;

  if p_amount_override is not null then
    v_amount := p_amount_override;
  elsif v_asset.depreciation_method = 'straight_line' then
    v_amount := v_cap / v_asset.useful_life_months;
  else -- declining_balance
    v_amount := v_book_value * v_asset.depreciation_rate;
  end if;

  -- potong otomatis kalau lewat cap
  if v_accumulated + v_amount > v_cap then
    v_amount := v_cap - v_accumulated;
  end if;

  v_entry_id := create_journal_entry(
    p_period, 'Penyusutan ' || v_asset.name, p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', v_asset.depreciation_expense_account_id, 'debit', v_amount, 'credit', 0),
      jsonb_build_object('account_id', v_asset.accumulated_depreciation_account_id, 'debit', 0, 'credit', v_amount)
    )
  );

  insert into depreciation_entries (fixed_asset_id, period, amount, journal_entry_id, created_by)
  values (p_fixed_asset_id, p_period, v_amount, v_entry_id, auth.uid())
  returning id into v_de_id;

  return v_de_id;
end;
$$;

-- Disposal Aset Tetap (Penjualan/Pembuangan/Kehilangan) -- fixed_asset_disposals bukan status
-- column di fixed_assets: butuh nyimpen data sendiri (nilai buku snapshot, laba/rugi, akun
-- yang dipetakan, jurnal). fixed_assets.disposed_at (kolom di atas) cuma penanda denormalisasi
-- (null=aktif), ditulis RPC yang sama.

create type fixed_asset_disposal_type as enum ('sold', 'scrapped', 'lost');

create table fixed_asset_disposals (
  id uuid primary key default gen_random_uuid(),
  fixed_asset_id uuid not null unique references fixed_assets(id),
  disposal_date date not null,
  disposal_type fixed_asset_disposal_type not null,
  proceeds_amount numeric(14,2) not null default 0 check (proceeds_amount >= 0),
  proceeds_account_id uuid references accounts(id),
  book_value_at_disposal numeric(14,2) not null,
  gain_loss_amount numeric(14,2) not null,
  gain_loss_account_id uuid references accounts(id),
  journal_entry_id uuid not null references journal_entries(id),
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  check ((proceeds_amount = 0 and proceeds_account_id is null) or (proceeds_amount > 0 and proceeds_account_id is not null)),
  check ((gain_loss_amount = 0 and gain_loss_account_id is null) or (gain_loss_amount <> 0 and gain_loss_account_id is not null))
);

create index fixed_asset_disposals_fixed_asset_id_idx on fixed_asset_disposals(fixed_asset_id);

create trigger fixed_asset_disposals_block_edit_delete
  before update or delete on fixed_asset_disposals
  for each row execute function block_edit_delete();

-- create_fixed_asset_disposal -- hitung nilai buku + laba/rugi, bikin jurnal (reuse
-- create_journal_entry, bukan insert manual), insert baris disposal, tandai aset disposed_at
-- -- atomik 1 RPC, sama pola post_depreciation. p_gain_account_id/p_loss_account_id keduanya
-- opsional di signature (dipakai salah satu doang tergantung tanda hasil hitung v_gain_loss,
-- RPC yang nentuin bukan caller) -- caller resolve keduanya dari default_account_settings
-- role fixed_assets.disposal_gain/disposal_loss, kirim dua-duanya, RPC pilih yang relevan.

create function create_fixed_asset_disposal(
  p_fixed_asset_id uuid,
  p_disposal_date date,
  p_disposal_type fixed_asset_disposal_type,
  p_source_ref text,
  p_proceeds_amount numeric default 0,
  p_proceeds_account_id uuid default null,
  p_gain_account_id uuid default null,
  p_loss_account_id uuid default null,
  p_notes text default null
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_asset fixed_assets%rowtype;
  v_accumulated numeric;
  v_book_value numeric;
  v_gain_loss numeric;
  v_gain_loss_account_id uuid;
  v_last_period date;
  v_lines jsonb := '[]'::jsonb;
  v_entry_id uuid;
  v_disposal_id uuid;
begin
  select * into v_asset from fixed_assets where id = p_fixed_asset_id;

  if v_asset.id is null then
    raise exception 'Aset % gak ditemukan', p_fixed_asset_id;
  end if;

  if v_asset.disposed_at is not null then
    raise exception 'Aset % sudah di-disposal sebelumnya', p_fixed_asset_id;
  end if;

  select coalesce(sum(amount), 0), max(period) into v_accumulated, v_last_period
    from depreciation_entries where fixed_asset_id = p_fixed_asset_id;

  if v_last_period is not null and p_disposal_date < v_last_period then
    raise exception 'Tanggal disposal (%) gak boleh lebih awal dari penyusutan terakhir (%)',
      p_disposal_date, v_last_period;
  end if;

  v_book_value := v_asset.acquisition_cost - v_accumulated;
  v_gain_loss := p_proceeds_amount - v_book_value;

  if v_accumulated > 0 then
    v_lines := v_lines || jsonb_build_object(
      'account_id', v_asset.accumulated_depreciation_account_id, 'debit', v_accumulated, 'credit', 0);
  end if;

  v_lines := v_lines || jsonb_build_object(
    'account_id', v_asset.asset_account_id, 'debit', 0, 'credit', v_asset.acquisition_cost);

  if p_proceeds_amount > 0 then
    if p_proceeds_account_id is null then
      raise exception 'proceeds_account_id wajib diisi kalau proceeds_amount > 0';
    end if;
    v_lines := v_lines || jsonb_build_object(
      'account_id', p_proceeds_account_id, 'debit', p_proceeds_amount, 'credit', 0);
  end if;

  if v_gain_loss > 0 then
    if p_gain_account_id is null then
      raise exception 'gain_account_id wajib diisi kalau ada laba pelepasan';
    end if;
    v_gain_loss_account_id := p_gain_account_id;
    v_lines := v_lines || jsonb_build_object(
      'account_id', p_gain_account_id, 'debit', 0, 'credit', v_gain_loss);
  elsif v_gain_loss < 0 then
    if p_loss_account_id is null then
      raise exception 'loss_account_id wajib diisi kalau ada rugi pelepasan';
    end if;
    v_gain_loss_account_id := p_loss_account_id;
    v_lines := v_lines || jsonb_build_object(
      'account_id', p_loss_account_id, 'debit', -v_gain_loss, 'credit', 0);
  end if;

  v_entry_id := create_journal_entry(
    p_disposal_date,
    'Disposal aset ' || v_asset.name,
    p_source_ref,
    v_lines
  );

  insert into fixed_asset_disposals (
    fixed_asset_id, disposal_date, disposal_type, proceeds_amount, proceeds_account_id,
    book_value_at_disposal, gain_loss_amount, gain_loss_account_id, journal_entry_id, notes, created_by
  ) values (
    p_fixed_asset_id, p_disposal_date, p_disposal_type, p_proceeds_amount,
    case when p_proceeds_amount > 0 then p_proceeds_account_id else null end,
    v_book_value, v_gain_loss, v_gain_loss_account_id, v_entry_id, p_notes, auth.uid()
  )
  returning id into v_disposal_id;

  update fixed_assets set disposed_at = now() where id = p_fixed_asset_id;

  return v_disposal_id;
end;
$$;

-- RLS Policy -- pola identik AR/AP/Inventory: select terbuka semua authenticated, insert cuma
-- admin/accountant, gak ada delete (arsip lewat archived_at di fixed_assets, immutability
-- trigger di depreciation_entries/fixed_asset_disposals).

alter table fixed_assets enable row level security;

create policy fixed_assets_select on fixed_assets
  for select using (auth.role() = 'authenticated');

create policy fixed_assets_insert on fixed_assets
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

create policy fixed_assets_update on fixed_assets
  for update using (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );
-- sengaja gak ada policy DELETE -> arsip lewat archived_at, hard delete tertutup total

alter table depreciation_entries enable row level security;

create policy depreciation_entries_select on depreciation_entries
  for select using (auth.role() = 'authenticated');

create policy depreciation_entries_insert on depreciation_entries
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );
-- sengaja gak ada policy UPDATE/DELETE -> RLS default deny + trigger block_edit_delete, 2 lapis

alter table fixed_asset_disposals enable row level security;

create policy fixed_asset_disposals_select on fixed_asset_disposals
  for select using (auth.role() = 'authenticated');

create policy fixed_asset_disposals_insert on fixed_asset_disposals
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );
-- sengaja gak ada policy UPDATE/DELETE -> RLS default deny + trigger block_edit_delete, 2 lapis

grant select, insert, update on fixed_assets to authenticated;
grant select, insert on depreciation_entries to authenticated;
grant select, insert on fixed_asset_disposals to authenticated;
