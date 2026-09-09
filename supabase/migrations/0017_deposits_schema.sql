-- Deposits (AR Deposit + AP Deposit, digabung). Ref: memory/architecture/data/deposits-schema.md.
--
-- CATATAN BUG (ketauan pas konsolidasi 2026-09-07, di luar scope goods_notes): trigger
-- deposit_applications_guard() ORIGINAL (migration 0071) nulis
-- "if v_deposit_type = 'INBOUND' then ar_invoice_remaining() else ap_bill_remaining()" --
-- benar SAAT ITU (pra-migration 0074, INBOUND=AR). Migration 0074 (flip arah type jadi
-- OUTBOUND=AR/INBOUND=AP) TIDAK ikut update fungsi ini (dicek: gak ada di daftar 6 RPC inti
-- yang di-flip 0074, dan gak pernah di-CREATE OR REPLACE lagi sampai migration terakhir yang
-- ada). Di database LIVE saat ini, fungsi itu MASIH salah arah (cek AR pakai formula AP dan
-- sebaliknya) sejak 0074 diapply (2026-09-06). File migration baru ini (final state) sudah
-- DIPERBAIKI (branch dibalik sesuai makna type terkini) -- lihat cabang
-- "if v_deposit_type = 'OUTBOUND' then ar_invoice_remaining() else ap_bill_remaining()" di
-- bawah. Dilaporkan ke user terpisah, di luar scope migration goods_notes.

create table deposits (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('INBOUND', 'OUTBOUND')),
  counterparty_id uuid not null references counterparties(id),
  deposit_date date not null,
  source_ref text not null,
  amount numeric(14,2) not null check (amount > 0),
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  remaining numeric(14,2) not null,
  status text not null default 'belum_dipakai'
);

create index deposits_counterparty_id_idx on deposits(counterparty_id);
create index deposits_journal_entry_id_idx on deposits(journal_entry_id);

create table deposit_applications (
  id uuid primary key default gen_random_uuid(),
  deposit_id uuid not null references deposits(id),
  transaction_id uuid not null references transactions(id),
  amount numeric(14,2) not null check (amount > 0),
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table deposit_refunds (
  id uuid primary key default gen_random_uuid(),
  deposit_id uuid not null references deposits(id),
  amount numeric(14,2) not null check (amount > 0),
  refund_date date not null,
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table deposit_forfeitures (
  id uuid primary key default gen_random_uuid(),
  deposit_id uuid not null references deposits(id),
  amount numeric(14,2) not null check (amount > 0),
  forfeiture_date date not null,
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create trigger deposits_counterparty_role_guard_inbound
  before insert on deposits
  for each row when (new.type = 'INBOUND')
  execute function counterparty_role_guard('counterparty_id', 'supplier');

create trigger deposits_counterparty_role_guard_outbound
  before insert on deposits
  for each row when (new.type = 'OUTBOUND')
  execute function counterparty_role_guard('counterparty_id', 'customer');

create function deposits_set_defaults() returns trigger as $$
begin
  new.remaining := new.amount;
  return new;
end;
$$ language plpgsql;

create trigger deposits_set_defaults_trigger
  before insert on deposits
  for each row execute function deposits_set_defaults();

create function deposits_block_edit_delete_or_sync() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'deposits gak pernah bisa diedit/dihapus — cuma reversing entry (lihat general-ledger.md)';
  end if;

  if (old.type, old.counterparty_id, old.deposit_date, old.source_ref, old.amount, old.journal_entry_id,
      old.created_by, old.created_at)
     is distinct from
     (new.type, new.counterparty_id, new.deposit_date, new.source_ref, new.amount, new.journal_entry_id,
      new.created_by, new.created_at) then
    raise exception 'deposits gak pernah bisa diedit/dihapus — cuma reversing entry (lihat general-ledger.md)';
  end if;

  return new;
end;
$$ language plpgsql;

create trigger deposits_block_edit_delete
  before update or delete on deposits
  for each row execute function deposits_block_edit_delete_or_sync();

create function deposit_remaining(p_deposit_id uuid) returns numeric as $$
  select d.amount
    - coalesce((
        select sum(da.amount) from deposit_applications da
        where da.deposit_id = p_deposit_id
          and not exists (
            select 1 from journal_entries je where je.reverses_entry_id = da.journal_entry_id
          )
      ), 0)
    - coalesce((select sum(amount) from deposit_refunds where deposit_id = p_deposit_id), 0)
    - coalesce((select sum(amount) from deposit_forfeitures where deposit_id = p_deposit_id), 0)
  from deposits d
  where d.id = p_deposit_id;
$$ language sql stable;

create trigger deposit_applications_block_edit_delete
  before update or delete on deposit_applications
  for each row execute function block_edit_delete();

create function deposit_applications_guard() returns trigger as $$
declare
  v_remaining numeric;
  v_deposit_type text;
  v_deposit_counterparty_id uuid;
  v_transaction_type text;
  v_transaction_counterparty_id uuid;
  v_transaction_journal_entry_id uuid;
  v_transaction_cancelled boolean;
  v_transaction_remaining numeric;
  v_deposit_ref text;
  v_transaction_ref text;
begin
  select deposit_remaining(new.deposit_id) into v_remaining;

  if new.amount > v_remaining then
    select source_ref into v_deposit_ref from deposits where id = new.deposit_id;
    raise exception 'Penerapan deposit % melebihi sisa deposit (sisa %, coba terapkan %)',
      v_deposit_ref, v_remaining, new.amount;
  end if;

  select type, counterparty_id into v_deposit_type, v_deposit_counterparty_id from deposits where id = new.deposit_id;
  select type, counterparty_id, journal_entry_id into v_transaction_type, v_transaction_counterparty_id, v_transaction_journal_entry_id
    from transactions where id = new.transaction_id;

  if v_transaction_type is distinct from v_deposit_type then
    select source_ref into v_deposit_ref from deposits where id = new.deposit_id;
    select source_ref into v_transaction_ref from transactions where id = new.transaction_id;
    raise exception 'Deposit % (%) gak bisa diterapkan ke transaksi % (%) -- arah beda', v_deposit_ref, v_deposit_type, v_transaction_ref, v_transaction_type;
  end if;

  if v_transaction_counterparty_id is distinct from v_deposit_counterparty_id then
    select source_ref into v_deposit_ref from deposits where id = new.deposit_id;
    select source_ref into v_transaction_ref from transactions where id = new.transaction_id;
    raise exception 'Deposit % milik pihak lain -- gak bisa diterapkan ke transaksi %', v_deposit_ref, v_transaction_ref;
  end if;

  select exists (
    select 1 from journal_entries je where je.reverses_entry_id = v_transaction_journal_entry_id
  ) into v_transaction_cancelled;

  if v_transaction_cancelled then
    select source_ref into v_transaction_ref from transactions where id = new.transaction_id;
    raise exception 'Transaksi % udah dibatalkan -- gak bisa diterapkan DP ke situ', v_transaction_ref;
  end if;

  -- DIPERBAIKI (lihat catatan bug di kepala file): OUTBOUND=AR sejak migration 0074.
  if v_deposit_type = 'OUTBOUND' then
    select ar_invoice_remaining(new.transaction_id) into v_transaction_remaining;
  else
    select ap_bill_remaining(new.transaction_id) into v_transaction_remaining;
  end if;

  if new.amount > v_transaction_remaining then
    select source_ref into v_transaction_ref from transactions where id = new.transaction_id;
    raise exception 'Penerapan deposit ke transaksi % melebihi sisa outstanding (sisa %, coba terapkan %)',
      v_transaction_ref, v_transaction_remaining, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger deposit_applications_guard_trigger
  before insert on deposit_applications
  for each row execute function deposit_applications_guard();

create function recompute_deposit_status(p_deposit_id uuid) returns void as $$
declare
  v_amount numeric;
  v_remaining numeric;
  v_status text;
begin
  select amount into v_amount from deposits where id = p_deposit_id;
  if not found then
    return;
  end if;

  v_remaining := deposit_remaining(p_deposit_id);

  v_status := case
    when v_remaining <= 0.005 then 'selesai'
    when v_remaining < v_amount then 'sebagian'
    else 'belum_dipakai'
  end;

  update deposits set remaining = v_remaining, status = v_status where id = p_deposit_id;
end;
$$ language plpgsql security definer set search_path = public;

create function deposit_applications_sync_deposit_status() returns trigger as $$
begin
  perform recompute_deposit_status(new.deposit_id);
  perform recompute_transaction_status(new.transaction_id);
  return new;
end;
$$ language plpgsql;

create trigger deposit_applications_sync_deposit_status_trigger
  after insert on deposit_applications
  for each row execute function deposit_applications_sync_deposit_status();

create trigger deposit_refunds_block_edit_delete
  before update or delete on deposit_refunds
  for each row execute function block_edit_delete();

create function deposit_refunds_guard() returns trigger as $$
declare
  v_remaining numeric;
  v_deposit_ref text;
begin
  select deposit_remaining(new.deposit_id) into v_remaining;

  if new.amount > v_remaining then
    select source_ref into v_deposit_ref from deposits where id = new.deposit_id;
    raise exception 'Refund deposit % melebihi sisa deposit (sisa %, coba refund %)',
      v_deposit_ref, v_remaining, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger deposit_refunds_guard_trigger
  before insert on deposit_refunds
  for each row execute function deposit_refunds_guard();

create function deposit_refunds_sync_deposit_status() returns trigger as $$
begin
  perform recompute_deposit_status(new.deposit_id);
  return new;
end;
$$ language plpgsql;

create trigger deposit_refunds_sync_deposit_status_trigger
  after insert on deposit_refunds
  for each row execute function deposit_refunds_sync_deposit_status();

create trigger deposit_forfeitures_block_edit_delete
  before update or delete on deposit_forfeitures
  for each row execute function block_edit_delete();

create function deposit_forfeitures_guard() returns trigger as $$
declare
  v_remaining numeric;
  v_deposit_ref text;
begin
  select deposit_remaining(new.deposit_id) into v_remaining;

  if new.amount > v_remaining then
    select source_ref into v_deposit_ref from deposits where id = new.deposit_id;
    raise exception 'Forfeiture deposit % melebihi sisa deposit (sisa %, coba hanguskan %)',
      v_deposit_ref, v_remaining, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger deposit_forfeitures_guard_trigger
  before insert on deposit_forfeitures
  for each row execute function deposit_forfeitures_guard();

create function deposit_forfeitures_sync_deposit_status() returns trigger as $$
begin
  perform recompute_deposit_status(new.deposit_id);
  return new;
end;
$$ language plpgsql;

create trigger deposit_forfeitures_sync_deposit_status_trigger
  after insert on deposit_forfeitures
  for each row execute function deposit_forfeitures_sync_deposit_status();

-- create_deposit/apply_deposit/refund_deposit/forfeit_deposit -- 4 RPC generic.
create function create_deposit(
  p_type text,
  p_counterparty_id uuid,
  p_deposit_date date,
  p_source_ref text,
  p_amount numeric,
  p_cash_account_id uuid,
  p_deposit_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_entry_id uuid;
  v_deposit_id uuid;
begin
  if p_type not in ('INBOUND', 'OUTBOUND') then
    raise exception 'p_type harus INBOUND atau OUTBOUND, dapat %', p_type;
  end if;

  if p_type = 'OUTBOUND' then
    v_entry_id := create_journal_entry(
      p_deposit_date, 'Uang muka diterima', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_cash_account_id, 'debit', p_amount, 'credit', 0),
        jsonb_build_object('account_id', p_deposit_account_id, 'debit', 0, 'credit', p_amount)
      )
    );
  else
    v_entry_id := create_journal_entry(
      p_deposit_date, 'Uang muka dibayar ke supplier', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_deposit_account_id, 'debit', p_amount, 'credit', 0),
        jsonb_build_object('account_id', p_cash_account_id, 'debit', 0, 'credit', p_amount)
      )
    );
  end if;

  insert into deposits (type, counterparty_id, deposit_date, source_ref, amount, journal_entry_id, created_by)
  values (p_type, p_counterparty_id, p_deposit_date, p_source_ref, p_amount, v_entry_id, auth.uid())
  returning id into v_deposit_id;

  return v_deposit_id;
end;
$$;

create function apply_deposit(
  p_deposit_id uuid,
  p_transaction_id uuid,
  p_amount numeric,
  p_entry_date date,
  p_source_ref text,
  p_deposit_account_id uuid,
  p_control_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_type text;
  v_entry_id uuid;
  v_application_id uuid;
begin
  select type into v_type from deposits where id = p_deposit_id;

  if v_type = 'OUTBOUND' then
    v_entry_id := create_journal_entry(
      p_entry_date, 'Penerapan uang muka ke invoice', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_deposit_account_id, 'debit', p_amount, 'credit', 0),
        jsonb_build_object('account_id', p_control_account_id, 'debit', 0, 'credit', p_amount)
      )
    );
  else
    v_entry_id := create_journal_entry(
      p_entry_date, 'Penerapan uang muka ke bill', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_control_account_id, 'debit', p_amount, 'credit', 0),
        jsonb_build_object('account_id', p_deposit_account_id, 'debit', 0, 'credit', p_amount)
      )
    );
  end if;

  insert into deposit_applications (deposit_id, transaction_id, amount, source_ref, journal_entry_id, created_by)
  values (p_deposit_id, p_transaction_id, p_amount, p_source_ref, v_entry_id, auth.uid())
  returning id into v_application_id;

  return v_application_id;
end;
$$;

create function refund_deposit(
  p_deposit_id uuid,
  p_amount numeric,
  p_refund_date date,
  p_source_ref text,
  p_deposit_account_id uuid,
  p_cash_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_type text;
  v_entry_id uuid;
  v_refund_id uuid;
begin
  select type into v_type from deposits where id = p_deposit_id;

  if v_type = 'OUTBOUND' then
    v_entry_id := create_journal_entry(
      p_refund_date, 'Refund uang muka', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_deposit_account_id, 'debit', p_amount, 'credit', 0),
        jsonb_build_object('account_id', p_cash_account_id, 'debit', 0, 'credit', p_amount)
      )
    );
  else
    v_entry_id := create_journal_entry(
      p_refund_date, 'Refund uang muka dari supplier', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_cash_account_id, 'debit', p_amount, 'credit', 0),
        jsonb_build_object('account_id', p_deposit_account_id, 'debit', 0, 'credit', p_amount)
      )
    );
  end if;

  insert into deposit_refunds (deposit_id, amount, refund_date, source_ref, journal_entry_id, created_by)
  values (p_deposit_id, p_amount, p_refund_date, p_source_ref, v_entry_id, auth.uid())
  returning id into v_refund_id;

  return v_refund_id;
end;
$$;

create function forfeit_deposit(
  p_deposit_id uuid,
  p_amount numeric,
  p_forfeiture_date date,
  p_source_ref text,
  p_deposit_account_id uuid,
  p_offset_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_type text;
  v_entry_id uuid;
  v_forfeiture_id uuid;
begin
  select type into v_type from deposits where id = p_deposit_id;

  if v_type = 'OUTBOUND' then
    v_entry_id := create_journal_entry(
      p_forfeiture_date, 'Uang muka hangus', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_deposit_account_id, 'debit', p_amount, 'credit', 0),
        jsonb_build_object('account_id', p_offset_account_id, 'debit', 0, 'credit', p_amount)
      )
    );
  else
    v_entry_id := create_journal_entry(
      p_forfeiture_date, 'Uang muka hangus', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_offset_account_id, 'debit', p_amount, 'credit', 0),
        jsonb_build_object('account_id', p_deposit_account_id, 'debit', 0, 'credit', p_amount)
      )
    );
  end if;

  insert into deposit_forfeitures (deposit_id, amount, forfeiture_date, source_ref, journal_entry_id, created_by)
  values (p_deposit_id, p_amount, p_forfeiture_date, p_source_ref, v_entry_id, auth.uid())
  returning id into v_forfeiture_id;

  return v_forfeiture_id;
end;
$$;

alter table deposits enable row level security;
alter table deposit_applications enable row level security;
alter table deposit_refunds enable row level security;
alter table deposit_forfeitures enable row level security;

create policy deposits_select on deposits for select using (auth.role() = 'authenticated');
create policy deposits_insert on deposits for insert with check (
  exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
);

create policy deposit_applications_select on deposit_applications for select using (auth.role() = 'authenticated');
create policy deposit_applications_insert on deposit_applications for insert with check (
  exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
);

create policy deposit_refunds_select on deposit_refunds for select using (auth.role() = 'authenticated');
create policy deposit_refunds_insert on deposit_refunds for insert with check (
  exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
);

create policy deposit_forfeitures_select on deposit_forfeitures for select using (auth.role() = 'authenticated');
create policy deposit_forfeitures_insert on deposit_forfeitures for insert with check (
  exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
);

grant select, insert on deposits to authenticated;
grant select, insert on deposit_applications to authenticated;
grant select, insert on deposit_refunds to authenticated;
grant select, insert on deposit_forfeitures to authenticated;

grant execute on function create_deposit(text, uuid, date, text, numeric, uuid, uuid) to authenticated;
grant execute on function apply_deposit(uuid, uuid, numeric, date, text, uuid, uuid) to authenticated;
grant execute on function refund_deposit(uuid, numeric, date, text, uuid, uuid) to authenticated;
grant execute on function forfeit_deposit(uuid, numeric, date, text, uuid, uuid) to authenticated;
