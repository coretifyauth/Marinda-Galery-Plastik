-- Disposal Aset Tetap: pencatatan pelepasan aset tetap (dijual/dibuang/hilang) + laba-rugi
-- pelepasan (Nilai Jual - Nilai Buku). Nutup gap yang sebelumnya "Catatan terbuka" di
-- memory/domain/fixed-assets.md / docs/domain/fixed-assets.md.
--
-- Kode akun 6000 (Beban Selisih Persediaan, 0004) dan 6100 (dipakai user buat "Beban Biaya
-- Pembelian" di data live, gak lewat migration file manapun -- ditambah manual lewat Studio)
-- sudah kepake, jadi akun rugi pelepasan baru ini pakai kode 6200.

insert into accounts (code, name, category) values
  ('6200', 'Rugi Pelepasan Aset Tetap', 'expense');

insert into default_account_settings (role_key, label, account_id) values
  ('fixed_assets.disposal_gain', 'Laba Pelepasan Aset Tetap', (select id from accounts where code = '4300')),
  ('fixed_assets.disposal_loss', 'Rugi Pelepasan Aset Tetap', (select id from accounts where code = '6200'));

alter table fixed_assets add column disposed_at timestamptz;

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

-- depreciation_entries_cap_check (0007) sudah select dari fixed_assets tiap insert --
-- reuse trigger yang sama buat sekalian blokir penyusutan pasca-disposal, bukan bikin
-- trigger baru.
create or replace function depreciation_entries_cap_check() returns trigger as $$
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

-- create_fixed_asset_disposal: hitung nilai buku + laba/rugi, bikin jurnal (reuse
-- create_journal_entry, bukan insert manual), insert baris disposal, tandai aset
-- disposed_at -- atomik 1 RPC, sama pola post_depreciation (0007).
--
-- p_gain_account_id/p_loss_account_id keduanya opsional di signature (dipakai salah satu
-- doang tergantung tanda hasil hitung v_gain_loss, RPC yang nentuin bukan caller) --
-- caller (frontend) resolve keduanya dari default_account_settings role fixed_assets.disposal_gain/
-- disposal_loss lewat LockedAccountField, kirim dua-duanya, RPC pilih yang relevan.
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

-- RLS: pola identik depreciation_entries -- select semua authenticated, insert cuma
-- admin/accountant, gak ada update/delete (immutability trigger + RLS default-deny, 2 lapis).

alter table fixed_asset_disposals enable row level security;

create policy fixed_asset_disposals_select on fixed_asset_disposals
  for select using (auth.role() = 'authenticated');

create policy fixed_asset_disposals_insert on fixed_asset_disposals
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

grant select, insert on fixed_asset_disposals to authenticated;
