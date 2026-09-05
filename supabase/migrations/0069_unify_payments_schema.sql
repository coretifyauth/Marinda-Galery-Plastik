-- Gabung ar_payments + ap_payments jadi 1 tabel generic `payments` (type INBOUND/OUTBOUND),
-- mirror pola transactions (0063-0065). Fase 1 dari unifikasi tabel anak AR/AP (payments,
-- credit_notes, deposits, return_credits) -- lihat memory/scope-debt untuk konteks lengkap.

-- 1. Tabel baru
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

-- 2. Backfill, ID asli dipertahankan
insert into payments (id, type, counterparty_id, transaction_id, payment_date, amount, source_ref, journal_entry_id, created_by, created_at)
select id, 'INBOUND', customer_id, invoice_id, payment_date, amount, source_ref, journal_entry_id, created_by, created_at
from ar_payments
union all
select id, 'OUTBOUND', supplier_id, bill_id, payment_date, amount, source_ref, journal_entry_id, created_by, created_at
from ap_payments;

-- 3. Immutability
create trigger payments_block_edit_delete
  before update or delete on payments
  for each row execute function block_edit_delete();

-- 4. Type-safety counterparty (reuse counterparty_role_guard, pola transactions_counterparty_role_guard_*)
create trigger payments_counterparty_role_guard_inbound
  before insert on payments
  for each row when (new.type = 'INBOUND')
  execute function counterparty_role_guard('counterparty_id', 'customer');

create trigger payments_counterparty_role_guard_outbound
  before insert on payments
  for each row when (new.type = 'OUTBOUND')
  execute function counterparty_role_guard('counterparty_id', 'supplier');

-- 5. Guard konsistensi: payments.type wajib sama dengan transactions.type buat transaction_id-nya
-- (kolom type di sini redundan/denormalisasi buat kebutuhan guard #4 + display, harus dijaga konsisten)
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

-- 6. Sync status transaksi (gantiin ar_payments_sync_invoice_status + ap_payments_sync_bill_status)
create function payments_sync_transaction_status() returns trigger as $$
begin
  perform recompute_transaction_status(new.transaction_id);
  return new;
end;
$$ language plpgsql;

create trigger payments_sync_transaction_status_trigger
  after insert on payments
  for each row execute function payments_sync_transaction_status();

-- 7. RLS & Grant (pola identik ar_payments/ap_payments lama)
alter table payments enable row level security;

create policy payments_select on payments
  for select using (auth.role() = 'authenticated');

create policy payments_insert on payments
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );
-- sengaja gak ada policy UPDATE/DELETE -> RLS default deny

grant select, insert on payments to authenticated;

-- 8. RPC generic, gantiin record_ar_payment + record_ap_payment
create function record_payment(
  p_type text,
  p_counterparty_id uuid,
  p_payment_date date,
  p_amount numeric,
  p_source_ref text,
  p_cash_account_id uuid,
  p_control_account_id uuid, -- INBOUND: Piutang Usaha, OUTBOUND: Utang Usaha
  p_transaction_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_remaining numeric;
  v_entry_id uuid;
  v_payment_id uuid;
  v_ref text;
begin
  if p_type not in ('INBOUND', 'OUTBOUND') then
    raise exception 'p_type harus INBOUND atau OUTBOUND, dapat %', p_type;
  end if;

  if p_type = 'INBOUND' then
    select ar_invoice_remaining(p_transaction_id) into v_remaining;
  else
    select ap_bill_remaining(p_transaction_id) into v_remaining;
  end if;

  if p_amount > v_remaining then
    select source_ref into v_ref from transactions where id = p_transaction_id;
    raise exception 'Payment % melebihi sisa % % (sisa %, coba bayar %) -- gak boleh overpay',
      p_source_ref,
      case when p_type = 'INBOUND' then 'piutang invoice' else 'utang bill' end,
      v_ref, v_remaining, p_amount;
  end if;

  if p_type = 'INBOUND' then
    v_entry_id := create_journal_entry(
      p_payment_date, 'Pelunasan piutang', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_cash_account_id, 'debit', p_amount, 'credit', 0),
        jsonb_build_object('account_id', p_control_account_id, 'debit', 0, 'credit', p_amount)
      )
    );
  else
    v_entry_id := create_journal_entry(
      p_payment_date, 'Pelunasan utang', p_source_ref,
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

drop function if exists record_ar_payment(uuid, date, numeric, text, uuid, uuid, uuid);
drop function if exists record_ap_payment(uuid, date, numeric, text, uuid, uuid, uuid);

-- 9. Reducer ar_invoice_remaining/ap_bill_remaining -> target payments
create or replace function ar_invoice_remaining(p_invoice_id uuid) returns numeric as $$
  select ai.amount
    - coalesce((
        select sum(amount) from payments where transaction_id = p_invoice_id and type = 'INBOUND'
      ), 0)
    - coalesce((
        select sum(amount) from ar_credit_notes where invoice_id = p_invoice_id
      ), 0)
    - coalesce((
        select sum(ada.amount) from ar_deposit_applications ada
        where ada.invoice_id = p_invoice_id
          and not exists (
            select 1 from journal_entries je where je.reverses_entry_id = ada.journal_entry_id
          )
      ), 0)
    + coalesce((
        select sum(arc.amount) from ar_return_credits arc
        join ar_credit_notes acn on acn.id = arc.credit_note_id
        where acn.invoice_id = p_invoice_id
      ), 0)
    + coalesce((
        select sum(wr.discount_reversed_amount - wr.return_credit_settled_amount)
        from warranty_replacements wr
        join ar_credit_notes cn on cn.id = wr.credit_note_id
        where cn.invoice_id = p_invoice_id
      ), 0)
  from transactions ai
  where ai.id = p_invoice_id;
$$ language sql stable;

create or replace function ap_bill_remaining(p_bill_id uuid) returns numeric as $$
  select ab.amount
    - coalesce((select sum(amount) from payments where transaction_id = p_bill_id and type = 'OUTBOUND'), 0)
    - coalesce((select sum(amount) from ap_credit_notes where bill_id = p_bill_id), 0)
    - coalesce((
        select sum(ada.amount) from ap_deposit_applications ada
        where ada.bill_id = p_bill_id
          and not exists (
            select 1 from journal_entries je where je.reverses_entry_id = ada.journal_entry_id
          )
      ), 0)
    + coalesce((
        select sum(arc.amount) from ap_return_credits arc
        join ap_credit_notes acn on acn.id = arc.credit_note_id
        where acn.bill_id = p_bill_id
      ), 0)
  from transactions ab
  where ab.id = p_bill_id;
$$ language sql stable;

-- 10. cancel_ar_invoice / cancel_ap_bill -> guard payment-count target payments
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
    select ada.journal_entry_id
    from ar_deposit_applications ada
    where ada.invoice_id = p_invoice_id
      and not exists (
        select 1 from journal_entries je where je.reverses_entry_id = ada.journal_entry_id
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
  from ap_credit_notes where bill_id = p_bill_id;

  if v_credit_note_count > 0 then
    select source_ref into v_bill_ref from transactions where id = p_bill_id;
    raise exception 'Bill % udah punya % retur (credit note) -- gak bisa dibatalkan lewat jalur ini', v_bill_ref, v_credit_note_count;
  end if;

  select journal_entry_id into v_original_entry_id from transactions where id = p_bill_id;

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

-- 11. recompute_transaction_status: reducer allocated (payment) -> target payments
-- (WAJIB sebelum drop tabel ar_payments/ap_payments -- fungsi ini plpgsql, gak bikin
-- pg_depend ke tabel yang di-query di dalam body-nya, jadi drop table BAKAL LOLOS diam-diam
-- kalau ini kelewat, lalu meledak runtime di SEMUA trigger AFTER INSERT yang manggil fungsi
-- ini -- ar_credit_notes, ar_deposit_applications, goods_issues, dst, bukan cuma payments)
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
      from ar_credit_notes where invoice_id = p_transaction_id;

    select coalesce(sum(amount), 0) into v_allocated
      from payments where transaction_id = p_transaction_id and type = 'INBOUND';

    select coalesce(sum(amount), 0) into v_deposit_applied
      from ar_deposit_applications where invoice_id = p_transaction_id;

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
    select coalesce(sum(ada.amount), 0) into v_deposit_applied
      from ap_deposit_applications ada
      where ada.bill_id = p_transaction_id
        and not exists (select 1 from journal_entries je where je.reverses_entry_id = ada.journal_entry_id);

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

-- 12. Drop tabel lama (cascade trigger/index/RLS/grant) + fungsi trigger yang jadi orphan
drop table if exists ar_payments;
drop table if exists ap_payments;
drop function if exists ar_payments_sync_invoice_status();
drop function if exists ap_payments_sync_bill_status();
