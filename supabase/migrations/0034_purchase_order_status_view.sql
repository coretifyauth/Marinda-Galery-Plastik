-- View buat filter status di list page Purchase Orders (server-side WHERE), nutup
-- memory/scope-debt/purchase-orders-status-filter.md.
--
-- Beda dari AP/AR (status dari uang) -- status PO dari QTY per baris
-- (goods_receipt_lines.qty_received vs purchase_order_lines.qty_ordered), mirror poStatus()
-- (apps/erp/src/lib/purchase-orders/schema.ts) persis: cancelled_at menang duluan (state
-- terminal), baru "every line received >= ordered" (FULLY_RECEIVED) / "every line received <=
-- 0" (OPEN) / else PARTIALLY_RECEIVED. bool_and dipakai biar semantiknya sama persis dengan
-- Array.prototype.every() di client, termasuk vacuous-truth kalau PO gak punya baris sama
-- sekali (coalesce ke true, walau createPurchaseOrderSchema udah wajibin minimal 1 baris).
create view purchase_orders_with_status
  with (security_invoker = true) as
select
  po.id,
  po.supplier_id,
  po.po_date,
  po.expected_date,
  po.source_ref,
  po.created_at,
  po.cancelled_at,
  case
    when po.cancelled_at is not null then 'CANCELLED'
    when s.all_received then 'FULLY_RECEIVED'
    when s.none_received then 'OPEN'
    else 'PARTIALLY_RECEIVED'
  end as status
from purchase_orders po
cross join lateral (
  select
    coalesce(bool_and(coalesce(gr.received, 0) >= pol.qty_ordered - 0.0005), true) as all_received,
    coalesce(bool_and(coalesce(gr.received, 0) <= 0.0005), true) as none_received
  from purchase_order_lines pol
  left join lateral (
    select sum(grl.qty_received) as received
    from goods_receipt_lines grl
    where grl.po_line_id = pol.id
  ) gr on true
  where pol.purchase_order_id = po.id
) s;

grant select on purchase_orders_with_status to authenticated;
