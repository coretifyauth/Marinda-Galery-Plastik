-- View buat filter status di list page Sales Orders (server-side WHERE), nutup
-- memory/scope-debt/sales-orders-status-filter.md. Mirror persis pola
-- purchase_orders_with_status (0034) -- status dari QTY per baris (goods_issue_lines.qty_issued
-- vs sales_order_lines.qty_ordered), soStatus() (apps/erp/src/lib/sales-orders/schema.ts):
-- cancelled_at menang duluan, baru "every line issued >= ordered" (FULLY_FULFILLED) / "every
-- line issued <= 0" (OPEN) / else PARTIALLY_FULFILLED.
create view sales_orders_with_status
  with (security_invoker = true) as
select
  so.id,
  so.customer_id,
  so.so_date,
  so.expected_date,
  so.source_ref,
  so.created_at,
  so.cancelled_at,
  case
    when so.cancelled_at is not null then 'CANCELLED'
    when s.all_issued then 'FULLY_FULFILLED'
    when s.none_issued then 'OPEN'
    else 'PARTIALLY_FULFILLED'
  end as status
from sales_orders so
cross join lateral (
  select
    coalesce(bool_and(coalesce(gi.issued, 0) >= sol.qty_ordered - 0.0005), true) as all_issued,
    coalesce(bool_and(coalesce(gi.issued, 0) <= 0.0005), true) as none_issued
  from sales_order_lines sol
  left join lateral (
    select sum(gil.qty_issued) as issued
    from goods_issue_lines gil
    where gil.so_line_id = sol.id
  ) gi on true
  where sol.sales_order_id = so.id
) s;

grant select on sales_orders_with_status to authenticated;
