-- Inventory Ledger (inventory_balances + inventory_movements). Ref:
-- docs/architecture/inventory-ledger-schema.md.
--
-- inventory_movements WAJIB di sini (bukan lebih awal) -- composite FK-nya butuh 6 tabel
-- sumber (goods_note_lines, production_order_lines, return_lines, stock_opname_lines,
-- replacement_lines) SEMUA sudah ada duluan (file 0011/0012/0018/0019/0021).

create table inventory_balances (
  item_id uuid primary key references items(id),
  qty_on_hand numeric(14,3) not null default 0 check (qty_on_hand >= 0),
  avg_cost numeric(14,2) not null default 0,
  updated_at timestamptz not null default now()
);

grant select, insert, update on inventory_balances to authenticated;

alter table inventory_balances enable row level security;

create policy inventory_balances_select on inventory_balances
  for select using (auth.role() = 'authenticated');

create policy inventory_balances_insert on inventory_balances
  for insert with check (
    exists (select 1 from app_user_roles ur
            where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );

create policy inventory_balances_update on inventory_balances
  for update using (
    exists (select 1 from app_user_roles ur
            where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );

-- consume_weighted_average -- satu-satunya jalur konsumsi stok (dipakai create_goods_issue,
-- create_production_order, create_replacement, create_ap_return).
-- Cuma kurangin qty_on_hand, avg_cost gak berubah pas konsumsi.
create function consume_weighted_average(p_item_id uuid, p_qty_needed numeric) returns numeric
language plpgsql
security invoker
as $$
declare
  v_qty_on_hand numeric;
  v_avg_cost numeric;
  v_total_cost numeric;
  v_item_name text;
begin
  select qty_on_hand, avg_cost into v_qty_on_hand, v_avg_cost
    from inventory_balances where item_id = p_item_id;

  if not found or v_qty_on_hand < p_qty_needed then
    select name into v_item_name from items where id = p_item_id;
    raise exception 'Stok Weighted Average item "%" gak cukup (tersedia %, butuh %)',
      coalesce(v_item_name, p_item_id::text), coalesce(v_qty_on_hand, 0), p_qty_needed;
  end if;

  v_total_cost := p_qty_needed * v_avg_cost;

  update inventory_balances
    set qty_on_hand = v_qty_on_hand - p_qty_needed,
        updated_at = now()
    where item_id = p_item_id;

  return v_total_cost;
end;
$$;

create table inventory_movements (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references items(id),
  movement_date date not null,
  qty numeric(14,3) not null check (qty <> 0),
  created_at timestamptz not null default now(),

  goods_note_line_id uuid,
  production_order_id uuid,
  return_line_id uuid,
  stock_opname_line_id uuid,
  production_order_line_id uuid,
  replacement_line_id uuid,

  foreign key (goods_note_line_id, item_id) references goods_note_lines(id, item_id),
  foreign key (production_order_id, item_id) references production_orders(id, item_id),
  foreign key (return_line_id, item_id) references return_lines(id, item_id),
  foreign key (stock_opname_line_id, item_id) references stock_opname_lines(id, item_id),
  foreign key (production_order_line_id, item_id) references production_order_lines(id, item_id),
  foreign key (replacement_line_id, item_id) references replacement_lines(id, item_id),

  -- Tepat 1 dari 6 kolom sumber di atas wajib terisi per baris -- traceability ke 1 sumber
  -- tunggal (Core Invariant: tiap transaksi traceable ke source document).
  check (
    num_nonnulls(
      goods_note_line_id, production_order_id, return_line_id,
      stock_opname_line_id, production_order_line_id, replacement_line_id
    ) = 1
  )
);

create index inventory_movements_item_id_movement_date_id_idx
  on inventory_movements(item_id, movement_date, id);

create trigger inventory_movements_block_edit_delete
  before update or delete on inventory_movements
  for each row execute function block_edit_delete();

alter table inventory_movements enable row level security;

create policy inventory_movements_select on inventory_movements
  for select using (auth.role() = 'authenticated');

create policy inventory_movements_insert on inventory_movements
  for insert with check (
    exists (select 1 from app_user_roles ur
            where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );

grant select, insert on inventory_movements to authenticated;

-- report_item_movement_opening_balance -- SUM(qty) sampai cutoff (pola sama opening-balance
-- General Ledger), dipakai Kartu Stok /items/[id].
create function report_item_movement_opening_balance(
  p_item_id uuid,
  p_as_of date,
  p_before_offset int
)
returns numeric
language sql
stable
security invoker
as $$
  select coalesce(sum(sub.qty), 0)
  from (
    select im.qty
    from inventory_movements im
    where im.item_id = p_item_id and im.movement_date <= p_as_of
    order by im.movement_date, im.id
    limit p_before_offset
  ) sub;
$$;

grant execute on function report_item_movement_opening_balance(uuid, date, int) to authenticated;

-- inventory_movements_with_source -- VIEW join semua tabel sumber, dipakai Kartu Stok
-- /items/[id] buat resolve nama/referensi dokumen sumber.
create view inventory_movements_with_source
  with (security_invoker = true) as
select
  im.id,
  im.item_id,
  im.movement_date,
  im.qty,
  im.created_at,
  coalesce(
    case when im.goods_note_line_id is not null and gn.type = 'INBOUND' then 'Pembelian (Terima Barang)' else null end,
    case when im.production_order_id is not null then 'Produksi (Hasil)' else null end,
    case when im.return_line_id is not null and rl.type = 'INBOUND' then 'Retur dari Customer' else null end,
    case when im.stock_opname_line_id is not null then 'Penyesuaian Stock Opname' else null end,
    case when im.goods_note_line_id is not null and gn.type = 'OUTBOUND' then 'Penjualan (Kirim Barang)' else null end,
    case when im.production_order_line_id is not null then 'Produksi (Konsumsi Bahan)' else null end,
    case when im.return_line_id is not null and rl.type = 'OUTBOUND' then 'Retur ke Supplier' else null end,
    case when im.replacement_line_id is not null and rp.type = 'INBOUND' then 'Penggantian Garansi' else null end,
    case when im.replacement_line_id is not null and rp.type = 'OUTBOUND' then 'Tukar Barang (Retur Supplier)' else null end
  ) as source_label,
  coalesce(ap_bill.source_ref, prod_header.source_ref, r.source_ref, so.source_ref, gn.source_ref, prod_line_header.source_ref, rp.source_ref) as source_ref
from inventory_movements im
  left join goods_note_lines gnl on gnl.id = im.goods_note_line_id
  left join goods_notes gn on gn.id = gnl.goods_note_id
  left join transactions ap_bill on ap_bill.id = gn.transaction_id and gn.type = 'INBOUND'
  left join production_orders prod_header on prod_header.id = im.production_order_id
  left join return_lines rl on rl.id = im.return_line_id
  left join returns r on r.id = rl.return_id
  left join stock_opname_lines sol on sol.id = im.stock_opname_line_id
  left join stock_opnames so on so.id = sol.stock_opname_id
  left join production_order_lines pol on pol.id = im.production_order_line_id
  left join production_orders prod_line_header on prod_line_header.id = pol.production_order_id
  left join replacement_lines rpl on rpl.id = im.replacement_line_id
  left join replacements rp on rp.id = rpl.replacement_id;

grant select on inventory_movements_with_source to authenticated;
