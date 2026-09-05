-- Gabung ar_credit_notes + ap_credit_notes jadi 1 tabel generic `credit_notes`
-- (type INBOUND/OUTBOUND), mirror pola payments (0069). Fase 2 dari unifikasi tabel anak
-- AR/AP. RPC create_ar_credit_note/create_ap_credit_note TETAP 2 fungsi terpisah --
-- logic-nya beneran beda bentuk (AR: kontra-revenue + reversal HPP opsional dengan
-- klasifikasi RESALABLE/DAMAGED yang restock; AP: 1 jurnal langsung ke Persediaan/Beban,
-- consume_weighted_average yang MENGURANGI stok bukan restock, gak ada konsep akun
-- kontra sama sekali) -- maksa gabung jadi 1 RPC cuma nambah percabangan tanpa
-- ngurangin kompleksitas riil, cuma tabel penyimpanannya yang digabung.

-- 1. Tabel baru
create table credit_notes (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('INBOUND', 'OUTBOUND')),
  transaction_id uuid not null references transactions(id),
  credit_note_date date not null,
  source_ref text not null,
  amount numeric(14,2) not null check (amount > 0),
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index credit_notes_transaction_id_idx on credit_notes(transaction_id);

-- 2. Backfill, ID asli dipertahankan
insert into credit_notes (id, type, transaction_id, credit_note_date, source_ref, amount, journal_entry_id, created_by, created_at)
select id, 'INBOUND', invoice_id, credit_note_date, source_ref, amount, journal_entry_id, created_by, created_at
from ar_credit_notes
union all
select id, 'OUTBOUND', bill_id, credit_note_date, source_ref, amount, journal_entry_id, created_by, created_at
from ap_credit_notes;

-- 3. Immutability
create trigger credit_notes_block_edit_delete
  before update or delete on credit_notes
  for each row execute function block_edit_delete();

-- 4. Guard konsistensi type vs transactions.type (pola persis payments_type_matches_transaction)
create function credit_notes_type_matches_transaction() returns trigger as $$
declare
  v_transaction_type text;
begin
  select type into v_transaction_type from transactions where id = new.transaction_id;
  if v_transaction_type is distinct from new.type then
    raise exception 'credit_notes.type (%) gak cocok sama transactions.type (%) buat transaction_id %', new.type, v_transaction_type, new.transaction_id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger credit_notes_type_matches_transaction_trigger
  before insert on credit_notes
  for each row execute function credit_notes_type_matches_transaction();

-- 5. No-over-return -- gantiin ar_credit_notes_no_over_return + ap_credit_notes_no_over_return,
-- logic-nya literally identik (cuma beda nama kolom invoice_id/bill_id, sekarang sama-sama transaction_id)
create function credit_notes_no_over_return() returns trigger as $$
declare
  v_transaction_amount numeric;
  v_already_returned numeric;
  v_transaction_ref text;
begin
  select amount into v_transaction_amount from transactions where id = new.transaction_id;
  select coalesce(sum(amount), 0) into v_already_returned
    from credit_notes where transaction_id = new.transaction_id;

  if v_already_returned + new.amount > v_transaction_amount then
    select source_ref into v_transaction_ref from transactions where id = new.transaction_id;
    raise exception 'Retur % melebihi nilai transaksi (nilai %, sudah diretur %, coba retur %)',
      v_transaction_ref, v_transaction_amount, v_already_returned, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger credit_notes_no_over_return_trigger
  before insert on credit_notes
  for each row execute function credit_notes_no_over_return();

-- 6. Sync status transaksi -- gantiin ar_credit_notes_sync_invoice_status + ap_credit_notes_sync_bill_status
create function credit_notes_sync_transaction_status() returns trigger as $$
begin
  perform recompute_transaction_status(new.transaction_id);
  return new;
end;
$$ language plpgsql;

create trigger credit_notes_sync_transaction_status_trigger
  after insert on credit_notes
  for each row execute function credit_notes_sync_transaction_status();

-- 7. RLS & Grant (pola identik ar_credit_notes/ap_credit_notes lama)
alter table credit_notes enable row level security;

create policy credit_notes_select on credit_notes
  for select using (auth.role() = 'authenticated');

create policy credit_notes_insert on credit_notes
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );
-- sengaja gak ada policy UPDATE/DELETE -> RLS default deny

grant select, insert on credit_notes to authenticated;

-- 8. Repoint FK 5 tabel turunan yang nunjuk ar_credit_notes(id)/ap_credit_notes(id)
-- (kolom credit_note_id gak berubah nama, cuma target FK-nya)
create function _repoint_fk(p_table regclass, p_column name, p_new_target regclass,
                             p_new_target_column name default 'id')
returns void
language plpgsql
security invoker
as $$
declare
  v_old_conname text;
  v_new_conname text;
begin
  select conname into v_old_conname
    from pg_constraint
    where conrelid = p_table and contype = 'f'
      and conkey = (
        select array_agg(attnum) from pg_attribute
        where attrelid = p_table and attname = p_column
      );

  if v_old_conname is not null then
    execute format('alter table %s drop constraint %I', p_table, v_old_conname);
  end if;

  v_new_conname := p_table::text || '_' || p_column || '_fkey';
  execute format('alter table %s add constraint %I foreign key (%I) references %s (%I)',
    p_table, v_new_conname, p_column, p_new_target, p_new_target_column);
end;
$$;

select _repoint_fk('ar_return_credits', 'credit_note_id', 'credit_notes');
select _repoint_fk('inventory_returns', 'credit_note_id', 'credit_notes');
select _repoint_fk('warranty_replacements', 'credit_note_id', 'credit_notes');
select _repoint_fk('ap_return_credits', 'credit_note_id', 'credit_notes');
select _repoint_fk('purchase_return_lines', 'credit_note_id', 'credit_notes');

drop function _repoint_fk(regclass, name, regclass, name);

-- 9. create_ar_credit_note: insert target ar_credit_notes -> credit_notes(type='INBOUND')
create or replace function create_ar_credit_note(
  p_invoice_id uuid,
  p_credit_note_date date,
  p_source_ref text,
  p_amount numeric,
  p_contra_revenue_account_id uuid,
  p_receivable_account_id uuid,
  p_lines jsonb default null,
  p_hpp_account_id uuid default null,
  p_finished_good_account_id uuid default null,
  p_return_credit_liability_account_id uuid default null,
  p_loss_expense_account_id uuid default null
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_entry_id uuid;
  v_credit_note_id uuid;
  v_goods_issue_id uuid;
  v_line jsonb;
  v_item_id uuid;
  v_qty_returned numeric;
  v_qty_issued numeric;
  v_total_cost numeric;
  v_unit_cost numeric;
  v_line_cost numeric;
  v_condition text;
  v_total_cost_returned numeric := 0;
  v_total_cost_resalable numeric := 0;
  v_total_cost_damaged numeric := 0;
  v_qty_before numeric;
  v_avg_before numeric;
  v_hpp_entry_id uuid;
  v_hpp_journal_lines jsonb := '[]'::jsonb;
  v_return_id uuid;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_costs numeric[] := '{}';
  v_line_conditions text[] := '{}';
  i int;
  v_remaining_before numeric;
  v_excess numeric;
  v_customer_id uuid;
  v_return_credit_entry_id uuid;
  v_line_id uuid;
begin
  select ar_invoice_remaining(p_invoice_id) into v_remaining_before;

  v_entry_id := create_journal_entry(
    p_credit_note_date, 'Retur barang', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_contra_revenue_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_receivable_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into credit_notes (type, transaction_id, credit_note_date, source_ref, amount, journal_entry_id, created_by)
  values ('INBOUND', p_invoice_id, p_credit_note_date, p_source_ref, p_amount, v_entry_id, auth.uid())
  returning id into v_credit_note_id;

  v_excess := greatest(0, p_amount - greatest(0, v_remaining_before));

  if v_excess > 0 then
    if p_return_credit_liability_account_id is null then
      raise exception 'Retur % bikin outstanding invoice jadi minus (excess %) — wajib isi p_return_credit_liability_account_id',
        p_source_ref, v_excess;
    end if;

    select counterparty_id into v_customer_id from transactions where id = p_invoice_id;

    v_return_credit_entry_id := create_journal_entry(
      p_credit_note_date, 'Saldo kredit dari retur', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_receivable_account_id, 'debit', v_excess, 'credit', 0),
        jsonb_build_object('account_id', p_return_credit_liability_account_id, 'debit', 0, 'credit', v_excess)
      )
    );

    insert into ar_return_credits (customer_id, credit_note_id, amount, journal_entry_id, created_by)
    values (v_customer_id, v_credit_note_id, v_excess, v_return_credit_entry_id, auth.uid());
  end if;

  if p_lines is not null and jsonb_array_length(p_lines) > 0 then
    select id into v_goods_issue_id from goods_issues where invoice_id = p_invoice_id;

    if v_goods_issue_id is null then
      raise exception 'Invoice % gak punya goods_issue — gak bisa retur stok/HPP', p_invoice_id;
    end if;

    for v_line in select * from jsonb_array_elements(p_lines)
    loop
      v_item_id := (v_line->>'item_id')::uuid;
      v_qty_returned := (v_line->>'qty_returned')::numeric;
      v_condition := coalesce(v_line->>'condition', 'RESALABLE');

      if v_condition not in ('RESALABLE', 'DAMAGED') then
        raise exception 'condition % gak valid -- harus RESALABLE atau DAMAGED', v_condition;
      end if;

      select qty_issued, total_cost into v_qty_issued, v_total_cost
        from goods_issue_lines
        where goods_issue_id = v_goods_issue_id and item_id = v_item_id;

      if not found then
        raise exception 'Item % gak ada di goods_issue %, gak bisa diretur', v_item_id, v_goods_issue_id;
      end if;

      v_unit_cost := v_total_cost / v_qty_issued;
      v_line_cost := v_qty_returned * v_unit_cost;
      v_total_cost_returned := v_total_cost_returned + v_line_cost;

      if v_condition = 'RESALABLE' then
        v_total_cost_resalable := v_total_cost_resalable + v_line_cost;

        select qty_on_hand, avg_cost into v_qty_before, v_avg_before
          from inventory_balances where item_id = v_item_id;

        update inventory_balances
          set qty_on_hand = v_qty_before + v_qty_returned,
              avg_cost = (v_qty_before * v_avg_before + v_qty_returned * v_unit_cost) / (v_qty_before + v_qty_returned),
              updated_at = now()
          where item_id = v_item_id;
      else
        v_total_cost_damaged := v_total_cost_damaged + v_line_cost;
      end if;

      v_line_items := array_append(v_line_items, v_item_id);
      v_line_qtys := array_append(v_line_qtys, v_qty_returned);
      v_line_costs := array_append(v_line_costs, v_line_cost);
      v_line_conditions := array_append(v_line_conditions, v_condition);
    end loop;

    if v_total_cost_damaged > 0 and p_loss_expense_account_id is null then
      raise exception 'Ada baris retur DAMAGED (total cost %) -- wajib isi p_loss_expense_account_id',
        v_total_cost_damaged;
    end if;

    if v_total_cost_resalable > 0 then
      v_hpp_journal_lines := v_hpp_journal_lines ||
        jsonb_build_object('account_id', p_finished_good_account_id, 'debit', v_total_cost_resalable, 'credit', 0);
    end if;

    if v_total_cost_damaged > 0 then
      v_hpp_journal_lines := v_hpp_journal_lines ||
        jsonb_build_object('account_id', p_loss_expense_account_id, 'debit', v_total_cost_damaged, 'credit', 0);
    end if;

    v_hpp_journal_lines := v_hpp_journal_lines ||
      jsonb_build_object('account_id', p_hpp_account_id, 'debit', 0, 'credit', v_total_cost_returned);

    v_hpp_entry_id := create_journal_entry(
      p_credit_note_date, 'Reversal HPP retur', p_source_ref, v_hpp_journal_lines
    );

    insert into inventory_returns (credit_note_id, goods_issue_id, journal_entry_id, return_date, source_ref, created_by)
    values (v_credit_note_id, v_goods_issue_id, v_hpp_entry_id, p_credit_note_date, p_source_ref, auth.uid())
    returning id into v_return_id;

    for i in 1..array_length(v_line_items, 1) loop
      insert into inventory_return_lines (inventory_return_id, item_id, qty_returned, total_cost, condition)
      values (v_return_id, v_line_items[i], v_line_qtys[i], v_line_costs[i], v_line_conditions[i])
      returning id into v_line_id;

      if v_line_conditions[i] = 'RESALABLE' then
        insert into inventory_movements (item_id, movement_date, qty, inventory_return_line_id)
        values (v_line_items[i], p_credit_note_date, v_line_qtys[i], v_line_id);
      end if;
    end loop;
  end if;

  return v_credit_note_id;
end;
$$;

-- 10. create_ap_credit_note: insert target ap_credit_notes -> credit_notes(type='OUTBOUND')
create or replace function create_ap_credit_note(
  p_bill_id uuid,
  p_credit_note_date date,
  p_source_ref text,
  p_amount numeric,
  p_payable_account_id uuid,
  p_credit_account_id uuid,
  p_lines jsonb default null,
  p_return_credit_asset_account_id uuid default null
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_remaining_before numeric;
  v_effective_amount numeric;
  v_entry_id uuid;
  v_credit_note_id uuid;
  v_grn_id uuid;
  v_line jsonb;
  v_item_id uuid;
  v_qty_returned numeric;
  v_line_cost numeric;
  v_total_cost_returned numeric := 0;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_costs numeric[] := '{}';
  i int;
  v_excess numeric;
  v_supplier_id uuid;
  v_return_credit_entry_id uuid;
  v_line_id uuid;
begin
  select ap_bill_remaining(p_bill_id) into v_remaining_before;

  if p_lines is not null and jsonb_array_length(p_lines) > 0 then
    select id into v_grn_id from goods_receipt_notes where bill_id = p_bill_id;

    if v_grn_id is null then
      raise exception 'Bill % gak punya goods_receipt_notes -- gak bisa retur stok', p_bill_id;
    end if;

    for v_line in select * from jsonb_array_elements(p_lines)
    loop
      v_item_id := (v_line->>'item_id')::uuid;
      v_qty_returned := (v_line->>'qty_returned')::numeric;

      v_line_cost := consume_weighted_average(v_item_id, v_qty_returned);

      v_line_items := array_append(v_line_items, v_item_id);
      v_line_qtys := array_append(v_line_qtys, v_qty_returned);
      v_line_costs := array_append(v_line_costs, v_line_cost);
      v_total_cost_returned := v_total_cost_returned + v_line_cost;
    end loop;

    v_effective_amount := v_total_cost_returned;
  else
    v_effective_amount := p_amount;
  end if;

  v_entry_id := create_journal_entry(
    p_credit_note_date, 'Retur barang ke supplier', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_payable_account_id, 'debit', v_effective_amount, 'credit', 0),
      jsonb_build_object('account_id', p_credit_account_id, 'debit', 0, 'credit', v_effective_amount)
    )
  );

  insert into credit_notes (type, transaction_id, credit_note_date, source_ref, amount, journal_entry_id, created_by)
  values ('OUTBOUND', p_bill_id, p_credit_note_date, p_source_ref, v_effective_amount, v_entry_id, auth.uid())
  returning id into v_credit_note_id;

  if array_length(v_line_items, 1) is not null then
    for i in 1..array_length(v_line_items, 1) loop
      insert into purchase_return_lines (credit_note_id, item_id, qty_returned, total_cost)
      values (v_credit_note_id, v_line_items[i], v_line_qtys[i], v_line_costs[i])
      returning id into v_line_id;

      insert into inventory_movements (item_id, movement_date, qty, purchase_return_line_id)
      values (v_line_items[i], p_credit_note_date, -v_line_qtys[i], v_line_id);
    end loop;
  end if;

  v_excess := greatest(0, v_effective_amount - greatest(0, v_remaining_before));

  if v_excess > 0 then
    if p_return_credit_asset_account_id is null then
      raise exception 'Retur % bikin Utang Usaha jadi minus (excess %) -- wajib isi p_return_credit_asset_account_id',
        p_source_ref, v_excess;
    end if;

    select counterparty_id into v_supplier_id from transactions where id = p_bill_id;

    v_return_credit_entry_id := create_journal_entry(
      p_credit_note_date, 'Piutang retur dari supplier', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_return_credit_asset_account_id, 'debit', v_excess, 'credit', 0),
        jsonb_build_object('account_id', p_payable_account_id, 'debit', 0, 'credit', v_excess)
      )
    );

    insert into ap_return_credits (supplier_id, credit_note_id, amount, journal_entry_id, created_by)
    values (v_supplier_id, v_credit_note_id, v_excess, v_return_credit_entry_id, auth.uid());
  end if;

  return v_credit_note_id;
end;
$$;

-- 11. Reducer #2 (retur) ar_invoice_remaining/ap_bill_remaining -> target credit_notes
create or replace function ar_invoice_remaining(p_invoice_id uuid) returns numeric as $$
  select ai.amount
    - coalesce((
        select sum(amount) from payments where transaction_id = p_invoice_id and type = 'INBOUND'
      ), 0)
    - coalesce((
        select sum(amount) from credit_notes where transaction_id = p_invoice_id and type = 'INBOUND'
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
        select sum(ada.amount) from ap_deposit_applications ada
        where ada.bill_id = p_bill_id
          and not exists (
            select 1 from journal_entries je where je.reverses_entry_id = ada.journal_entry_id
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

-- 12. cancel_ap_bill: guard credit-note-count target credit_notes
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

-- 13. return_credit_refunds_guard (2 fungsi, retarget join ke credit_notes)
create or replace function ar_return_credit_refunds_guard() returns trigger as $$
declare
  v_remaining numeric;
  v_credit_note_ref text;
begin
  select ar_return_credit_remaining(new.credit_id) into v_remaining;

  if new.amount > v_remaining then
    select acn.source_ref into v_credit_note_ref
      from ar_return_credits arc join credit_notes acn on acn.id = arc.credit_note_id
      where arc.id = new.credit_id;
    raise exception 'Refund saldo kredit retur (dari %) melebihi sisa saldo (sisa %, coba refund %)',
      v_credit_note_ref, v_remaining, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create or replace function ap_return_credit_refunds_guard() returns trigger as $$
declare
  v_remaining numeric;
  v_credit_note_ref text;
begin
  select ap_return_credit_remaining(new.credit_id) into v_remaining;

  if new.amount > v_remaining then
    select acn.source_ref into v_credit_note_ref
      from ap_return_credits arc join credit_notes acn on acn.id = arc.credit_note_id
      where arc.id = new.credit_id;
    raise exception 'Refund saldo kredit retur (dari %) melebihi sisa saldo (sisa %, coba refund %)',
      v_credit_note_ref, v_remaining, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

-- 14. ap_return_credits_sync_bill_status / ar_return_credits_sync_invoice_status
-- (lookup bill_id/invoice_id sekarang lewat credit_notes.transaction_id)
create or replace function ap_return_credits_sync_bill_status() returns trigger as $$
declare
  v_bill_id uuid;
begin
  select transaction_id into v_bill_id from credit_notes where id = new.credit_note_id;
  if v_bill_id is not null then
    perform recompute_transaction_status(v_bill_id);
  end if;
  return new;
end;
$$ language plpgsql;

create or replace function ar_return_credits_sync_invoice_status() returns trigger as $$
declare
  v_invoice_id uuid;
begin
  select transaction_id into v_invoice_id from credit_notes where id = new.credit_note_id;
  if v_invoice_id is not null then
    perform recompute_transaction_status(v_invoice_id);
  end if;
  return new;
end;
$$ language plpgsql;

-- 15. purchase_return_lines_no_over_return: lookup bill_id lewat credit_notes.transaction_id
create or replace function purchase_return_lines_no_over_return() returns trigger as $$
declare
  v_bill_id uuid;
  v_grn_id uuid;
  v_qty_received numeric;
  v_already numeric;
  v_bill_ref text;
  v_item_name text;
begin
  select transaction_id into v_bill_id from credit_notes where id = new.credit_note_id;
  select id into v_grn_id from goods_receipt_notes where bill_id = v_bill_id;

  if v_grn_id is null then
    select source_ref into v_bill_ref from transactions where id = v_bill_id;
    raise exception 'Bill % gak punya goods_receipt_notes -- gak bisa retur stok per item', v_bill_ref;
  end if;

  select qty_received into v_qty_received
    from goods_receipt_lines where grn_id = v_grn_id and item_id = new.item_id;

  if not found then
    select name into v_item_name from items where id = new.item_id;
    select source_ref into v_bill_ref from transactions where id = v_bill_id;
    raise exception 'Item "%" gak ada di goods receipt bill %, gak bisa diretur', v_item_name, v_bill_ref;
  end if;

  select purchase_returned_qty(v_bill_id, new.item_id) into v_already;

  if v_already + new.qty_returned > v_qty_received then
    select name into v_item_name from items where id = new.item_id;
    raise exception 'Retur item "%" melebihi qty diterima (diterima %, sudah diklaim %, coba retur %)',
      v_item_name, v_qty_received, v_already, new.qty_returned;
  end if;

  return new;
end;
$$ language plpgsql;

-- 16. purchase_returned_qty / sales_returned_qty: join credit_notes filter by type
create or replace function purchase_returned_qty(p_bill_id uuid, p_item_id uuid) returns numeric as $$
  select
    coalesce((
      select sum(prl.qty_returned) from purchase_return_lines prl
      join credit_notes acn on acn.id = prl.credit_note_id
      where acn.transaction_id = p_bill_id and acn.type = 'OUTBOUND' and prl.item_id = p_item_id
    ), 0)
    +
    coalesce((
      select sum(prpl.qty_replaced) from purchase_replacement_lines prpl
      join purchase_replacements prp on prp.id = prpl.purchase_replacement_id
      where prp.bill_id = p_bill_id and prpl.item_id = p_item_id
    ), 0);
$$ language sql stable;

create or replace function sales_returned_qty(p_invoice_id uuid, p_item_id uuid) returns numeric as $$
  select
    coalesce((
      select sum(irl.qty_returned) from inventory_return_lines irl
      join inventory_returns ir on ir.id = irl.inventory_return_id
      join credit_notes acn on acn.id = ir.credit_note_id
      where acn.transaction_id = p_invoice_id and acn.type = 'INBOUND' and irl.item_id = p_item_id
    ), 0)
    +
    coalesce((
      select sum(wrl.qty_replaced) from warranty_replacement_lines wrl
      join warranty_replacements wr on wr.id = wrl.warranty_replacement_id
      where wr.invoice_id = p_invoice_id and wrl.item_id = p_item_id
    ), 0);
$$ language sql stable;

-- 17. warranty_replacements guard functions: lookup lewat credit_notes
create or replace function warranty_replacements_no_over_reverse() returns trigger as $$
declare
  v_credit_note_amount numeric;
  v_already_reversed numeric;
begin
  select amount into v_credit_note_amount from credit_notes where id = new.credit_note_id;

  select coalesce(sum(discount_reversed_amount), 0) into v_already_reversed
    from warranty_replacements where credit_note_id = new.credit_note_id;

  if v_already_reversed + new.discount_reversed_amount > v_credit_note_amount then
    raise exception 'Pembalikan diskon retur melebihi diskon yang diberikan (diskon %, sudah dibalik %, coba balik %)',
      v_credit_note_amount, v_already_reversed, new.discount_reversed_amount;
  end if;

  return new;
end;
$$ language plpgsql;

create or replace function warranty_replacements_no_over_settle_return_credit() returns trigger as $$
declare
  v_credit_id uuid;
  v_remaining numeric;
  v_credit_note_ref text;
begin
  if new.return_credit_settled_amount = 0 then
    return new;
  end if;

  select id into v_credit_id from ar_return_credits where credit_note_id = new.credit_note_id;

  if v_credit_id is null then
    select source_ref into v_credit_note_ref from credit_notes where id = new.credit_note_id;
    raise exception 'Retur % gak punya saldo kredit retur aktif — gak bisa isi return_credit_settled_amount', v_credit_note_ref;
  end if;

  select ar_return_credit_remaining(v_credit_id) into v_remaining;

  if new.return_credit_settled_amount > v_remaining then
    select acn.source_ref into v_credit_note_ref
      from ar_return_credits arc join credit_notes acn on acn.id = arc.credit_note_id
      where arc.id = v_credit_id;
    raise exception 'Penyelesaian saldo kredit retur (dari %) melebihi sisa saldo (sisa %, coba selesaikan %)',
      v_credit_note_ref, v_remaining, new.return_credit_settled_amount;
  end if;

  return new;
end;
$$ language plpgsql;

-- 18. recompute_transaction_status: reducer v_returned (INBOUND) -> target credit_notes
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

-- 19. View inventory_movements_with_source: join ap_credit_notes (VIA purchase_return_lines)
-- -> credit_notes. Beda dari fungsi plpgsql lain di migration ini (yang gak bikin pg_depend
-- ke tabel yang dia query di body-nya) -- VIEW punya dependency BENERAN ke tabel yang
-- di-select, jadi drop table ap_credit_notes bakal GAGAL KERAS (bukan diam-diam kayak
-- kasus recompute_transaction_status di 0069) kalau ini kelewat.
create or replace view inventory_movements_with_source as
select
  im.id,
  im.item_id,
  im.movement_date,
  im.qty,
  im.created_at,
  coalesce(
    case when im.goods_receipt_line_id is not null then 'Pembelian (Terima Barang)' else null end,
    case when im.production_order_id is not null then 'Produksi (Hasil)' else null end,
    case when im.inventory_return_line_id is not null then 'Retur dari Customer' else null end,
    case when im.stock_opname_line_id is not null then 'Penyesuaian Stock Opname' else null end,
    case when im.goods_issue_line_id is not null then 'Penjualan (Kirim Barang)' else null end,
    case when im.pos_sale_line_id is not null then 'Penjualan (Kios/POS)' else null end,
    case when im.production_order_line_id is not null then 'Produksi (Konsumsi Bahan)' else null end,
    case when im.purchase_return_line_id is not null then 'Retur ke Supplier' else null end,
    case when im.warranty_replacement_line_id is not null then 'Penggantian Garansi' else null end,
    case when im.purchase_replacement_line_id is not null then 'Tukar Barang (Retur Supplier)' else null end
  ) as source_label,
  coalesce(ap_bill.source_ref, prod_header.source_ref, ir.source_ref, so.source_ref, gi.source_ref, ps.source_ref, prod_line_header.source_ref, acn.source_ref, wr.source_ref, pr.source_ref) as source_ref
from inventory_movements im
  left join goods_receipt_lines grl on grl.id = im.goods_receipt_line_id
  left join goods_receipt_notes grn on grn.id = grl.grn_id
  left join transactions ap_bill on ap_bill.id = grn.bill_id
  left join production_orders prod_header on prod_header.id = im.production_order_id
  left join inventory_return_lines irl on irl.id = im.inventory_return_line_id
  left join inventory_returns ir on ir.id = irl.inventory_return_id
  left join stock_opname_lines sol on sol.id = im.stock_opname_line_id
  left join stock_opnames so on so.id = sol.stock_opname_id
  left join goods_issue_lines gil on gil.id = im.goods_issue_line_id
  left join goods_issues gi on gi.id = gil.goods_issue_id
  left join pos_sale_lines psl on psl.id = im.pos_sale_line_id
  left join pos_sales ps on ps.id = psl.pos_sale_id
  left join production_order_lines pol on pol.id = im.production_order_line_id
  left join production_orders prod_line_header on prod_line_header.id = pol.production_order_id
  left join purchase_return_lines prl on prl.id = im.purchase_return_line_id
  left join credit_notes acn on acn.id = prl.credit_note_id and acn.type = 'OUTBOUND'
  left join warranty_replacement_lines wrl on wrl.id = im.warranty_replacement_line_id
  left join warranty_replacements wr on wr.id = wrl.warranty_replacement_id
  left join purchase_replacement_lines prpl on prpl.id = im.purchase_replacement_line_id
  left join purchase_replacements pr on pr.id = prpl.purchase_replacement_id;

-- 20. Drop tabel lama (cascade trigger/index/RLS/grant) + fungsi trigger yang jadi orphan
drop table if exists ar_credit_notes;
drop table if exists ap_credit_notes;
drop function if exists ar_credit_notes_sync_invoice_status();
drop function if exists ap_credit_notes_sync_bill_status();
drop function if exists ar_credit_notes_no_over_return();
drop function if exists ap_credit_notes_no_over_return();
