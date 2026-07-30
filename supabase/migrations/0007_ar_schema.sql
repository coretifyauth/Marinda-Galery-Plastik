-- Accounts Receivable schema (Fase 3)
-- Ref: docs/architecture/data/ar-schema.md

create table customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact text,
  payment_term_days int not null default 7 check (payment_term_days > 0),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger customers_set_updated_at
  before update on customers
  for each row execute function set_updated_at();

create table ar_invoices (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  invoice_date date not null,
  due_date date not null,
  description text,
  source_ref text not null,
  amount numeric(14,2) not null check (amount > 0),
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index ar_invoices_customer_id_idx on ar_invoices(customer_id);
create index ar_invoices_journal_entry_id_idx on ar_invoices(journal_entry_id);

create table ar_payments (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  payment_date date not null,
  amount numeric(14,2) not null check (amount > 0),
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index ar_payments_customer_id_idx on ar_payments(customer_id);

create table ar_payment_allocations (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references ar_payments(id) on delete cascade,
  invoice_id uuid not null references ar_invoices(id),
  amount numeric(14,2) not null check (amount > 0),
  created_at timestamptz not null default now()
);

create index ar_payment_allocations_payment_id_idx on ar_payment_allocations(payment_id);
create index ar_payment_allocations_invoice_id_idx on ar_payment_allocations(invoice_id);

-- Trigger: total alokasi gak boleh ngelebihin amount invoice atau amount payment.
-- Gak perlu deferred (beda dari balance-check Journal Entry) — tiap baris alokasi
-- adalah fakta independen, langsung divalidasi begitu masuk.

create function ar_payment_allocations_no_over_allocation() returns trigger as $$
declare
  v_invoice_amount numeric;
  v_invoice_allocated numeric;
  v_payment_amount numeric;
  v_payment_allocated numeric;
begin
  select amount into v_invoice_amount from ar_invoices where id = new.invoice_id;
  select coalesce(sum(amount), 0) into v_invoice_allocated
    from ar_payment_allocations where invoice_id = new.invoice_id;

  if v_invoice_allocated + new.amount > v_invoice_amount then
    raise exception 'Alokasi ke invoice % melebihi sisa piutang (sisa %, coba alokasi %)',
      new.invoice_id, v_invoice_amount - v_invoice_allocated, new.amount;
  end if;

  select amount into v_payment_amount from ar_payments where id = new.payment_id;
  select coalesce(sum(amount), 0) into v_payment_allocated
    from ar_payment_allocations where payment_id = new.payment_id;

  if v_payment_allocated + new.amount > v_payment_amount then
    raise exception 'Alokasi dari payment % melebihi sisa yang belum teralokasi (sisa %, coba alokasi %)',
      new.payment_id, v_payment_amount - v_payment_allocated, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger ar_payment_allocations_no_over_allocation_trigger
  before insert on ar_payment_allocations
  for each row execute function ar_payment_allocations_no_over_allocation();

-- Immutability: reuse block_edit_delete() dari journal-entry-schema.md (0004),
-- gak bikin fungsi baru.

create trigger ar_invoices_block_edit_delete
  before update or delete on ar_invoices
  for each row execute function block_edit_delete();

create trigger ar_payments_block_edit_delete
  before update or delete on ar_payments
  for each row execute function block_edit_delete();

create trigger ar_payment_allocations_block_edit_delete
  before update or delete on ar_payment_allocations
  for each row execute function block_edit_delete();

-- RPC atomik: manggil create_journal_entry yang udah ada (0004), gak insert GL manual.

create function create_ar_invoice(
  p_customer_id uuid,
  p_invoice_date date,
  p_description text,
  p_source_ref text,
  p_amount numeric,
  p_receivable_account_id uuid,
  p_revenue_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_term_days int;
  v_due_date date;
  v_entry_id uuid;
  v_invoice_id uuid;
begin
  select payment_term_days into v_term_days from customers where id = p_customer_id;
  v_due_date := p_invoice_date + v_term_days;

  v_entry_id := create_journal_entry(
    p_invoice_date, p_description, p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_receivable_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_revenue_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into ar_invoices (customer_id, invoice_date, due_date, description, source_ref, amount, journal_entry_id, created_by)
  values (p_customer_id, p_invoice_date, v_due_date, p_description, p_source_ref, p_amount, v_entry_id, auth.uid())
  returning id into v_invoice_id;

  return v_invoice_id;
end;
$$;

create function record_ar_payment(
  p_customer_id uuid,
  p_payment_date date,
  p_amount numeric,
  p_source_ref text,
  p_cash_account_id uuid,
  p_receivable_account_id uuid,
  p_allocations jsonb -- array of {"invoice_id": uuid, "amount": numeric}
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
    p_payment_date, 'Pelunasan piutang', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_cash_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_receivable_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into ar_payments (customer_id, payment_date, amount, source_ref, journal_entry_id, created_by)
  values (p_customer_id, p_payment_date, p_amount, p_source_ref, v_entry_id, auth.uid())
  returning id into v_payment_id;

  for v_alloc in select * from jsonb_array_elements(p_allocations)
  loop
    insert into ar_payment_allocations (payment_id, invoice_id, amount)
    values (v_payment_id, (v_alloc->>'invoice_id')::uuid, (v_alloc->>'amount')::numeric);
  end loop;

  return v_payment_id;
end;
$$;

-- Grant: "Automatically expose new tables" dimatikan di project settings,
-- jadi tabel baru butuh grant eksplisit sebelum RLS bisa kepakai PostgREST.

grant select, insert, update on customers to authenticated;
grant select, insert on ar_invoices to authenticated;
grant select, insert on ar_payments to authenticated;
grant select, insert on ar_payment_allocations to authenticated;

-- RLS

alter table customers enable row level security;

create policy customers_select on customers
  for select using (auth.role() = 'authenticated');

create policy customers_insert on customers
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

create policy customers_update on customers
  for update using (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );
-- sengaja gak ada policy DELETE -> arsip lewat archived_at, hard delete tertutup total

alter table ar_invoices enable row level security;

create policy ar_invoices_select on ar_invoices
  for select using (auth.role() = 'authenticated');

create policy ar_invoices_insert on ar_invoices
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table ar_payments enable row level security;

create policy ar_payments_select on ar_payments
  for select using (auth.role() = 'authenticated');

create policy ar_payments_insert on ar_payments
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table ar_payment_allocations enable row level security;

create policy ar_payment_allocations_select on ar_payment_allocations
  for select using (auth.role() = 'authenticated');

create policy ar_payment_allocations_insert on ar_payment_allocations
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );
-- sengaja gak ada policy UPDATE/DELETE di 3 tabel AR transaksional -> RLS default deny
