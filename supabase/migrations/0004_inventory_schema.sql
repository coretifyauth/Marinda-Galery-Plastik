-- Inventory & HPP (Weighted Average only — FIFO costing pernah ada, dihapus total).
-- Konsolidasi dari migration historis 0012 (base) + 0038 (hapus FIFO/inventory_lots/
-- inventory_lot_consumptions/items.costing_method) — lihat git log untuk riwayat evolusi.
-- Ref: docs/architecture/inventory-schema.md
--
-- Catatan FK lintas-modul: purchase_orders.supplier_id, goods_receipt_notes.bill_id,
-- dan goods_issues.invoice_id sengaja dideklarasikan TANPA `references` inline di sini —
-- tabel targetnya (suppliers/ap_bills di modul AP, ar_invoices di modul AR) belum ada di
-- titik ini. Constraint FK-nya ditambahkan lewat `alter table ... add constraint` di akhir
-- 0005_ar_schema.sql (goods_issues.invoice_id) dan 0006_ap_schema.sql (2 lainnya), setelah
-- tabel targetnya dibuat.

-- ============================================================
-- Master Data
-- ============================================================

create table items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  item_type text not null check (item_type in ('RAW_MATERIAL','FINISHED_GOOD')),
  uom text not null,
  inventory_account_id uuid not null references accounts(id),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger items_set_updated_at
  before update on items
  for each row execute function set_updated_at();

create table inventory_balances (
  item_id uuid primary key references items(id),
  qty_on_hand numeric(14,3) not null default 0 check (qty_on_hand >= 0),
  avg_cost numeric(14,2) not null default 0,
  updated_at timestamptz not null default now()
);

-- ============================================================
-- Procurement: PO -> GRN+Bill
-- ============================================================

create table purchase_orders (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null, -- FK ditambah di 0006_ap_schema.sql (references suppliers(id))
  po_date date not null,
  expected_date date,
  source_ref text not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index purchase_orders_supplier_id_idx on purchase_orders(supplier_id);

create trigger purchase_orders_block_edit_delete
  before update or delete on purchase_orders
  for each row execute function block_edit_delete();

create table purchase_order_lines (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references purchase_orders(id) on delete cascade,
  item_id uuid not null references items(id),
  qty_ordered numeric(14,3) not null check (qty_ordered > 0),
  unit_cost_expected numeric(14,2) not null check (unit_cost_expected > 0)
);

create index purchase_order_lines_po_id_idx on purchase_order_lines(purchase_order_id);
create index purchase_order_lines_item_id_idx on purchase_order_lines(item_id);

create trigger purchase_order_lines_block_edit_delete
  before update or delete on purchase_order_lines
  for each row execute function block_edit_delete();

create table goods_receipt_notes (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references purchase_orders(id),
  bill_id uuid not null, -- FK ditambah di 0006_ap_schema.sql (references ap_bills(id))
  delivery_note_ref text,
  receipt_date date not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index goods_receipt_notes_po_id_idx on goods_receipt_notes(purchase_order_id);
create index goods_receipt_notes_bill_id_idx on goods_receipt_notes(bill_id);

create trigger goods_receipt_notes_block_edit_delete
  before update or delete on goods_receipt_notes
  for each row execute function block_edit_delete();

create table goods_receipt_lines (
  id uuid primary key default gen_random_uuid(),
  grn_id uuid not null references goods_receipt_notes(id) on delete cascade,
  po_line_id uuid not null references purchase_order_lines(id),
  item_id uuid not null references items(id),
  qty_received numeric(14,3) not null check (qty_received > 0),
  unit_cost numeric(14,2) not null check (unit_cost > 0)
);

create index goods_receipt_lines_grn_id_idx on goods_receipt_lines(grn_id);
create index goods_receipt_lines_po_line_id_idx on goods_receipt_lines(po_line_id);

create trigger goods_receipt_lines_block_edit_delete
  before update or delete on goods_receipt_lines
  for each row execute function block_edit_delete();

create function goods_receipt_lines_no_over_receipt() returns trigger as $$
declare
  v_qty_ordered numeric;
  v_qty_received numeric;
begin
  select qty_ordered into v_qty_ordered from purchase_order_lines where id = new.po_line_id;
  select coalesce(sum(qty_received), 0) into v_qty_received
    from goods_receipt_lines where po_line_id = new.po_line_id;

  if v_qty_received + new.qty_received > v_qty_ordered then
    raise exception 'Penerimaan line % melebihi qty_ordered (sisa %, coba terima %)',
      new.po_line_id, v_qty_ordered - v_qty_received, new.qty_received;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger goods_receipt_lines_no_over_receipt_trigger
  before insert on goods_receipt_lines
  for each row execute function goods_receipt_lines_no_over_receipt();

-- ============================================================
-- Production (BOM)
-- ============================================================

create table bom_headers (
  id uuid primary key default gen_random_uuid(),
  finished_item_id uuid not null references items(id),
  output_qty numeric(14,3) not null check (output_qty > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index bom_headers_finished_item_id_idx on bom_headers(finished_item_id);

create trigger bom_headers_set_updated_at
  before update on bom_headers
  for each row execute function set_updated_at();

create table bom_lines (
  id uuid primary key default gen_random_uuid(),
  bom_header_id uuid not null references bom_headers(id) on delete cascade,
  raw_material_item_id uuid not null references items(id),
  qty_per_batch numeric(14,3) not null check (qty_per_batch > 0)
);

create index bom_lines_bom_header_id_idx on bom_lines(bom_header_id);

create table production_orders (
  id uuid primary key default gen_random_uuid(),
  bom_header_id uuid not null references bom_headers(id),
  qty_produced numeric(14,3) not null check (qty_produced > 0),
  production_date date not null,
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index production_orders_bom_header_id_idx on production_orders(bom_header_id);
create index production_orders_journal_entry_id_idx on production_orders(journal_entry_id);

create trigger production_orders_block_edit_delete
  before update or delete on production_orders
  for each row execute function block_edit_delete();

create table production_order_lines (
  id uuid primary key default gen_random_uuid(),
  production_order_id uuid not null references production_orders(id) on delete cascade,
  item_id uuid not null references items(id),
  qty_consumed numeric(14,3) not null check (qty_consumed > 0),
  total_cost numeric(14,2) not null check (total_cost > 0)
);

create index production_order_lines_po_id_idx on production_order_lines(production_order_id);

create trigger production_order_lines_block_edit_delete
  before update or delete on production_order_lines
  for each row execute function block_edit_delete();

-- ============================================================
-- Sales (Goods Issue -> HPP)
-- ============================================================

create table goods_issues (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null, -- FK ditambah di 0005_ar_schema.sql (references ar_invoices(id))
  journal_entry_id uuid not null references journal_entries(id),
  issue_date date not null,
  source_ref text not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index goods_issues_invoice_id_idx on goods_issues(invoice_id);
create index goods_issues_journal_entry_id_idx on goods_issues(journal_entry_id);

create trigger goods_issues_block_edit_delete
  before update or delete on goods_issues
  for each row execute function block_edit_delete();

create table goods_issue_lines (
  id uuid primary key default gen_random_uuid(),
  goods_issue_id uuid not null references goods_issues(id) on delete cascade,
  item_id uuid not null references items(id),
  qty_issued numeric(14,3) not null check (qty_issued > 0),
  total_cost numeric(14,2) not null check (total_cost > 0)
);

create index goods_issue_lines_goods_issue_id_idx on goods_issue_lines(goods_issue_id);

create trigger goods_issue_lines_block_edit_delete
  before update or delete on goods_issue_lines
  for each row execute function block_edit_delete();

-- ============================================================
-- RPC (financial write / stock-affecting write — atomik)
-- ============================================================

create function create_purchase_order(
  p_supplier_id uuid,
  p_po_date date,
  p_expected_date date,
  p_source_ref text,
  p_lines jsonb -- array of {"item_id":uuid,"qty_ordered":numeric,"unit_cost_expected":numeric}
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_po_id uuid;
  v_line jsonb;
begin
  insert into purchase_orders (supplier_id, po_date, expected_date, source_ref, created_by)
  values (p_supplier_id, p_po_date, p_expected_date, p_source_ref, auth.uid())
  returning id into v_po_id;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    insert into purchase_order_lines (purchase_order_id, item_id, qty_ordered, unit_cost_expected)
    values (
      v_po_id,
      (v_line->>'item_id')::uuid,
      (v_line->>'qty_ordered')::numeric,
      (v_line->>'unit_cost_expected')::numeric
    );
  end loop;

  return v_po_id;
end;
$$;

create function create_goods_receipt(
  p_purchase_order_id uuid,
  p_receipt_date date,
  p_delivery_note_ref text,
  p_lines jsonb, -- array of {"po_line_id":uuid,"item_id":uuid,"qty_received":numeric,"unit_cost":numeric}
  p_bill_description text,
  p_bill_source_ref text,
  p_debit_account_id uuid,
  p_payable_account_id uuid
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
begin
  select supplier_id into v_supplier_id from purchase_orders where id = p_purchase_order_id;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_total_amount := v_total_amount + (v_line->>'qty_received')::numeric * (v_line->>'unit_cost')::numeric;
  end loop;

  v_bill_id := create_ap_bill(
    v_supplier_id, p_receipt_date, p_bill_description, p_bill_source_ref,
    v_total_amount, p_debit_account_id, p_payable_account_id
  );

  insert into goods_receipt_notes (purchase_order_id, bill_id, delivery_note_ref, receipt_date, created_by)
  values (p_purchase_order_id, v_bill_id, p_delivery_note_ref, p_receipt_date, auth.uid())
  returning id into v_grn_id;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_item_id := (v_line->>'item_id')::uuid;
    v_qty_received := (v_line->>'qty_received')::numeric;
    v_unit_cost := (v_line->>'unit_cost')::numeric;

    insert into goods_receipt_lines (grn_id, po_line_id, item_id, qty_received, unit_cost)
    values (v_grn_id, (v_line->>'po_line_id')::uuid, v_item_id, v_qty_received, v_unit_cost);

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

-- Konsumsi Weighted Average generik — dipakai production input & sales issue.
create function consume_weighted_average(p_item_id uuid, p_qty_needed numeric) returns numeric
language plpgsql
security invoker
as $$
declare
  v_qty_on_hand numeric;
  v_avg_cost numeric;
  v_total_cost numeric;
begin
  select qty_on_hand, avg_cost into v_qty_on_hand, v_avg_cost
    from inventory_balances where item_id = p_item_id;

  if not found or v_qty_on_hand < p_qty_needed then
    raise exception 'Stok Weighted Average item % gak cukup (tersedia %, butuh %)',
      p_item_id, coalesce(v_qty_on_hand, 0), p_qty_needed;
  end if;

  v_total_cost := p_qty_needed * v_avg_cost;

  update inventory_balances
    set qty_on_hand = v_qty_on_hand - p_qty_needed,
        updated_at = now()
    where item_id = p_item_id;

  return v_total_cost;
end;
$$;

create function create_production_order(
  p_bom_header_id uuid,
  p_qty_produced numeric,
  p_production_date date,
  p_source_ref text,
  p_finished_good_debit_account_id uuid,
  p_raw_material_credit_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_po_id uuid := gen_random_uuid();
  v_finished_item_id uuid;
  v_output_qty numeric;
  v_batch_multiplier numeric;
  v_bom_line record;
  v_qty_needed numeric;
  v_line_cost numeric;
  v_total_raw_cost numeric := 0;
  v_entry_id uuid;
  v_unit_cost numeric;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_costs numeric[] := '{}';
  i int;
begin
  select finished_item_id, output_qty into v_finished_item_id, v_output_qty
    from bom_headers where id = p_bom_header_id;

  v_batch_multiplier := p_qty_produced / v_output_qty;

  for v_bom_line in
    select bl.raw_material_item_id, bl.qty_per_batch
    from bom_lines bl
    where bl.bom_header_id = p_bom_header_id
  loop
    v_qty_needed := v_bom_line.qty_per_batch * v_batch_multiplier;

    v_line_cost := consume_weighted_average(v_bom_line.raw_material_item_id, v_qty_needed);

    v_line_items := array_append(v_line_items, v_bom_line.raw_material_item_id);
    v_line_qtys := array_append(v_line_qtys, v_qty_needed);
    v_line_costs := array_append(v_line_costs, v_line_cost);
    v_total_raw_cost := v_total_raw_cost + v_line_cost;
  end loop;

  v_entry_id := create_journal_entry(
    p_production_date, 'Produksi ' || p_qty_produced || ' unit', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_finished_good_debit_account_id, 'debit', v_total_raw_cost, 'credit', 0),
      jsonb_build_object('account_id', p_raw_material_credit_account_id, 'debit', 0, 'credit', v_total_raw_cost)
    )
  );

  insert into production_orders (id, bom_header_id, qty_produced, production_date, source_ref, journal_entry_id, created_by)
  values (v_po_id, p_bom_header_id, p_qty_produced, p_production_date, p_source_ref, v_entry_id, auth.uid());

  for i in 1..array_length(v_line_items, 1) loop
    insert into production_order_lines (production_order_id, item_id, qty_consumed, total_cost)
    values (v_po_id, v_line_items[i], v_line_qtys[i], v_line_costs[i]);
  end loop;

  v_unit_cost := v_total_raw_cost / p_qty_produced;

  insert into inventory_balances (item_id, qty_on_hand, avg_cost)
  values (v_finished_item_id, p_qty_produced, v_unit_cost)
  on conflict (item_id) do update
    set qty_on_hand = inventory_balances.qty_on_hand + excluded.qty_on_hand,
        avg_cost = (inventory_balances.qty_on_hand * inventory_balances.avg_cost + excluded.qty_on_hand * excluded.avg_cost)
                   / (inventory_balances.qty_on_hand + excluded.qty_on_hand),
        updated_at = now();

  return v_po_id;
end;
$$;

create function create_goods_issue(
  p_customer_id uuid,
  p_invoice_date date,
  p_description text,
  p_source_ref text,
  p_amount numeric,
  p_receivable_account_id uuid,
  p_revenue_account_id uuid,
  p_lines jsonb, -- array of {"item_id":uuid,"qty_issued":numeric}
  p_hpp_account_id uuid,
  p_finished_good_account_id uuid
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
  v_line_cost numeric;
  v_total_cost numeric := 0;
  v_entry_id uuid;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_costs numeric[] := '{}';
  i int;
begin
  v_invoice_id := create_ar_invoice(
    p_customer_id, p_invoice_date, p_description, p_source_ref,
    p_amount, p_receivable_account_id, p_revenue_account_id
  );

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_item_id := (v_line->>'item_id')::uuid;
    v_qty := (v_line->>'qty_issued')::numeric;

    v_line_cost := consume_weighted_average(v_item_id, v_qty);

    v_line_items := array_append(v_line_items, v_item_id);
    v_line_qtys := array_append(v_line_qtys, v_qty);
    v_line_costs := array_append(v_line_costs, v_line_cost);
    v_total_cost := v_total_cost + v_line_cost;
  end loop;

  v_entry_id := create_journal_entry(
    p_invoice_date, 'HPP ' || p_description, p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_hpp_account_id, 'debit', v_total_cost, 'credit', 0),
      jsonb_build_object('account_id', p_finished_good_account_id, 'debit', 0, 'credit', v_total_cost)
    )
  );

  insert into goods_issues (id, invoice_id, journal_entry_id, issue_date, source_ref, created_by)
  values (v_issue_id, v_invoice_id, v_entry_id, p_invoice_date, p_source_ref, auth.uid());

  for i in 1..array_length(v_line_items, 1) loop
    insert into goods_issue_lines (goods_issue_id, item_id, qty_issued, total_cost)
    values (v_issue_id, v_line_items[i], v_line_qtys[i], v_line_costs[i]);
  end loop;

  return v_issue_id;
end;
$$;

-- ============================================================
-- RLS Policy
-- ============================================================

alter table items enable row level security;

create policy items_select on items
  for select using (auth.role() = 'authenticated');

create policy items_insert on items
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

create policy items_update on items
  for update using (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );
-- sengaja gak ada policy DELETE -> arsip lewat archived_at

alter table inventory_balances enable row level security;

create policy inventory_balances_select on inventory_balances
  for select using (auth.role() = 'authenticated');

create policy inventory_balances_insert on inventory_balances
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

create policy inventory_balances_update on inventory_balances
  for update using (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table purchase_orders enable row level security;

create policy purchase_orders_select on purchase_orders
  for select using (auth.role() = 'authenticated');

create policy purchase_orders_insert on purchase_orders
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table purchase_order_lines enable row level security;

create policy purchase_order_lines_select on purchase_order_lines
  for select using (auth.role() = 'authenticated');

create policy purchase_order_lines_insert on purchase_order_lines
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table goods_receipt_notes enable row level security;

create policy goods_receipt_notes_select on goods_receipt_notes
  for select using (auth.role() = 'authenticated');

create policy goods_receipt_notes_insert on goods_receipt_notes
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table goods_receipt_lines enable row level security;

create policy goods_receipt_lines_select on goods_receipt_lines
  for select using (auth.role() = 'authenticated');

create policy goods_receipt_lines_insert on goods_receipt_lines
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table bom_headers enable row level security;

create policy bom_headers_select on bom_headers
  for select using (auth.role() = 'authenticated');

create policy bom_headers_insert on bom_headers
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

create policy bom_headers_update on bom_headers
  for update using (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table bom_lines enable row level security;

create policy bom_lines_select on bom_lines
  for select using (auth.role() = 'authenticated');

create policy bom_lines_insert on bom_lines
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

create policy bom_lines_update on bom_lines
  for update using (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

create policy bom_lines_delete on bom_lines
  for delete using (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table production_orders enable row level security;

create policy production_orders_select on production_orders
  for select using (auth.role() = 'authenticated');

create policy production_orders_insert on production_orders
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table production_order_lines enable row level security;

create policy production_order_lines_select on production_order_lines
  for select using (auth.role() = 'authenticated');

create policy production_order_lines_insert on production_order_lines
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table goods_issues enable row level security;

create policy goods_issues_select on goods_issues
  for select using (auth.role() = 'authenticated');

create policy goods_issues_insert on goods_issues
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table goods_issue_lines enable row level security;

create policy goods_issue_lines_select on goods_issue_lines
  for select using (auth.role() = 'authenticated');

create policy goods_issue_lines_insert on goods_issue_lines
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

-- ============================================================
-- Grant
-- ============================================================

grant select, insert, update on items to authenticated;
grant select, insert, update on inventory_balances to authenticated;
grant select, insert on purchase_orders to authenticated;
grant select, insert on purchase_order_lines to authenticated;
grant select, insert on goods_receipt_notes to authenticated;
grant select, insert on goods_receipt_lines to authenticated;
grant select, insert, update on bom_headers to authenticated;
grant select, insert, update, delete on bom_lines to authenticated;
grant select, insert on production_orders to authenticated;
grant select, insert on production_order_lines to authenticated;
grant select, insert on goods_issues to authenticated;
grant select, insert on goods_issue_lines to authenticated;
