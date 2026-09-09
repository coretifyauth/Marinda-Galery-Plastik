-- Goods Notes (Goods Receipt + Goods Issue, digabung). Ref: memory/architecture/data/goods-notes-schema.md.
-- type='INBOUND' = penerimaan barang (dulu GRN), type='OUTBOUND' = pengiriman barang (dulu GI).
-- RPC create_goods_receipt/create_goods_issue TETAP 2 fungsi terpisah (efek jurnal beda bentuk).

create table goods_notes (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('INBOUND', 'OUTBOUND')),
  order_id uuid references orders(id),
  transaction_id uuid not null references transactions(id),
  journal_entry_id uuid references journal_entries(id),
  delivery_note_ref text,
  source_ref text,
  note_date date not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),

  constraint goods_notes_journal_entry_outbound_only
    check ((type = 'OUTBOUND') = (journal_entry_id is not null)),
  constraint goods_notes_source_ref_outbound_only
    check ((type = 'OUTBOUND') = (source_ref is not null))
);

create index goods_notes_type_idx on goods_notes(type);
create index goods_notes_order_id_idx on goods_notes(order_id);
create index goods_notes_transaction_id_idx on goods_notes(transaction_id);
create index goods_notes_journal_entry_id_idx on goods_notes(journal_entry_id);
create index goods_notes_note_date_idx on goods_notes(note_date desc);

create trigger goods_notes_block_edit_delete
  before update or delete on goods_notes
  for each row execute function block_edit_delete();

create function goods_notes_order_direction_guard() returns trigger as $$
begin
  if new.order_id is null then
    return new;
  end if;

  if new.type = 'INBOUND' and not exists (
    select 1 from orders where id = new.order_id and direction = 'PURCHASE'
  ) then
    raise exception 'Order % bukan Purchase Order -- gak bisa dipakai di goods note INBOUND', new.order_id;
  end if;

  if new.type = 'OUTBOUND' and not exists (
    select 1 from orders where id = new.order_id and direction = 'SALE'
  ) then
    raise exception 'Order % bukan Sales Order -- gak bisa dipakai di goods note OUTBOUND', new.order_id;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger goods_notes_order_direction_guard_trigger
  before insert on goods_notes
  for each row execute function goods_notes_order_direction_guard();

create table goods_note_lines (
  id uuid primary key default gen_random_uuid(),
  goods_note_id uuid not null references goods_notes(id) on delete cascade,
  item_id uuid not null references items(id),
  order_line_id uuid references order_lines(id),
  qty numeric(14,3) not null check (qty > 0),
  unit_cost numeric(14,2) check (unit_cost is null or unit_cost > 0),
  total_cost numeric(14,2) check (total_cost is null or total_cost > 0),
  unit_price numeric(14,2) check (unit_price is null or unit_price >= 0),

  constraint goods_note_lines_unit_price_xor_order_line
    check (unit_price is null or order_line_id is null)
);

create index goods_note_lines_goods_note_id_idx on goods_note_lines(goods_note_id);
create index goods_note_lines_order_line_id_idx on goods_note_lines(order_line_id);

alter table goods_note_lines add constraint goods_note_lines_id_item_id_key unique (id, item_id);

create trigger goods_note_lines_block_edit_delete
  before update or delete on goods_note_lines
  for each row execute function block_edit_delete();

create function goods_note_lines_cost_fields_guard() returns trigger as $$
declare
  v_type text;
begin
  select type into v_type from goods_notes where id = new.goods_note_id;

  if v_type = 'INBOUND' then
    if new.unit_cost is null then
      raise exception 'unit_cost wajib diisi buat goods note INBOUND';
    end if;
    if new.total_cost is not null then
      raise exception 'total_cost cuma buat goods note OUTBOUND';
    end if;
    if new.unit_price is not null then
      raise exception 'unit_price cuma buat goods note OUTBOUND';
    end if;
  else
    if new.total_cost is null then
      raise exception 'total_cost wajib diisi buat goods note OUTBOUND';
    end if;
    if new.unit_cost is not null then
      raise exception 'unit_cost cuma buat goods note INBOUND';
    end if;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger goods_note_lines_1_cost_fields_guard_trigger
  before insert on goods_note_lines
  for each row execute function goods_note_lines_cost_fields_guard();

create function goods_note_lines_order_direction_guard() returns trigger as $$
declare
  v_type text;
  v_required_direction text;
begin
  if new.order_line_id is null then
    return new;
  end if;

  select type into v_type from goods_notes where id = new.goods_note_id;
  v_required_direction := case v_type when 'INBOUND' then 'PURCHASE' when 'OUTBOUND' then 'SALE' end;

  if not exists (
    select 1 from order_lines ol join orders o on o.id = ol.order_id
    where ol.id = new.order_line_id and o.direction = v_required_direction
  ) then
    raise exception 'Baris order % bukan dari % Order -- gak bisa dipakai di goods note %',
      new.order_line_id, v_required_direction, v_type;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger goods_note_lines_2_order_direction_guard_trigger
  before insert on goods_note_lines
  for each row execute function goods_note_lines_order_direction_guard();

create function goods_note_lines_no_over_fulfill() returns trigger as $$
declare
  v_qty_ordered numeric;
  v_qty_fulfilled numeric;
  v_item_name text;
begin
  if new.order_line_id is null then
    return new;
  end if;

  select qty_ordered into v_qty_ordered from order_lines where id = new.order_line_id;
  select coalesce(sum(qty), 0) into v_qty_fulfilled
    from goods_note_lines where order_line_id = new.order_line_id;

  if v_qty_fulfilled + new.qty > v_qty_ordered then
    select name into v_item_name from items where id = new.item_id;
    raise exception 'Qty item "%" melebihi qty dipesan di order (sisa %, coba %)',
      v_item_name, v_qty_ordered - v_qty_fulfilled, new.qty;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger goods_note_lines_3_no_over_fulfill_trigger
  before insert on goods_note_lines
  for each row execute function goods_note_lines_no_over_fulfill();

create function goods_notes_sync_transaction_status() returns trigger as $$
begin
  perform recompute_transaction_status(new.transaction_id);
  return new;
end;
$$ language plpgsql;

create trigger goods_notes_sync_transaction_status_trigger
  after insert on goods_notes
  for each row execute function goods_notes_sync_transaction_status();

create function goods_note_lines_sync_transaction_status() returns trigger as $$
declare
  v_transaction_id uuid;
begin
  select transaction_id into v_transaction_id from goods_notes where id = new.goods_note_id;
  if v_transaction_id is not null then
    perform recompute_transaction_status(v_transaction_id);
  end if;
  return new;
end;
$$ language plpgsql;

create trigger goods_note_lines_sync_transaction_status_trigger
  after insert on goods_note_lines
  for each row execute function goods_note_lines_sync_transaction_status();

create function goods_note_lines_sync_order_status() returns trigger as $$
declare
  v_order_id uuid;
begin
  if new.order_line_id is null then
    return new;
  end if;
  select order_id into v_order_id from order_lines where id = new.order_line_id;
  if v_order_id is not null then
    perform recompute_order_status(v_order_id);
  end if;
  return new;
end;
$$ language plpgsql;

create trigger goods_note_lines_sync_order_status_trigger
  after insert on goods_note_lines
  for each row execute function goods_note_lines_sync_order_status();

-- create_goods_receipt -- GRN+Bill+update Persediaan sekaligus. consume_weighted_average
-- gak dipanggil di sini (INBOUND ngitung avg_cost manual di bawah), TAPI inventory_movements
-- di-insert langsung (tabel baru didefinisikan 0023_inventory_ledger_schema.sql -- aman,
-- referensi tabel di dalam function body di-resolve lazy).
create function create_goods_receipt(
  p_order_id uuid,
  p_receipt_date date,
  p_delivery_note_ref text,
  p_lines jsonb, -- array of {"order_line_id":uuid|null,"item_id":uuid,"qty_received":numeric,"unit_cost":numeric}
  p_bill_description text,
  p_bill_source_ref text,
  p_debit_account_id uuid,
  p_payable_account_id uuid,
  p_extra_debit_lines jsonb default null,
  p_apply_tax boolean default false,
  p_supplier_id uuid default null
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_supplier_id uuid;
  v_line jsonb;
  v_total_amount numeric := 0;
  v_bill_id uuid;
  v_grn_id uuid;
  v_item_id uuid;
  v_qty_received numeric;
  v_unit_cost numeric;
  v_qty_before numeric;
  v_avg_before numeric;
  v_debit_lines jsonb;
  v_line_id uuid;
begin
  if p_order_id is not null then
    select counterparty_id into v_supplier_id from orders where id = p_order_id and direction = 'PURCHASE';

    if v_supplier_id is null then
      raise exception 'Order % gak ditemukan atau bukan Purchase Order', p_order_id;
    end if;

    if exists (select 1 from orders where id = p_order_id and cancelled_at is not null) then
      raise exception 'Order % udah dibatalkan — gak bisa dibuat penerimaan barang', p_order_id;
    end if;
  else
    if p_supplier_id is null then
      raise exception 'Wajib pilih supplier kalau terima barang langsung tanpa Purchase Order';
    end if;

    if not exists (
      select 1 from counterparty_type_mapping
      where counterparty_id = p_supplier_id and role = 'supplier'
    ) then
      raise exception 'Supplier % gak ditemukan', p_supplier_id;
    end if;

    v_supplier_id := p_supplier_id;
  end if;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_total_amount := v_total_amount + (v_line->>'qty_received')::numeric * (v_line->>'unit_cost')::numeric;
  end loop;

  v_debit_lines := jsonb_build_array(jsonb_build_object('account_id', p_debit_account_id, 'amount', v_total_amount));
  if p_extra_debit_lines is not null then
    for v_line in select * from jsonb_array_elements(p_extra_debit_lines)
    loop
      v_debit_lines := v_debit_lines || jsonb_build_array(v_line);
    end loop;
  end if;

  v_bill_id := create_transaction(
    'INBOUND', v_supplier_id, p_receipt_date, p_bill_description, p_bill_source_ref,
    v_debit_lines,
    p_payable_account_id,
    p_apply_tax
  );

  insert into goods_notes (type, order_id, transaction_id, delivery_note_ref, note_date, created_by)
  values ('INBOUND', p_order_id, v_bill_id, p_delivery_note_ref, p_receipt_date, auth.uid())
  returning id into v_grn_id;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_item_id := (v_line->>'item_id')::uuid;
    v_qty_received := (v_line->>'qty_received')::numeric;
    v_unit_cost := (v_line->>'unit_cost')::numeric;

    insert into goods_note_lines (goods_note_id, order_line_id, item_id, qty, unit_cost)
    values (v_grn_id, nullif(v_line->>'order_line_id', '')::uuid, v_item_id, v_qty_received, v_unit_cost)
    returning id into v_line_id;

    insert into inventory_movements (item_id, movement_date, qty, goods_note_line_id)
    values (v_item_id, p_receipt_date, v_qty_received, v_line_id);

    select qty_on_hand, avg_cost into v_qty_before, v_avg_before
      from inventory_balances where item_id = v_item_id;

    if not found then
      insert into inventory_balances (item_id, qty_on_hand, avg_cost)
      values (v_item_id, v_qty_received, v_unit_cost);
    else
      update inventory_balances
        set qty_on_hand = v_qty_before + v_qty_received,
            avg_cost = (v_qty_before * v_avg_before + v_qty_received * v_unit_cost) / (v_qty_before + v_qty_received),
            updated_at = now()
        where item_id = v_item_id;
    end if;
  end loop;

  return v_grn_id;
end;
$$;

-- create_goods_issue -- Invoice+konsumsi barang jadi+jurnal HPP sekaligus.
create function create_goods_issue(
  p_customer_id uuid,
  p_invoice_date date,
  p_description text,
  p_source_ref text,
  p_credit_lines jsonb,
  p_receivable_account_id uuid,
  p_lines jsonb, -- array of {"item_id":uuid,"qty_issued":numeric,"order_line_id":uuid|null,"unit_price":numeric|null}
  p_hpp_account_id uuid,
  p_finished_good_account_id uuid,
  p_apply_tax boolean default false
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_issue_id uuid := gen_random_uuid();
  v_invoice_id uuid;
  v_line jsonb;
  v_item_id uuid;
  v_qty numeric;
  v_order_line_id uuid;
  v_unit_price numeric;
  v_line_cost numeric;
  v_total_cost numeric := 0;
  v_entry_id uuid;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_costs numeric[] := '{}';
  v_line_order_lines uuid[] := '{}';
  v_line_unit_prices numeric[] := '{}';
  v_line_id uuid;
  i int;
begin
  if exists (
    select 1
    from jsonb_array_elements(p_lines) as l
    join order_lines ol on ol.id = nullif(l->>'order_line_id', '')::uuid
    join orders o on o.id = ol.order_id
    where o.cancelled_at is not null
  ) then
    raise exception 'Salah satu baris menunjuk sales order yang udah dibatalkan';
  end if;

  v_invoice_id := create_transaction(
    'OUTBOUND', p_customer_id, p_invoice_date, p_description, p_source_ref,
    p_credit_lines, p_receivable_account_id, p_apply_tax
  );

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_item_id := (v_line->>'item_id')::uuid;
    v_qty := (v_line->>'qty_issued')::numeric;
    v_order_line_id := nullif(v_line->>'order_line_id', '')::uuid;
    v_unit_price := (v_line->>'unit_price')::numeric;

    v_line_cost := consume_weighted_average(v_item_id, v_qty);

    v_line_items := array_append(v_line_items, v_item_id);
    v_line_qtys := array_append(v_line_qtys, v_qty);
    v_line_costs := array_append(v_line_costs, v_line_cost);
    v_line_order_lines := array_append(v_line_order_lines, v_order_line_id);
    v_line_unit_prices := array_append(v_line_unit_prices, v_unit_price);
    v_total_cost := v_total_cost + v_line_cost;
  end loop;

  v_entry_id := create_journal_entry(
    p_invoice_date, 'HPP ' || p_description, p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_hpp_account_id, 'debit', v_total_cost, 'credit', 0),
      jsonb_build_object('account_id', p_finished_good_account_id, 'debit', 0, 'credit', v_total_cost)
    )
  );

  insert into goods_notes (id, type, transaction_id, journal_entry_id, source_ref, note_date, created_by)
  values (v_issue_id, 'OUTBOUND', v_invoice_id, v_entry_id, p_source_ref, p_invoice_date, auth.uid());

  for i in 1..array_length(v_line_items, 1) loop
    insert into goods_note_lines (goods_note_id, item_id, qty, total_cost, order_line_id, unit_price)
    values (v_issue_id, v_line_items[i], v_line_qtys[i], v_line_costs[i], v_line_order_lines[i], v_line_unit_prices[i])
    returning id into v_line_id;

    insert into inventory_movements (item_id, movement_date, qty, goods_note_line_id)
    values (v_line_items[i], p_invoice_date, -v_line_qtys[i], v_line_id);
  end loop;

  return v_issue_id;
end;
$$;

alter table goods_notes enable row level security;

create policy goods_notes_select on goods_notes
  for select using (auth.role() = 'authenticated');

create policy goods_notes_insert on goods_notes
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

grant select, insert on goods_notes to authenticated;

alter table goods_note_lines enable row level security;

create policy goods_note_lines_select on goods_note_lines
  for select using (auth.role() = 'authenticated');

create policy goods_note_lines_insert on goods_note_lines
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

grant select, insert on goods_note_lines to authenticated;
