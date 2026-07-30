-- Accounts Payable schema (Fase 4)
-- Ref: docs/architecture/data/ap-schema.md

create table suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact text,
  payment_term_days int not null default 14 check (payment_term_days > 0),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger suppliers_set_updated_at
  before update on suppliers
  for each row execute function set_updated_at();

create table ap_bills (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references suppliers(id),
  bill_date date not null,
  due_date date not null,
  description text,
  source_ref text not null,
  amount numeric(14,2) not null check (amount > 0),
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index ap_bills_supplier_id_idx on ap_bills(supplier_id);
create index ap_bills_journal_entry_id_idx on ap_bills(journal_entry_id);

create table ap_payments (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references suppliers(id),
  payment_date date not null,
  amount numeric(14,2) not null check (amount > 0),
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index ap_payments_supplier_id_idx on ap_payments(supplier_id);

create table ap_payment_allocations (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references ap_payments(id) on delete cascade,
  bill_id uuid not null references ap_bills(id),
  amount numeric(14,2) not null check (amount > 0),
  created_at timestamptz not null default now()
);

create index ap_payment_allocations_payment_id_idx on ap_payment_allocations(payment_id);
create index ap_payment_allocations_bill_id_idx on ap_payment_allocations(bill_id);

-- Trigger: total alokasi gak boleh ngelebihin amount bill atau amount payment.

create function ap_payment_allocations_no_over_allocation() returns trigger as $$
declare
  v_bill_amount numeric;
  v_bill_allocated numeric;
  v_payment_amount numeric;
  v_payment_allocated numeric;
begin
  select amount into v_bill_amount from ap_bills where id = new.bill_id;
  select coalesce(sum(amount), 0) into v_bill_allocated
    from ap_payment_allocations where bill_id = new.bill_id;

  if v_bill_allocated + new.amount > v_bill_amount then
    raise exception 'Alokasi ke bill % melebihi sisa utang (sisa %, coba alokasi %)',
      new.bill_id, v_bill_amount - v_bill_allocated, new.amount;
  end if;

  select amount into v_payment_amount from ap_payments where id = new.payment_id;
  select coalesce(sum(amount), 0) into v_payment_allocated
    from ap_payment_allocations where payment_id = new.payment_id;

  if v_payment_allocated + new.amount > v_payment_amount then
    raise exception 'Alokasi dari payment % melebihi sisa yang belum teralokasi (sisa %, coba alokasi %)',
      new.payment_id, v_payment_amount - v_payment_allocated, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger ap_payment_allocations_no_over_allocation_trigger
  before insert on ap_payment_allocations
  for each row execute function ap_payment_allocations_no_over_allocation();

-- Immutability: reuse block_edit_delete() dari journal-entry-schema.md (0004).

create trigger ap_bills_block_edit_delete
  before update or delete on ap_bills
  for each row execute function block_edit_delete();

create trigger ap_payments_block_edit_delete
  before update or delete on ap_payments
  for each row execute function block_edit_delete();

create trigger ap_payment_allocations_block_edit_delete
  before update or delete on ap_payment_allocations
  for each row execute function block_edit_delete();

-- RPC atomik: manggil create_journal_entry/reverse_journal_entry yang udah ada (0004).

create function create_ap_bill(
  p_supplier_id uuid,
  p_bill_date date,
  p_description text,
  p_source_ref text,
  p_amount numeric,
  p_debit_account_id uuid,
  p_payable_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_term_days int;
  v_due_date date;
  v_entry_id uuid;
  v_bill_id uuid;
begin
  select payment_term_days into v_term_days from suppliers where id = p_supplier_id;
  v_due_date := p_bill_date + v_term_days;

  v_entry_id := create_journal_entry(
    p_bill_date, p_description, p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_debit_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_payable_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into ap_bills (supplier_id, bill_date, due_date, description, source_ref, amount, journal_entry_id, created_by)
  values (p_supplier_id, p_bill_date, v_due_date, p_description, p_source_ref, p_amount, v_entry_id, auth.uid())
  returning id into v_bill_id;

  return v_bill_id;
end;
$$;

create function record_ap_payment(
  p_supplier_id uuid,
  p_payment_date date,
  p_amount numeric,
  p_source_ref text,
  p_payable_account_id uuid,
  p_cash_account_id uuid,
  p_allocations jsonb -- array of {"bill_id": uuid, "amount": numeric}
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_entry_id uuid;
  v_payment_id uuid;
  v_alloc jsonb;
begin
  v_entry_id := create_journal_entry(
    p_payment_date, 'Pelunasan utang', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_payable_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_cash_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into ap_payments (supplier_id, payment_date, amount, source_ref, journal_entry_id, created_by)
  values (p_supplier_id, p_payment_date, p_amount, p_source_ref, v_entry_id, auth.uid())
  returning id into v_payment_id;

  for v_alloc in select * from jsonb_array_elements(p_allocations)
  loop
    insert into ap_payment_allocations (payment_id, bill_id, amount)
    values (v_payment_id, (v_alloc->>'bill_id')::uuid, (v_alloc->>'amount')::numeric);
  end loop;

  return v_payment_id;
end;
$$;

create function cancel_ap_bill(
  p_bill_id uuid,
  p_entry_date date,
  p_source_ref text
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_allocated_count int;
  v_original_entry_id uuid;
  v_new_entry_id uuid;
begin
  select count(*) into v_allocated_count
  from ap_payment_allocations where bill_id = p_bill_id;

  if v_allocated_count > 0 then
    raise exception 'Bill % udah punya % alokasi payment — gak bisa dibatalkan lewat jalur ini', p_bill_id, v_allocated_count;
  end if;

  select journal_entry_id into v_original_entry_id from ap_bills where id = p_bill_id;

  v_new_entry_id := reverse_journal_entry(v_original_entry_id, p_entry_date, p_source_ref);

  return v_new_entry_id;
end;
$$;

-- Grant: "Automatically expose new tables" dimatikan di project settings,
-- jadi tabel baru butuh grant eksplisit sebelum RLS bisa kepakai PostgREST.

grant select, insert, update on suppliers to authenticated;
grant select, insert on ap_bills to authenticated;
grant select, insert on ap_payments to authenticated;
grant select, insert on ap_payment_allocations to authenticated;

-- RLS

alter table suppliers enable row level security;

create policy suppliers_select on suppliers
  for select using (auth.role() = 'authenticated');

create policy suppliers_insert on suppliers
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

create policy suppliers_update on suppliers
  for update using (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );
-- sengaja gak ada policy DELETE -> arsip lewat archived_at, hard delete tertutup total

alter table ap_bills enable row level security;

create policy ap_bills_select on ap_bills
  for select using (auth.role() = 'authenticated');

create policy ap_bills_insert on ap_bills
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table ap_payments enable row level security;

create policy ap_payments_select on ap_payments
  for select using (auth.role() = 'authenticated');

create policy ap_payments_insert on ap_payments
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table ap_payment_allocations enable row level security;

create policy ap_payment_allocations_select on ap_payment_allocations
  for select using (auth.role() = 'authenticated');

create policy ap_payment_allocations_insert on ap_payment_allocations
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );
-- sengaja gak ada policy UPDATE/DELETE di 3 tabel AP transaksional -> RLS default deny
