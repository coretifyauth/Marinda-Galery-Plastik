-- Gabung ar_deposits+ap_deposits (+applications/refunds/forfeitures masing-masing) jadi
-- 4 tabel generic: deposits, deposit_applications, deposit_refunds, deposit_forfeitures.
-- Fase 3 dari unifikasi tabel anak AR/AP. Beda dari credit_notes (0070), RPC di sini
-- DIGABUNG jadi 1 per operasi (create_deposit/apply_deposit/refund_deposit/forfeit_deposit)
-- -- logic-nya near-exact mirror kayak payments (0069), cuma akun & arah debit/kredit
-- ketuker, jadi maksa gabung gak nambah kompleksitas (beda kasus dari credit_notes).

-- 1. Tabel deposits (header)
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

insert into deposits (id, type, counterparty_id, deposit_date, source_ref, amount, journal_entry_id, created_by, created_at, remaining, status)
select id, 'INBOUND', customer_id, deposit_date, source_ref, amount, journal_entry_id, created_by, created_at, remaining, status
from ar_deposits
union all
select id, 'OUTBOUND', supplier_id, deposit_date, source_ref, amount, journal_entry_id, created_by, created_at, remaining, status
from ap_deposits;

-- 2. Tabel deposit_applications
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

create index deposit_applications_deposit_id_idx on deposit_applications(deposit_id);
create index deposit_applications_transaction_id_idx on deposit_applications(transaction_id);

insert into deposit_applications (id, deposit_id, transaction_id, amount, source_ref, journal_entry_id, created_by, created_at)
select id, deposit_id, invoice_id, amount, source_ref, journal_entry_id, created_by, created_at from ar_deposit_applications
union all
select id, deposit_id, bill_id, amount, source_ref, journal_entry_id, created_by, created_at from ap_deposit_applications;

-- 3. Tabel deposit_refunds
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

create index deposit_refunds_deposit_id_idx on deposit_refunds(deposit_id);

insert into deposit_refunds (id, deposit_id, amount, refund_date, source_ref, journal_entry_id, created_by, created_at)
select id, deposit_id, amount, refund_date, source_ref, journal_entry_id, created_by, created_at from ar_deposit_refunds
union all
select id, deposit_id, amount, refund_date, source_ref, journal_entry_id, created_by, created_at from ap_deposit_refunds;

-- 4. Tabel deposit_forfeitures
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

create index deposit_forfeitures_deposit_id_idx on deposit_forfeitures(deposit_id);

insert into deposit_forfeitures (id, deposit_id, amount, forfeiture_date, source_ref, journal_entry_id, created_by, created_at)
select id, deposit_id, amount, forfeiture_date, source_ref, journal_entry_id, created_by, created_at from ar_deposit_forfeitures
union all
select id, deposit_id, amount, forfeiture_date, source_ref, journal_entry_id, created_by, created_at from ap_deposit_forfeitures;

-- 5. Trigger deposits: type-safety counterparty (reuse counterparty_role_guard)
create trigger deposits_counterparty_role_guard_inbound
  before insert on deposits
  for each row when (new.type = 'INBOUND')
  execute function counterparty_role_guard('counterparty_id', 'customer');

create trigger deposits_counterparty_role_guard_outbound
  before insert on deposits
  for each row when (new.type = 'OUTBOUND')
  execute function counterparty_role_guard('counterparty_id', 'supplier');

-- 6. Trigger deposits: set default remaining = amount pas insert
create function deposits_set_defaults() returns trigger as $$
begin
  new.remaining := new.amount;
  return new;
end;
$$ language plpgsql;

create trigger deposits_set_defaults_trigger
  before insert on deposits
  for each row execute function deposits_set_defaults();

-- 7. Trigger deposits: immutability selektif (kolom bisnis asli terkunci, remaining/status boleh diubah trigger)
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

-- 8. deposit_remaining(deposit_id) -- gantiin ar_deposit_remaining + ap_deposit_remaining
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

-- 9. Trigger deposit_applications: immutability + guard + sync status
create trigger deposit_applications_block_edit_delete
  before update or delete on deposit_applications
  for each row execute function block_edit_delete();

-- Guard gabungan: sisa deposit, type match (deposit vs transaction), counterparty match,
-- transaction belum dibatalkan, sisa outstanding transaction -- persis gabungan
-- ar_deposit_applications_guard + ap_deposit_applications_guard, cabang by v_deposit_type
-- cuma buat milih ar_invoice_remaining/ap_bill_remaining di langkah terakhir.
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

  if v_deposit_type = 'INBOUND' then
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

-- 10. recompute_deposit_status(deposit_id) -- gantiin recompute_ar_deposit_status + recompute_ap_deposit_status
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

-- 11. Trigger deposit_refunds: immutability + guard + sync status
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

-- 12. Trigger deposit_forfeitures: immutability + guard + sync status
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

-- 13. RLS & Grant (pola identik ke-8 tabel lama)
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

-- 14. RPC generic, gantiin create_ar_deposit + create_ap_deposit
create function create_deposit(
  p_type text,
  p_counterparty_id uuid,
  p_deposit_date date,
  p_source_ref text,
  p_amount numeric,
  p_cash_account_id uuid,
  p_deposit_account_id uuid -- INBOUND: Uang Muka Penjualan (liability), OUTBOUND: Uang Muka Pembelian (asset)
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

  if p_type = 'INBOUND' then
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

drop function if exists create_ar_deposit(uuid, date, text, numeric, uuid, uuid);
drop function if exists create_ap_deposit(uuid, date, text, numeric, uuid, uuid);

-- 15. RPC generic, gantiin apply_ar_deposit + apply_ap_deposit
create function apply_deposit(
  p_deposit_id uuid,
  p_transaction_id uuid,
  p_amount numeric,
  p_entry_date date,
  p_source_ref text,
  p_deposit_account_id uuid,
  p_control_account_id uuid -- INBOUND: Piutang Usaha, OUTBOUND: Utang Usaha
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

  if v_type = 'INBOUND' then
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

drop function if exists apply_ar_deposit(uuid, uuid, numeric, date, text, uuid, uuid);
drop function if exists apply_ap_deposit(uuid, uuid, numeric, date, text, uuid, uuid);

-- 16. RPC generic, gantiin refund_ar_deposit + refund_ap_deposit
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

  if v_type = 'INBOUND' then
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

drop function if exists refund_ar_deposit(uuid, numeric, date, text, uuid, uuid);
drop function if exists refund_ap_deposit(uuid, numeric, date, text, uuid, uuid);

-- 17. RPC generic, gantiin forfeit_ar_deposit + forfeit_ap_deposit
create function forfeit_deposit(
  p_deposit_id uuid,
  p_amount numeric,
  p_forfeiture_date date,
  p_source_ref text,
  p_deposit_account_id uuid,
  p_offset_account_id uuid -- INBOUND: Pendapatan Lain-lain (kredit), OUTBOUND: Beban Kerugian Uang Muka (debit)
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

  if v_type = 'INBOUND' then
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

drop function if exists forfeit_ar_deposit(uuid, numeric, date, text, uuid, uuid);
drop function if exists forfeit_ap_deposit(uuid, numeric, date, text, uuid, uuid);

-- 18. ar_invoice_remaining/ap_bill_remaining: reducer #3 (deposit application aktif) -> target deposit_applications
create or replace function ar_invoice_remaining(p_invoice_id uuid) returns numeric as $$
  select ai.amount
    - coalesce((
        select sum(amount) from payments where transaction_id = p_invoice_id and type = 'INBOUND'
      ), 0)
    - coalesce((
        select sum(amount) from credit_notes where transaction_id = p_invoice_id and type = 'INBOUND'
      ), 0)
    - coalesce((
        select sum(da.amount) from deposit_applications da
        where da.transaction_id = p_invoice_id
          and not exists (
            select 1 from journal_entries je where je.reverses_entry_id = da.journal_entry_id
          )
      ), 0)
    + coalesce((
        select sum(arc.amount) from ar_return_credits arc
        join credit_notes acn on acn.id = arc.credit_note_id
        where acn.transaction_id = p_invoice_id
      ), 0)
    + coalesce((
        select sum(wr.discount_reversed_amount - wr.return_credit_settled_amount)
        from warranty_replacements wr
        join credit_notes cn on cn.id = wr.credit_note_id
        where cn.transaction_id = p_invoice_id
      ), 0)
  from transactions ai
  where ai.id = p_invoice_id;
$$ language sql stable;

create or replace function ap_bill_remaining(p_bill_id uuid) returns numeric as $$
  select ab.amount
    - coalesce((select sum(amount) from payments where transaction_id = p_bill_id and type = 'OUTBOUND'), 0)
    - coalesce((select sum(amount) from credit_notes where transaction_id = p_bill_id and type = 'OUTBOUND'), 0)
    - coalesce((
        select sum(da.amount) from deposit_applications da
        where da.transaction_id = p_bill_id
          and not exists (
            select 1 from journal_entries je where je.reverses_entry_id = da.journal_entry_id
          )
      ), 0)
    + coalesce((
        select sum(arc.amount) from ap_return_credits arc
        join credit_notes acn on acn.id = arc.credit_note_id
        where acn.transaction_id = p_bill_id
      ), 0)
  from transactions ab
  where ab.id = p_bill_id;
$$ language sql stable;

-- 19. cancel_ar_invoice/cancel_ap_bill: auto-unwind loop -> target deposit_applications
create or replace function cancel_ar_invoice(
  p_invoice_id uuid,
  p_entry_date date,
  p_source_ref text
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_paid_count int;
  v_original_entry_id uuid;
  v_new_entry_id uuid;
  v_application record;
  v_invoice_ref text;
begin
  select count(*) into v_paid_count
  from payments where transaction_id = p_invoice_id and type = 'INBOUND';

  if v_paid_count > 0 then
    select source_ref into v_invoice_ref from transactions where id = p_invoice_id;
    raise exception 'Invoice % udah punya payment — gak bisa dibatalkan lewat jalur ini', v_invoice_ref;
  end if;

  select journal_entry_id into v_original_entry_id from transactions where id = p_invoice_id;

  v_new_entry_id := reverse_journal_entry(v_original_entry_id, p_entry_date, p_source_ref);

  for v_application in
    select da.journal_entry_id
    from deposit_applications da
    where da.transaction_id = p_invoice_id
      and not exists (
        select 1 from journal_entries je where je.reverses_entry_id = da.journal_entry_id
      )
  loop
    perform reverse_journal_entry(v_application.journal_entry_id, p_entry_date, p_source_ref);
  end loop;

  return v_new_entry_id;
end;
$$;

create or replace function cancel_ap_bill(
  p_bill_id uuid,
  p_entry_date date,
  p_source_ref text
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_allocated_count int;
  v_credit_note_count int;
  v_original_entry_id uuid;
  v_new_entry_id uuid;
  v_application record;
  v_bill_ref text;
begin
  select count(*) into v_allocated_count
  from payments where transaction_id = p_bill_id and type = 'OUTBOUND';

  if v_allocated_count > 0 then
    select source_ref into v_bill_ref from transactions where id = p_bill_id;
    raise exception 'Bill % udah punya % payment -- gak bisa dibatalkan lewat jalur ini', v_bill_ref, v_allocated_count;
  end if;

  select count(*) into v_credit_note_count
  from credit_notes where transaction_id = p_bill_id and type = 'OUTBOUND';

  if v_credit_note_count > 0 then
    select source_ref into v_bill_ref from transactions where id = p_bill_id;
    raise exception 'Bill % udah punya % retur (credit note) -- gak bisa dibatalkan lewat jalur ini', v_bill_ref, v_credit_note_count;
  end if;

  select journal_entry_id into v_original_entry_id from transactions where id = p_bill_id;

  v_new_entry_id := reverse_journal_entry(v_original_entry_id, p_entry_date, p_source_ref);

  for v_application in
    select da.journal_entry_id
    from deposit_applications da
    where da.transaction_id = p_bill_id
      and not exists (
        select 1 from journal_entries je where je.reverses_entry_id = da.journal_entry_id
      )
  loop
    perform reverse_journal_entry(v_application.journal_entry_id, p_entry_date, p_source_ref);
  end loop;

  return v_new_entry_id;
end;
$$;

-- 20. recompute_transaction_status: reducer v_deposit_applied (kedua cabang) -> target deposit_applications
create or replace function recompute_transaction_status(p_transaction_id uuid) returns void as $$
declare
  v_type text;
  v_journal_entry_id uuid;
  v_outstanding numeric;
  v_returned numeric;
  v_is_cancelled boolean;
  v_allocated numeric;
  v_deposit_applied numeric;
  v_status text;
  v_origin text;
begin
  select type, journal_entry_id into v_type, v_journal_entry_id from transactions where id = p_transaction_id;
  if not found then
    return;
  end if;

  select exists (
    select 1 from journal_entries je where je.reverses_entry_id = v_journal_entry_id
  ) into v_is_cancelled;

  if v_type = 'INBOUND' then
    v_outstanding := ar_invoice_remaining(p_transaction_id);

    select coalesce(sum(amount), 0) into v_returned
      from credit_notes where transaction_id = p_transaction_id and type = 'INBOUND';

    select coalesce(sum(amount), 0) into v_allocated
      from payments where transaction_id = p_transaction_id and type = 'INBOUND';

    select coalesce(sum(amount), 0) into v_deposit_applied
      from deposit_applications where transaction_id = p_transaction_id;

    v_status := case
      when v_is_cancelled then 'dibatalkan'
      when v_outstanding <= 0.005 then 'lunas'
      when v_allocated > 0 or v_deposit_applied > 0 then 'sebagian'
      else 'belum'
    end;

    v_origin := case
      when not exists (select 1 from goods_issues gi where gi.invoice_id = p_transaction_id) then 'financial_only'
      when exists (
        select 1 from goods_issues gi
        join goods_issue_lines gil on gil.goods_issue_id = gi.id
        where gi.invoice_id = p_transaction_id and gil.order_line_id is not null
      ) then 'order'
      else 'goods_movement'
    end;

    update transactions
      set outstanding = v_outstanding, returned = v_returned, status = v_status, origin = v_origin
      where id = p_transaction_id;
  else
    v_outstanding := ap_bill_remaining(p_transaction_id);

    select coalesce(sum(amount), 0) into v_allocated
      from payments where transaction_id = p_transaction_id and type = 'OUTBOUND';

    -- Beda dari AR: deposit_applied di sini SENGAJA exclude yang reversed (persis
    -- ap_bills_with_status 0032/0038 dulu) -- asimetri ini bukan kelalaian, disalin
    -- apa adanya dari recompute_ap_bill_status.
    select coalesce(sum(da.amount), 0) into v_deposit_applied
      from deposit_applications da
      where da.transaction_id = p_transaction_id
        and not exists (select 1 from journal_entries je where je.reverses_entry_id = da.journal_entry_id);

    v_status := case
      when v_is_cancelled then 'dibatalkan'
      when v_outstanding <= 0.005 then 'lunas'
      when v_allocated > 0 or v_deposit_applied > 0 then 'sebagian'
      else 'belum'
    end;

    v_origin := case
      when not exists (select 1 from goods_receipt_notes grn where grn.bill_id = p_transaction_id) then 'financial_only'
      when exists (
        select 1 from goods_receipt_notes grn
        where grn.bill_id = p_transaction_id and grn.order_id is not null
      ) then 'order'
      else 'goods_movement'
    end;

    update transactions
      set outstanding = v_outstanding, status = v_status, origin = v_origin
      where id = p_transaction_id;
  end if;
end;
$$ language plpgsql security definer set search_path = public;

-- 21. journal_entries_sync_reversal_status: gabungan loop ar/ap -> 1 loop over deposit_applications,
-- panggil recompute_deposit_status (gantiin recompute_ar_deposit_status/recompute_ap_deposit_status)
create or replace function journal_entries_sync_reversal_status() returns trigger as $$
declare
  v_id uuid;
begin
  if new.reverses_entry_id is null then
    return new;
  end if;

  for v_id in select id from transactions where journal_entry_id = new.reverses_entry_id loop
    perform recompute_transaction_status(v_id);
  end loop;

  update pos_sales set status = 'dibatalkan' where revenue_journal_entry_id = new.reverses_entry_id;

  for v_id in select transaction_id from deposit_applications where journal_entry_id = new.reverses_entry_id loop
    perform recompute_transaction_status(v_id);
  end loop;
  for v_id in select deposit_id from deposit_applications where journal_entry_id = new.reverses_entry_id loop
    perform recompute_deposit_status(v_id);
  end loop;

  return new;
end;
$$ language plpgsql security definer set search_path = public;

-- 22. View ar_deposits_with_status/ap_deposits_with_status -> target deposits, filter type
create or replace view ar_deposits_with_status
  with (security_invoker = true) as
select id, counterparty_id as customer_id, deposit_date, source_ref, amount, journal_entry_id, created_at, remaining::numeric as remaining, status
from deposits
where type = 'INBOUND';

create or replace view ap_deposits_with_status
  with (security_invoker = true) as
select id, counterparty_id as supplier_id, deposit_date, source_ref, amount, journal_entry_id, created_at, remaining::numeric as remaining, status
from deposits
where type = 'OUTBOUND';

-- 23. Drop tabel lama (cascade trigger/index/RLS/grant) + fungsi trigger/remaining/recompute yang jadi orphan
drop table if exists ar_deposit_applications;
drop table if exists ap_deposit_applications;
drop table if exists ar_deposit_refunds;
drop table if exists ap_deposit_refunds;
drop table if exists ar_deposit_forfeitures;
drop table if exists ap_deposit_forfeitures;
drop table if exists ar_deposits;
drop table if exists ap_deposits;

drop function if exists ar_deposit_remaining(uuid);
drop function if exists ap_deposit_remaining(uuid);
drop function if exists recompute_ar_deposit_status(uuid);
drop function if exists recompute_ap_deposit_status(uuid);
drop function if exists ar_deposits_set_defaults();
drop function if exists ap_deposits_set_defaults();
drop function if exists ar_deposits_block_edit_delete_or_sync();
drop function if exists ap_deposits_block_edit_delete_or_sync();
drop function if exists ar_deposit_applications_guard();
drop function if exists ap_deposit_applications_guard();
drop function if exists ar_deposit_refunds_guard();
drop function if exists ap_deposit_refunds_guard();
drop function if exists ar_deposit_forfeitures_guard();
drop function if exists ap_deposit_forfeitures_guard();
drop function if exists ar_deposit_applications_sync_deposit_status();
drop function if exists ap_deposit_applications_sync_deposit_status();
drop function if exists ar_deposit_refunds_sync_deposit_status();
drop function if exists ap_deposit_refunds_sync_deposit_status();
drop function if exists ar_deposit_forfeitures_sync_deposit_status();
drop function if exists ap_deposit_forfeitures_sync_deposit_status();
