\set ON_ERROR_STOP on
-- Dijalankan SETELAH 0056 diapply (lokal): meniru kondisi live = 1 barang masuk alur "deferred" yang
-- sudah dibatalkan (tanpa tagihan), lalu mengambil snapshot data untuk dibandingkan setelah 0057.
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated","email":"tester@example.com"}', false);

do $$
declare g uuid;
begin
  g := create_goods_receipt(null, '2026-10-21', 'SJ-DEF-1',
    '[{"order_line_id":"","item_id":"b0000000-0000-0000-0000-0000000000c1","qty_received":5,"unit_cost":7000}]'::jsonb,
    (select id from accounts where code = '1400'), 'a0000000-0000-0000-0000-000000000001', 0);
  perform cancel_goods_receipt(g, '2026-10-22');
end $$;

drop schema if exists snap cascade;
create schema snap;
create table snap.goods_notes as select * from goods_notes;
create table snap.goods_note_lines as select * from goods_note_lines;
create table snap.goods_note_billings as select * from goods_note_billings;
create table snap.goods_note_cancellations as select * from goods_note_cancellations;
create table snap.inventory_balances as select * from inventory_balances;
create table snap.inventory_movements as select * from inventory_movements;
create table snap.transactions as select id, type, counterparty_id, amount, outstanding, status, origin, journal_entry_id from transactions;
create table snap.journal_entries as select id, entry_date, source_ref from journal_entries;
create table snap.journal_lines as select * from journal_lines;
create table snap.gl as select a.code, sum(jl.debit) d, sum(jl.credit) c from journal_lines jl join accounts a on a.id = jl.account_id group by a.code;

select 'inbound_total' k, count(*) from goods_notes where type='INBOUND'
union all select 'bundled', count(*) from goods_notes where inbound_flow='bundled'
union all select 'deferred', count(*) from goods_notes where inbound_flow='deferred'
union all select 'billings', count(*) from goods_note_billings
union all select 'cancellations', count(*) from goods_note_cancellations
union all select 'jurnal_2150', count(*) from journal_lines jl join accounts a on a.id=jl.account_id where a.code='2150';
