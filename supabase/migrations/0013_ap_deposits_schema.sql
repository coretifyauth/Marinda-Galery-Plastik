-- AP Deposit (Uang Muka ke Supplier) -- mirror AR Deposit (ar_deposits, arah kebalik: asset
-- "Uang Muka Pembelian" bukan liability, karena supplier yang "berutang" balik ke kita, bukan
-- sebaliknya). Beda dari AR: dibangun partial-capable DAN dengan 2 disposisi (refund + hangus)
-- dari AWAL -- bukan retrofit belakangan kayak AR (0012) -- karena kebijakan refund-tidaknya
-- DP ke supplier itu SUPPLIER yang nentuin (bukan kita), beda dari kebijakan DP ke customer
-- yang kita sendiri yang tetapkan (default non-refundable, forfeiture-only sampai 0012).
-- Ref: docs/domain/accounts-payable.md bagian "Uang Muka / DP ke Supplier".

-- ============================================================
-- ap_deposits + ap_deposit_applications + ap_deposit_refunds + ap_deposit_forfeitures
-- ============================================================

create table ap_deposits (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references suppliers(id),
  deposit_date date not null,
  source_ref text not null,
  amount numeric(14,2) not null check (amount > 0),
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index ap_deposits_supplier_id_idx on ap_deposits(supplier_id);
create index ap_deposits_journal_entry_id_idx on ap_deposits(journal_entry_id);

create trigger ap_deposits_block_edit_delete
  before update or delete on ap_deposits
  for each row execute function block_edit_delete();

create table ap_deposit_applications (
  id uuid primary key default gen_random_uuid(),
  deposit_id uuid not null references ap_deposits(id),
  bill_id uuid not null references ap_bills(id),
  amount numeric(14,2) not null check (amount > 0),
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index ap_deposit_applications_deposit_id_idx on ap_deposit_applications(deposit_id);
create index ap_deposit_applications_bill_id_idx on ap_deposit_applications(bill_id);

create trigger ap_deposit_applications_block_edit_delete
  before update or delete on ap_deposit_applications
  for each row execute function block_edit_delete();

create table ap_deposit_refunds (
  id uuid primary key default gen_random_uuid(),
  deposit_id uuid not null references ap_deposits(id),
  amount numeric(14,2) not null check (amount > 0),
  refund_date date not null,
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index ap_deposit_refunds_deposit_id_idx on ap_deposit_refunds(deposit_id);

create trigger ap_deposit_refunds_block_edit_delete
  before update or delete on ap_deposit_refunds
  for each row execute function block_edit_delete();

create table ap_deposit_forfeitures (
  id uuid primary key default gen_random_uuid(),
  deposit_id uuid not null references ap_deposits(id),
  amount numeric(14,2) not null check (amount > 0),
  forfeiture_date date not null,
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index ap_deposit_forfeitures_deposit_id_idx on ap_deposit_forfeitures(deposit_id);

create trigger ap_deposit_forfeitures_block_edit_delete
  before update or delete on ap_deposit_forfeitures
  for each row execute function block_edit_delete();

-- ============================================================
-- ap_deposit_remaining -- sumber kebenaran tunggal, mirror ar_deposit_remaining() (0012).
-- Applications exclude-reversed (bisa di-unwind cancel_ap_bill, lihat di bawah); refunds &
-- forfeitures gak pernah punya jalur reversal, SUM langsung.
-- ============================================================

create function ap_deposit_remaining(p_deposit_id uuid) returns numeric as $$
  select ad.amount
    - coalesce((
        select sum(ada.amount) from ap_deposit_applications ada
        where ada.deposit_id = p_deposit_id
          and not exists (
            select 1 from journal_entries je where je.reverses_entry_id = ada.journal_entry_id
          )
      ), 0)
    - coalesce((select sum(amount) from ap_deposit_refunds where deposit_id = p_deposit_id), 0)
    - coalesce((select sum(amount) from ap_deposit_forfeitures where deposit_id = p_deposit_id), 0)
  from ap_deposits ad
  where ad.id = p_deposit_id;
$$ language sql stable;

-- ============================================================
-- ap_bill_remaining diperluas -- reducer ke-3 (ap_deposit_applications aktif), mirror
-- ar_invoice_remaining() yang udah punya reducer ini dari awal.
-- ============================================================

create or replace function ap_bill_remaining(p_bill_id uuid) returns numeric as $$
  select ab.amount
    - coalesce((select sum(amount) from ap_payments where bill_id = p_bill_id), 0)
    - coalesce((select sum(amount) from ap_credit_notes where bill_id = p_bill_id), 0)
    - coalesce((
        select sum(ada.amount) from ap_deposit_applications ada
        where ada.bill_id = p_bill_id
          and not exists (
            select 1 from journal_entries je where je.reverses_entry_id = ada.journal_entry_id
          )
      ), 0)
  from ap_bills ab
  where ab.id = p_bill_id;
$$ language sql stable;

-- ============================================================
-- cancel_ap_bill diperluas -- auto-unwind ap_deposit_applications aktif yang nunjuk ke bill
-- ini, mirror cancel_ar_invoice. Signature gak berubah.
-- ============================================================

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
begin
  select count(*) into v_allocated_count
  from ap_payments where bill_id = p_bill_id;

  if v_allocated_count > 0 then
    raise exception 'Bill % udah punya % payment -- gak bisa dibatalkan lewat jalur ini', p_bill_id, v_allocated_count;
  end if;

  select count(*) into v_credit_note_count
  from ap_credit_notes where bill_id = p_bill_id;

  if v_credit_note_count > 0 then
    raise exception 'Bill % udah punya % retur (credit note) -- gak bisa dibatalkan lewat jalur ini', p_bill_id, v_credit_note_count;
  end if;

  select journal_entry_id into v_original_entry_id from ap_bills where id = p_bill_id;

  v_new_entry_id := reverse_journal_entry(v_original_entry_id, p_entry_date, p_source_ref);

  for v_application in
    select ada.journal_entry_id
    from ap_deposit_applications ada
    where ada.bill_id = p_bill_id
      and not exists (
        select 1 from journal_entries je where je.reverses_entry_id = ada.journal_entry_id
      )
  loop
    perform reverse_journal_entry(v_application.journal_entry_id, p_entry_date, p_source_ref);
  end loop;

  return v_new_entry_id;
end;
$$;

-- ============================================================
-- Guard trigger tiap tabel transaksional -- semuanya cek ap_deposit_remaining(), gak ada
-- aturan "1 disposisi aktif" (beda dari AR pra-0012) -- ketiganya boleh campur dari awal.
-- ============================================================

create function ap_deposit_applications_guard() returns trigger as $$
declare
  v_remaining numeric;
  v_deposit_supplier_id uuid;
  v_bill_supplier_id uuid;
  v_bill_journal_entry_id uuid;
  v_bill_cancelled boolean;
  v_bill_remaining numeric;
begin
  select ap_deposit_remaining(new.deposit_id) into v_remaining;

  if new.amount > v_remaining then
    raise exception 'Penerapan deposit % melebihi sisa deposit (sisa %, coba terapkan %)',
      new.deposit_id, v_remaining, new.amount;
  end if;

  select supplier_id into v_deposit_supplier_id from ap_deposits where id = new.deposit_id;
  select supplier_id, journal_entry_id into v_bill_supplier_id, v_bill_journal_entry_id
    from ap_bills where id = new.bill_id;

  if v_bill_supplier_id is distinct from v_deposit_supplier_id then
    raise exception 'Deposit % milik supplier lain -- gak bisa diterapkan ke bill %', new.deposit_id, new.bill_id;
  end if;

  select exists (
    select 1 from journal_entries je where je.reverses_entry_id = v_bill_journal_entry_id
  ) into v_bill_cancelled;

  if v_bill_cancelled then
    raise exception 'Bill % udah dibatalkan -- gak bisa diterapkan DP ke situ', new.bill_id;
  end if;

  select ap_bill_remaining(new.bill_id) into v_bill_remaining;

  if new.amount > v_bill_remaining then
    raise exception 'Penerapan deposit ke bill % melebihi sisa utang (sisa %, coba terapkan %)',
      new.bill_id, v_bill_remaining, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger ap_deposit_applications_guard_trigger
  before insert on ap_deposit_applications
  for each row execute function ap_deposit_applications_guard();

create function ap_deposit_refunds_guard() returns trigger as $$
declare
  v_remaining numeric;
begin
  select ap_deposit_remaining(new.deposit_id) into v_remaining;

  if new.amount > v_remaining then
    raise exception 'Refund deposit % melebihi sisa deposit (sisa %, coba refund %)',
      new.deposit_id, v_remaining, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger ap_deposit_refunds_guard_trigger
  before insert on ap_deposit_refunds
  for each row execute function ap_deposit_refunds_guard();

create function ap_deposit_forfeitures_guard() returns trigger as $$
declare
  v_remaining numeric;
begin
  select ap_deposit_remaining(new.deposit_id) into v_remaining;

  if new.amount > v_remaining then
    raise exception 'Forfeiture deposit % melebihi sisa deposit (sisa %, coba hanguskan %)',
      new.deposit_id, v_remaining, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger ap_deposit_forfeitures_guard_trigger
  before insert on ap_deposit_forfeitures
  for each row execute function ap_deposit_forfeitures_guard();

-- ============================================================
-- RPC (financial write -- atomik, reuse create_journal_entry/reverse_journal_entry)
-- ============================================================

create function create_ap_deposit(
  p_supplier_id uuid,
  p_deposit_date date,
  p_source_ref text,
  p_amount numeric,
  p_deposit_asset_account_id uuid,
  p_cash_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_entry_id uuid;
  v_deposit_id uuid;
begin
  v_entry_id := create_journal_entry(
    p_deposit_date, 'Uang muka dibayar ke supplier', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_deposit_asset_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_cash_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into ap_deposits (supplier_id, deposit_date, source_ref, amount, journal_entry_id, created_by)
  values (p_supplier_id, p_deposit_date, p_source_ref, p_amount, v_entry_id, auth.uid())
  returning id into v_deposit_id;

  return v_deposit_id;
end;
$$;

create function apply_ap_deposit(
  p_deposit_id uuid,
  p_bill_id uuid,
  p_amount numeric,
  p_entry_date date,
  p_source_ref text,
  p_payable_account_id uuid,
  p_deposit_asset_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_entry_id uuid;
  v_application_id uuid;
begin
  v_entry_id := create_journal_entry(
    p_entry_date, 'Penerapan uang muka ke bill', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_payable_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_deposit_asset_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into ap_deposit_applications (deposit_id, bill_id, amount, source_ref, journal_entry_id, created_by)
  values (p_deposit_id, p_bill_id, p_amount, p_source_ref, v_entry_id, auth.uid())
  returning id into v_application_id;

  return v_application_id;
end;
$$;

create function refund_ap_deposit(
  p_deposit_id uuid,
  p_amount numeric,
  p_refund_date date,
  p_source_ref text,
  p_cash_account_id uuid,
  p_deposit_asset_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_entry_id uuid;
  v_refund_id uuid;
begin
  v_entry_id := create_journal_entry(
    p_refund_date, 'Refund uang muka dari supplier', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_cash_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_deposit_asset_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into ap_deposit_refunds (deposit_id, amount, refund_date, source_ref, journal_entry_id, created_by)
  values (p_deposit_id, p_amount, p_refund_date, p_source_ref, v_entry_id, auth.uid())
  returning id into v_refund_id;

  return v_refund_id;
end;
$$;

create function forfeit_ap_deposit(
  p_deposit_id uuid,
  p_amount numeric,
  p_forfeiture_date date,
  p_source_ref text,
  p_loss_expense_account_id uuid,
  p_deposit_asset_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_entry_id uuid;
  v_forfeiture_id uuid;
begin
  v_entry_id := create_journal_entry(
    p_forfeiture_date, 'Uang muka hangus', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_loss_expense_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_deposit_asset_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into ap_deposit_forfeitures (deposit_id, amount, forfeiture_date, source_ref, journal_entry_id, created_by)
  values (p_deposit_id, p_amount, p_forfeiture_date, p_source_ref, v_entry_id, auth.uid())
  returning id into v_forfeiture_id;

  return v_forfeiture_id;
end;
$$;

-- ============================================================
-- RLS Policy -- pola identik semua tabel transaksional AP/AR lain.
-- ============================================================

alter table ap_deposits enable row level security;

create policy ap_deposits_select on ap_deposits
  for select using (auth.role() = 'authenticated');

create policy ap_deposits_insert on ap_deposits
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table ap_deposit_applications enable row level security;

create policy ap_deposit_applications_select on ap_deposit_applications
  for select using (auth.role() = 'authenticated');

create policy ap_deposit_applications_insert on ap_deposit_applications
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table ap_deposit_refunds enable row level security;

create policy ap_deposit_refunds_select on ap_deposit_refunds
  for select using (auth.role() = 'authenticated');

create policy ap_deposit_refunds_insert on ap_deposit_refunds
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table ap_deposit_forfeitures enable row level security;

create policy ap_deposit_forfeitures_select on ap_deposit_forfeitures
  for select using (auth.role() = 'authenticated');

create policy ap_deposit_forfeitures_insert on ap_deposit_forfeitures
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );
-- sengaja gak ada policy UPDATE/DELETE di 4 tabel ini -> RLS default deny + block_edit_delete

-- ============================================================
-- Grant
-- ============================================================

grant select, insert on ap_deposits to authenticated;
grant select, insert on ap_deposit_applications to authenticated;
grant select, insert on ap_deposit_refunds to authenticated;
grant select, insert on ap_deposit_forfeitures to authenticated;
