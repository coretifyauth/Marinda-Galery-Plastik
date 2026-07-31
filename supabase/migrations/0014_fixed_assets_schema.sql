-- Fixed Assets (Fase 6). Ref docs/architecture/data/fixed-assets-schema.md.

-- 1. accounts.is_contra + regenerate normal_balance generated column
alter table accounts add column is_contra boolean not null default false;

alter table accounts drop column normal_balance;

alter table accounts add column normal_balance balance_side generated always as (
  case
    when category in ('asset','expense') then
      case when is_contra then 'credit'::balance_side else 'debit'::balance_side end
    else
      case when is_contra then 'debit'::balance_side else 'credit'::balance_side end
  end
) stored;

create or replace function accounts_published_lock() returns trigger as $$
begin
  if (old.code, old.category, old.normal_balance, old.parent_id, old.is_contra)
     is distinct from (new.code, new.category, new.normal_balance, new.parent_id, new.is_contra) then
    if exists (select 1 from journal_lines where account_id = old.id) then
      raise exception 'Akun % sudah dipakai di jurnal — code/category/normal_balance/parent_id/is_contra terkunci', old.code;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

-- 2. fixed_assets + depreciation_entries
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

-- 3. Trigger

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

create function depreciation_entries_cap_check() returns trigger as $$
declare
  v_cost numeric;
  v_salvage numeric;
  v_accumulated numeric;
begin
  select acquisition_cost, salvage_value into v_cost, v_salvage
    from fixed_assets where id = new.fixed_asset_id;

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

create trigger depreciation_entries_block_edit_delete
  before update or delete on depreciation_entries
  for each row execute function block_edit_delete();

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

-- 4. RPC

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

  -- potong otomatis kalau lewat cap (lihat catatan teknis declining balance, docs/domain/human/fixed-assets.md)
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

-- 5. RLS

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

alter table depreciation_entries enable row level security;

create policy depreciation_entries_select on depreciation_entries
  for select using (auth.role() = 'authenticated');

create policy depreciation_entries_insert on depreciation_entries
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

-- 6. Grant

grant select, insert, update on fixed_assets to authenticated;
grant select, insert on depreciation_entries to authenticated;
