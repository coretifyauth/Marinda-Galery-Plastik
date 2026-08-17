-- Index buat sort/filter by tanggal transaksi di halaman list modul AR/AP/inventory/POS,
-- lanjutan dari pola journal_entries (0029) -- rollout server-side pagination+filter ke
-- semua modul ERP, lihat memory/architecture/app/tech-stack-decisions.md.
-- Semua kolom di bawah sebelumnya gak punya index sama sekali.

create index ar_invoices_invoice_date_idx on ar_invoices(invoice_date desc);
create index ap_bills_bill_date_idx on ap_bills(bill_date desc);
create index ar_deposits_deposit_date_idx on ar_deposits(deposit_date desc);
create index ap_deposits_deposit_date_idx on ap_deposits(deposit_date desc);
create index sales_orders_so_date_idx on sales_orders(so_date desc);
create index purchase_orders_po_date_idx on purchase_orders(po_date desc);
create index pos_sales_sale_date_idx on pos_sales(sale_date desc);
create index goods_receipt_notes_receipt_date_idx on goods_receipt_notes(receipt_date desc);
create index goods_issues_issue_date_idx on goods_issues(issue_date desc);
create index production_orders_production_date_idx on production_orders(production_date desc);
create index stock_opnames_opname_date_idx on stock_opnames(opname_date desc);
