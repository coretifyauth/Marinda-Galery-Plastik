-- Sales Order — cerminan Purchase Order di sisi jual (3-way matching versi jual:
-- SO -> Goods Issue+Invoice). Sengaja BUKAN wajib (beda dari PO yang wajib di AP) —
-- goods_issue_lines.so_line_id nullable, jalur jual langsung tanpa SO tetap jalan
-- apa adanya. Ref: docs/architecture/inventory-schema.md submodule "Sales Order".

-- ============================================================
-- Sales Order (komitmen, belum ada journal entry — mirror purchase_orders)
-- ============================================================

create table sales_orders (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  so_date date not null,
  expected_date date,
  source_ref text not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index sales_orders_customer_id_idx on sales_orders(customer_id);

create trigger sales_orders_block_edit_delete
  before update or delete on sales_orders
  for each row execute function block_edit_delete();

create table sales_order_lines (
  id uuid primary key default gen_random_uuid(),
  sales_order_id uuid not null references sales_orders(id) on delete cascade,
  item_id uuid not null references items(id),
  qty_ordered numeric(14,3) not null check (qty_ordered > 0),
  unit_price numeric(14,2) not null check (unit_price > 0)
);

create index sales_order_lines_so_id_idx on sales_order_lines(sales_order_id);
create index sales_order_lines_item_id_idx on sales_order_lines(item_id);

create trigger sales_order_lines_block_edit_delete
  before update or delete on sales_order_lines
  for each row execute function block_edit_delete();

-- ============================================================
-- goods_issue_lines.so_line_id — nullable, nunjuk balik ke sales order yang
-- lagi dipenuhi. NULL = jual langsung tanpa SO (jalur lama, gak berubah).
-- ============================================================

alter table goods_issue_lines
  add column so_line_id uuid references sales_order_lines(id);

create index goods_issue_lines_so_line_id_idx on goods_issue_lines(so_line_id);

create function goods_issue_lines_no_over_issue() returns trigger as $$
declare
  v_qty_ordered numeric;
  v_qty_issued numeric;
begin
  if new.so_line_id is null then
    return new;
  end if;

  select qty_ordered into v_qty_ordered from sales_order_lines where id = new.so_line_id;
  select coalesce(sum(qty_issued), 0) into v_qty_issued
    from goods_issue_lines where so_line_id = new.so_line_id;

  if v_qty_issued + new.qty_issued > v_qty_ordered then
    raise exception 'Pengiriman line % melebihi qty_ordered (sisa %, coba kirim %)',
      new.so_line_id, v_qty_ordered - v_qty_issued, new.qty_issued;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger goods_issue_lines_no_over_issue_trigger
  before insert on goods_issue_lines
  for each row execute function goods_issue_lines_no_over_issue();

-- ============================================================
-- RPC create_sales_order — murni insert, gak ada journal entry (SO cuma komitmen)
-- ============================================================

create function create_sales_order(
  p_customer_id uuid,
  p_so_date date,
  p_expected_date date,
  p_source_ref text,
  p_lines jsonb -- array of {"item_id":uuid,"qty_ordered":numeric,"unit_price":numeric}
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_so_id uuid;
  v_line jsonb;
begin
  insert into sales_orders (customer_id, so_date, expected_date, source_ref, created_by)
  values (p_customer_id, p_so_date, p_expected_date, p_source_ref, auth.uid())
  returning id into v_so_id;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    insert into sales_order_lines (sales_order_id, item_id, qty_ordered, unit_price)
    values (
      v_so_id,
      (v_line->>'item_id')::uuid,
      (v_line->>'qty_ordered')::numeric,
      (v_line->>'unit_price')::numeric
    );
  end loop;

  return v_so_id;
end;
$$;

-- ============================================================
-- create_goods_issue — signature TETAP SAMA (create or replace, bukan migration
-- destruktif), cuma p_lines sekarang boleh punya key opsional "so_line_id".
-- Caller lama yang gak nyertain key itu tetap jalan apa adanya (NULL).
-- ============================================================

create or replace function create_goods_issue(
  p_customer_id uuid,
  p_invoice_date date,
  p_description text,
  p_source_ref text,
  p_amount numeric,
  p_receivable_account_id uuid,
  p_revenue_account_id uuid,
  p_lines jsonb, -- array of {"item_id":uuid,"qty_issued":numeric,"so_line_id":uuid|null}
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
  v_so_line_id uuid;
  v_line_cost numeric;
  v_total_cost numeric := 0;
  v_entry_id uuid;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_costs numeric[] := '{}';
  v_line_so_lines uuid[] := '{}';
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
    v_so_line_id := nullif(v_line->>'so_line_id', '')::uuid;

    v_line_cost := consume_weighted_average(v_item_id, v_qty);

    v_line_items := array_append(v_line_items, v_item_id);
    v_line_qtys := array_append(v_line_qtys, v_qty);
    v_line_costs := array_append(v_line_costs, v_line_cost);
    v_line_so_lines := array_append(v_line_so_lines, v_so_line_id);
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
    insert into goods_issue_lines (goods_issue_id, item_id, qty_issued, total_cost, so_line_id)
    values (v_issue_id, v_line_items[i], v_line_qtys[i], v_line_costs[i], v_line_so_lines[i]);
  end loop;

  return v_issue_id;
end;
$$;

-- ============================================================
-- RLS & Grant — pola identik purchase_orders/purchase_order_lines
-- ============================================================

alter table sales_orders enable row level security;

create policy sales_orders_select on sales_orders
  for select using (auth.role() = 'authenticated');

create policy sales_orders_insert on sales_orders
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );
-- sengaja gak ada policy update/delete -> immutable, RLS default-deny + block_edit_delete

alter table sales_order_lines enable row level security;

create policy sales_order_lines_select on sales_order_lines
  for select using (auth.role() = 'authenticated');

create policy sales_order_lines_insert on sales_order_lines
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

grant select, insert on sales_orders to authenticated;
grant select, insert on sales_order_lines to authenticated;
