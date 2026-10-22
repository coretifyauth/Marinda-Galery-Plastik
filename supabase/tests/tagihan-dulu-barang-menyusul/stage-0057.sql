\set ON_ERROR_STOP on
-- Dijalankan SETELAH 0057 (dan test-0057.sql) di database LOKAL, SEBELUM 0058: snapshot data untuk dibandingkan.
drop schema if exists snap57 cascade;
create schema snap57;
create table snap57.goods_notes as
  select id, type, order_id, transaction_id, journal_entry_id, delivery_note_ref, source_ref, note_date, created_by, created_at, counterparty_id from goods_notes;
create table snap57.goods_note_lines as select * from goods_note_lines;
create table snap57.goods_note_cancellations as select * from goods_note_cancellations;
create table snap57.inventory_balances as select item_id, qty_on_hand, avg_cost from inventory_balances;
create table snap57.inventory_movements as select * from inventory_movements;
create table snap57.transactions as select id, type, counterparty_id, amount, outstanding, status, origin, journal_entry_id from transactions;
create table snap57.journal_lines as select * from journal_lines;
create table snap57.deposits as select id, type, counterparty_id, amount, journal_entry_id from deposits;
create table snap57.bill_pool_releases as select * from bill_pool_releases;
create table snap57.counts as
  select (select count(*) from goods_note_billings) as billings,
         (select count(*) from goods_note_billing_allocations) as allocations,
         (select count(*) from goods_note_revisions) as revisions,
         (select count(*) from goods_notes where type = 'INBOUND') as inbound,
         (select count(*) from app_default_account_settings where role_key = 'inventory.goods_received_not_invoiced') as old_role;
select * from snap57.counts;
