-- Kartu Stok — layer baca (view + opening-balance RPC), prasyarat sebelum API/UI. Lihat
-- memory/architecture/data/inventory-schema.md submodule "Kartu Stok / Riwayat Mutasi per Item".

-- ============================================================================
-- 1. inventory_movements_with_source — view baca, terjemahkan 11 kolom sumber jadi label+ref
-- ============================================================================
-- Halaman kartu stok cuma perlu 1 label manusiawi ("Pembelian", "Retur ke Supplier", dst) + 1
-- nomor dokumen (source_ref) buat ditampilkan per baris -- bukan 11 kolom FK mentah. View ini
-- LEFT JOIN ke semua 11 jalur sumber sekaligus (tiap baris cuma 1 dari 11 yang match, sisanya
-- NULL karena FK sumbernya sendiri juga NULL di baris itu) lalu COALESCE jadi 2 kolom hasil.
-- Semua JOIN lewat primary key (id) yang sudah terindeks otomatis -- murah per baris.
--
-- goods_receipt_notes gak punya source_ref sendiri (beda dari 10 tabel header lain) -- nomor
-- dokumennya diambil dari ap_bills.source_ref (GRN+Bill dibuat bersamaan, lihat submodule
-- "Purchase Order & Penerimaan Barang").

create or replace view inventory_movements_with_source
  with (security_invoker = true) as
select
  im.id,
  im.item_id,
  im.movement_date,
  im.qty,
  im.created_at,
  coalesce(
    case when im.goods_receipt_line_id is not null then 'Pembelian (Terima Barang)' end,
    case when im.production_order_id is not null then 'Produksi (Hasil)' end,
    case when im.inventory_return_line_id is not null then 'Retur dari Customer' end,
    case when im.stock_opname_line_id is not null then 'Penyesuaian Stock Opname' end,
    case when im.goods_issue_line_id is not null then 'Penjualan (Kirim Barang)' end,
    case when im.pos_sale_line_id is not null then 'Penjualan (Kios/POS)' end,
    case when im.production_order_line_id is not null then 'Produksi (Konsumsi Bahan)' end,
    case when im.purchase_return_line_id is not null then 'Retur ke Supplier' end,
    case when im.purchase_writeoff_line_id is not null then 'Barang Rusak (Tulis-jadi-Beban)' end,
    case when im.warranty_replacement_line_id is not null then 'Penggantian Garansi' end,
    case when im.purchase_replacement_line_id is not null then 'Tukar Barang (Retur Supplier)' end
  ) as source_label,
  coalesce(
    ap_bill.source_ref,
    prod_header.source_ref,
    ir.source_ref,
    so.source_ref,
    gi.source_ref,
    ps.source_ref,
    prod_line_header.source_ref,
    acn.source_ref,
    pw.source_ref,
    wr.source_ref,
    pr.source_ref
  ) as source_ref
from inventory_movements im
left join goods_receipt_lines grl on grl.id = im.goods_receipt_line_id
left join goods_receipt_notes grn on grn.id = grl.grn_id
left join ap_bills ap_bill on ap_bill.id = grn.bill_id
left join production_orders prod_header on prod_header.id = im.production_order_id
left join inventory_return_lines irl on irl.id = im.inventory_return_line_id
left join inventory_returns ir on ir.id = irl.inventory_return_id
left join stock_opname_lines sol on sol.id = im.stock_opname_line_id
left join stock_opnames so on so.id = sol.stock_opname_id
left join goods_issue_lines gil on gil.id = im.goods_issue_line_id
left join goods_issues gi on gi.id = gil.goods_issue_id
left join pos_sale_lines psl on psl.id = im.pos_sale_line_id
left join pos_sales ps on ps.id = psl.pos_sale_id
left join production_order_lines pol on pol.id = im.production_order_line_id
left join production_orders prod_line_header on prod_line_header.id = pol.production_order_id
left join purchase_return_lines prl on prl.id = im.purchase_return_line_id
left join ap_credit_notes acn on acn.id = prl.credit_note_id
left join purchase_writeoff_lines pwl on pwl.id = im.purchase_writeoff_line_id
left join purchase_writeoffs pw on pw.id = pwl.purchase_writeoff_id
left join warranty_replacement_lines wrl on wrl.id = im.warranty_replacement_line_id
left join warranty_replacements wr on wr.id = wrl.warranty_replacement_id
left join purchase_replacement_lines prpl on prpl.id = im.purchase_replacement_line_id
left join purchase_replacements pr on pr.id = prpl.purchase_replacement_id;

grant select on inventory_movements_with_source to authenticated;

-- ============================================================================
-- 2. report_item_movement_opening_balance — mirror persis report_account_ledger_opening_balance
-- ============================================================================
-- Pola SAMA PERSIS General Ledger (supabase/migrations/0041_report_account_ledger_opening_balance_rpc.sql):
-- p_before_offset = jumlah baris SEBELUM halaman yang lagi ditampilkan, dalam urutan
-- (movement_date, id) -- urutan ini HARUS PERSIS SAMA dengan .order() yang dipakai query
-- halaman kartu stok-nya sendiri, kalau enggak offset-nya gak nyambung dan saldo berjalan bisa
-- salah tanpa error apa pun (pelajaran yang sama dari memory/scope-debt/
-- journal-lines-unbounded-aggregate.md, sudah Selesai, dipakai lagi di sini).

create or replace function report_item_movement_opening_balance(
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
