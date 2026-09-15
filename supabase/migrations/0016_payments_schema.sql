-- Payments (AR Payment + AP Payment, digabung). Ref: memory/architecture/data/payments-schema.md.

create table payments (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('INBOUND', 'OUTBOUND')),
  counterparty_id uuid not null references counterparties(id),
  transaction_id uuid not null references transactions(id),
  payment_date date not null,
  amount numeric(14,2) not null check (amount > 0),
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index payments_counterparty_id_idx on payments(counterparty_id);
create index payments_transaction_id_idx on payments(transaction_id);

create trigger payments_block_edit_delete
  before update or delete on payments
  for each row execute function block_edit_delete();

create trigger payments_counterparty_role_guard_inbound
  before insert on payments
  for each row when (new.type = 'INBOUND')
  execute function counterparty_role_guard('counterparty_id', 'supplier');

create trigger payments_counterparty_role_guard_outbound
  before insert on payments
  for each row when (new.type = 'OUTBOUND')
  execute function counterparty_role_guard('counterparty_id', 'customer');

create function payments_type_matches_transaction() returns trigger as $$
declare
  v_transaction_type text;
begin
  select type into v_transaction_type from transactions where id = new.transaction_id;
  if v_transaction_type is distinct from new.type then
    raise exception 'payments.type (%) gak cocok sama transactions.type (%) buat transaction_id %', new.type, v_transaction_type, new.transaction_id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger payments_type_matches_transaction_trigger
  before insert on payments
  for each row execute function payments_type_matches_transaction();

create function payments_sync_transaction_status() returns trigger as $$
begin
  perform recompute_transaction_status(new.transaction_id);
  return new;
end;
$$ language plpgsql;

create trigger payments_sync_transaction_status_trigger
  after insert on payments
  for each row execute function payments_sync_transaction_status();

-- record_payment -- gantiin record_ar_payment+record_ap_payment. Guard overpay pakai
-- ar_invoice_remaining/ap_bill_remaining (0015_transactions_schema.sql).
create function record_payment(
  p_type text,
  p_counterparty_id uuid,
  p_payment_date date,
  p_amount numeric,
  p_source_ref text,
  p_cash_account_id uuid,
  p_control_account_id uuid,
  p_transaction_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_remaining numeric;
  v_entry_id uuid;
  v_payment_id uuid;
begin
  if p_type not in ('INBOUND', 'OUTBOUND') then
    raise exception 'p_type harus INBOUND atau OUTBOUND, dapat %', p_type;
  end if;

  if p_type = 'OUTBOUND' then
    select ar_invoice_remaining(p_transaction_id) into v_remaining;
  else
    select ap_bill_remaining(p_transaction_id) into v_remaining;
  end if;

  if p_amount > v_remaining then
    raise exception 'Pembayaran % melebihi sisa outstanding (sisa %)', p_amount, v_remaining;
  end if;

  if p_type = 'OUTBOUND' then
    v_entry_id := create_journal_entry(
      p_payment_date, 'Pembayaran', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_cash_account_id, 'debit', p_amount, 'credit', 0),
        jsonb_build_object('account_id', p_control_account_id, 'debit', 0, 'credit', p_amount)
      )
    );
  else
    v_entry_id := create_journal_entry(
      p_payment_date, 'Pembayaran', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_control_account_id, 'debit', p_amount, 'credit', 0),
        jsonb_build_object('account_id', p_cash_account_id, 'debit', 0, 'credit', p_amount)
      )
    );
  end if;

  insert into payments (type, counterparty_id, transaction_id, payment_date, amount, source_ref, journal_entry_id, created_by)
  values (p_type, p_counterparty_id, p_transaction_id, p_payment_date, p_amount, p_source_ref, v_entry_id, auth.uid())
  returning id into v_payment_id;

  return v_payment_id;
end;
$$;

alter table payments enable row level security;

create policy payments_select on payments
  for select using (auth.role() = 'authenticated');

create policy payments_insert on payments
  for insert with check (
    exists (select 1 from app_user_roles ur
            where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );

grant select, insert on payments to authenticated;
