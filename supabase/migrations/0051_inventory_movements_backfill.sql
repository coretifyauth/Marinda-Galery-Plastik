-- Kartu Stok — backfill data historis + rekonsiliasi. Terakhir dari seluruh rangkaian
-- inventory_movements (schema 0042, RPC 0043-0050). Lihat memory/architecture/data/
-- inventory-schema.md submodule "Kartu Stok / Riwayat Mutasi per Item".
--
-- Urutan 11 INSERT...SELECT di bawah TIDAK PENTING (independen satu sama lain) -- saldo berjalan
-- derived (opening-balance + halaman, bukan kolom tersimpan), jadi SUM(qty) hasilnya sama apa pun
-- urutan baris di-insert, yang penting cuma movement_date tiap baris benar (diambil dari tanggal
-- transaksi ASLI di tabel header masing-masing, bukan created_at/now()).
--
-- Tiap INSERT dijaga `where not exists (...)` terhadap kolom penunjuk sumbernya sendiri -- BUKAN
-- basa-basi, ini prasyarat keamanan nyata: RPC 0043-0050 diapply satu-satu ke database LIVE
-- selama sesi ini, jadi ada kemungkinan (walau kecil) transaksi baru sempat lewat salah satu RPC
-- yang sudah diperbaiki SEBELUM migration backfill ini jalan -- baris itu udah punya ledger row
-- dari RPC-nya sendiri, backfill buta bakal dobel-insert kalau gak dijaga.

-- 1. goods_receipt_lines (IN)
insert into inventory_movements (item_id, movement_date, qty, goods_receipt_line_id)
select grl.item_id, grn.receipt_date, grl.qty_received, grl.id
from goods_receipt_lines grl
join goods_receipt_notes grn on grn.id = grl.grn_id
where not exists (select 1 from inventory_movements im where im.goods_receipt_line_id = grl.id);

-- 2. production_orders header (IN, hasil produksi)
insert into inventory_movements (item_id, movement_date, qty, production_order_id)
select po.item_id, po.production_date, po.qty_produced, po.id
from production_orders po
where not exists (select 1 from inventory_movements im where im.production_order_id = po.id);

-- 3. inventory_return_lines kondisi RESALABLE saja (IN) -- DAMAGED gak pernah masuk ledger,
--    konsisten sama inventory_balances yang juga gak pernah disentuh kondisi itu.
insert into inventory_movements (item_id, movement_date, qty, inventory_return_line_id)
select irl.item_id, ir.return_date, irl.qty_returned, irl.id
from inventory_return_lines irl
join inventory_returns ir on ir.id = irl.inventory_return_id
where irl.condition = 'RESALABLE'
  and not exists (select 1 from inventory_movements im where im.inventory_return_line_id = irl.id);

-- 4. stock_opname_lines (IN/OUT tergantung tanda variance -- tabel sumbernya sendiri udah
--    dijamin qty_actual <> qty_system lewat check constraint, gak ada baris variance nol yang
--    perlu difilter di sini).
insert into inventory_movements (item_id, movement_date, qty, stock_opname_line_id)
select sol.item_id, so.opname_date, sol.qty_actual - sol.qty_system, sol.id
from stock_opname_lines sol
join stock_opnames so on so.id = sol.stock_opname_id
where not exists (select 1 from inventory_movements im where im.stock_opname_line_id = sol.id);

-- 5. goods_issue_lines (OUT, terjual)
insert into inventory_movements (item_id, movement_date, qty, goods_issue_line_id)
select gil.item_id, gi.issue_date, -gil.qty_issued, gil.id
from goods_issue_lines gil
join goods_issues gi on gi.id = gil.goods_issue_id
where not exists (select 1 from inventory_movements im where im.goods_issue_line_id = gil.id);

-- 6. pos_sale_lines (OUT, terjual lewat kios)
insert into inventory_movements (item_id, movement_date, qty, pos_sale_line_id)
select psl.item_id, ps.sale_date, -psl.qty_sold, psl.id
from pos_sale_lines psl
join pos_sales ps on ps.id = psl.pos_sale_id
where not exists (select 1 from inventory_movements im where im.pos_sale_line_id = psl.id);

-- 7. production_order_lines (OUT, bahan baku dikonsumsi)
insert into inventory_movements (item_id, movement_date, qty, production_order_line_id)
select pol.item_id, po.production_date, -pol.qty_consumed, pol.id
from production_order_lines pol
join production_orders po on po.id = pol.production_order_id
where not exists (select 1 from inventory_movements im where im.production_order_line_id = pol.id);

-- 8. purchase_return_lines (OUT, retur ke supplier)
insert into inventory_movements (item_id, movement_date, qty, purchase_return_line_id)
select prl.item_id, acn.credit_note_date, -prl.qty_returned, prl.id
from purchase_return_lines prl
join ap_credit_notes acn on acn.id = prl.credit_note_id
where not exists (select 1 from inventory_movements im where im.purchase_return_line_id = prl.id);

-- 9. purchase_writeoff_lines (OUT, barang rusak ditulis-jadi-beban)
insert into inventory_movements (item_id, movement_date, qty, purchase_writeoff_line_id)
select pwl.item_id, pw.writeoff_date, -pwl.qty_written_off, pwl.id
from purchase_writeoff_lines pwl
join purchase_writeoffs pw on pw.id = pwl.purchase_writeoff_id
where not exists (select 1 from inventory_movements im where im.purchase_writeoff_line_id = pwl.id);

-- 10. warranty_replacement_lines (OUT, penggantian garansi)
insert into inventory_movements (item_id, movement_date, qty, warranty_replacement_line_id)
select wrl.item_id, wr.replacement_date, -wrl.qty_replaced, wrl.id
from warranty_replacement_lines wrl
join warranty_replacements wr on wr.id = wrl.warranty_replacement_id
where not exists (select 1 from inventory_movements im where im.warranty_replacement_line_id = wrl.id);

-- 11. purchase_replacement_lines -- SATU-SATUNYA sumber 1 baris = 2 baris ledger (OUT barang
--     rusak + IN barang pengganti, item & qty sama, tanda berlawanan). Guard NOT EXISTS dipisah
--     per tanda (qty<0 vs qty>0) supaya masing-masing independen -- backfill gak berhenti cuma
--     karena salah satu dari 2 baris itu udah keburu ada dari RPC 0046 yang sempat jalan duluan.
insert into inventory_movements (item_id, movement_date, qty, purchase_replacement_line_id)
select prl.item_id, pr.replacement_date, -prl.qty_replaced, prl.id
from purchase_replacement_lines prl
join purchase_replacements pr on pr.id = prl.purchase_replacement_id
where not exists (
  select 1 from inventory_movements im where im.purchase_replacement_line_id = prl.id and im.qty < 0
);

insert into inventory_movements (item_id, movement_date, qty, purchase_replacement_line_id)
select prl.item_id, pr.replacement_date, prl.qty_replaced, prl.id
from purchase_replacement_lines prl
join purchase_replacements pr on pr.id = prl.purchase_replacement_id
where not exists (
  select 1 from inventory_movements im where im.purchase_replacement_line_id = prl.id and im.qty > 0
);

-- ============================================================================
-- Rekonsiliasi -- migration GAGAL (rollback total) kalau ada item yang gak cocok
-- ============================================================================
-- Pola sama backfill-check di 0025_item_units_nested_conversion_guard.sql: ketahuan SEKARANG
-- (migration gagal loud) kalau ada bug/data yang kelewat, bukan diam-diam ke-apply lalu baru
-- ketauan belakangan pas user buka kartu stok dan saldo akhirnya beda dari Posisi Persediaan.

do $$
declare
  v_item record;
  v_mismatch_count int := 0;
begin
  for v_item in
    select
      ib.item_id,
      ib.qty_on_hand,
      coalesce(sum(im.qty), 0) as ledger_total
    from inventory_balances ib
    left join inventory_movements im on im.item_id = ib.item_id
    group by ib.item_id, ib.qty_on_hand
    having ib.qty_on_hand <> coalesce(sum(im.qty), 0)
  loop
    v_mismatch_count := v_mismatch_count + 1;
    raise warning 'Item % -- inventory_balances.qty_on_hand=% tapi SUM(inventory_movements.qty)=%',
      v_item.item_id, v_item.qty_on_hand, v_item.ledger_total;
  end loop;

  if v_mismatch_count > 0 then
    raise exception 'Rekonsiliasi backfill inventory_movements GAGAL -- % item gak cocok (lihat WARNING di atas buat detail per-item). Migration di-rollback -- cek data sebelum apply ulang.',
      v_mismatch_count;
  end if;
end $$;
