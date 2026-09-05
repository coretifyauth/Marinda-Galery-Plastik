-- Keputusan owner (2026-09-05, lanjutan diskusi ar-ap-unify-transactions): Opsi C
-- "Tulis-jadi-Beban" (purchase_writeoffs) di Retur Barang ke Supplier DICABUT TOTAL --
-- demi simetri AR/AP (AR cuma punya 2 jalur resolusi retur: kurangi piutang ATAU ganti
-- barang; AP dulu punya 3: kurangi utang / tukar barang / tulis-jadi-beban). Barang rusak
-- yang supplier tolak kompensasi sekarang dialihkan ke `stock_opname` generic
-- (`record_stock_opname`, sudah ada) -- SENGAJA kehilangan 2 hal yang cuma dipunya
-- `purchase_writeoffs`: traceability ke bill/GRN spesifik, dan guard qty gabungan lintas
-- Opsi A/B/C (`purchase_returned_qty`) -- trade-off yang disadari & diterima demi
-- kesederhanaan struktur, bukan kelalaian.
--
-- Verifikasi sebelum drop: `purchase_writeoffs`/`purchase_writeoff_lines` cuma punya 2
-- baris (data demo), journal_entry_id-nya TETAP UTUH di `journal_entries`/`journal_lines`
-- (gak ikut didrop) -- histori jurnal tetap valid, cuma link balik ke "ini dari
-- write-off nota X" yang hilang.

-- ============================================================
-- 1. Perbaiki view inventory_movements_with_source -- dependent NON-FK ke
--    purchase_writeoffs/purchase_writeoff_lines (cabang label "Barang Rusak
--    (Tulis-jadi-Beban)"). Kolom output gak berubah, cabang COALESCE ini dihapus.
-- ============================================================

create or replace view inventory_movements_with_source as
select im.id,
    im.item_id,
    im.movement_date,
    im.qty,
    im.created_at,
    coalesce(
        case when im.goods_receipt_line_id is not null then 'Pembelian (Terima Barang)'::text else null::text end,
        case when im.production_order_id is not null then 'Produksi (Hasil)'::text else null::text end,
        case when im.inventory_return_line_id is not null then 'Retur dari Customer'::text else null::text end,
        case when im.stock_opname_line_id is not null then 'Penyesuaian Stock Opname'::text else null::text end,
        case when im.goods_issue_line_id is not null then 'Penjualan (Kirim Barang)'::text else null::text end,
        case when im.pos_sale_line_id is not null then 'Penjualan (Kios/POS)'::text else null::text end,
        case when im.production_order_line_id is not null then 'Produksi (Konsumsi Bahan)'::text else null::text end,
        case when im.purchase_return_line_id is not null then 'Retur ke Supplier'::text else null::text end,
        case when im.warranty_replacement_line_id is not null then 'Penggantian Garansi'::text else null::text end,
        case when im.purchase_replacement_line_id is not null then 'Tukar Barang (Retur Supplier)'::text else null::text end
    ) as source_label,
    coalesce(ap_bill.source_ref, prod_header.source_ref, ir.source_ref, so.source_ref, gi.source_ref, ps.source_ref, prod_line_header.source_ref, acn.source_ref, wr.source_ref, pr.source_ref) as source_ref
from inventory_movements im
    left join goods_receipt_lines grl on grl.id = im.goods_receipt_line_id
    left join goods_receipt_notes grn on grn.id = grl.grn_id
    left join transactions ap_bill on ap_bill.id = grn.bill_id
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
    left join warranty_replacement_lines wrl on wrl.id = im.warranty_replacement_line_id
    left join warranty_replacements wr on wr.id = wrl.warranty_replacement_id
    left join purchase_replacement_lines prpl on prpl.id = im.purchase_replacement_line_id
    left join purchase_replacements pr on pr.id = prpl.purchase_replacement_id;

-- ============================================================
-- 2. purchase_returned_qty -- cabut reducer ke-3 (purchase_writeoff_lines), sisa 2
--    (retur + tukar barang). Signature gak berubah.
-- ============================================================

create or replace function purchase_returned_qty(p_bill_id uuid, p_item_id uuid) returns numeric as $$
  select
    coalesce((
      select sum(prl.qty_returned) from purchase_return_lines prl
      join ap_credit_notes acn on acn.id = prl.credit_note_id
      where acn.bill_id = p_bill_id and prl.item_id = p_item_id
    ), 0)
    +
    coalesce((
      select sum(prpl.qty_replaced) from purchase_replacement_lines prpl
      join purchase_replacements prp on prp.id = prpl.purchase_replacement_id
      where prp.bill_id = p_bill_id and prpl.item_id = p_item_id
    ), 0);
$$ language sql stable;

-- ============================================================
-- 3. Drop RPC dead code + trigger yang nempel di tabel yang mau didrop.
-- ============================================================

drop function create_purchase_writeoff(uuid, date, text, jsonb, uuid, uuid);
drop trigger purchase_writeoff_lines_no_over_return_trigger on purchase_writeoff_lines;
drop function purchase_writeoff_lines_no_over_return();

-- ============================================================
-- 4. Drop kolom penghubung di inventory_movements (composite FK ke
--    purchase_writeoff_lines(id, item_id) -- auto ke-drop bareng kolomnya). 2 baris
--    movement histori (demo) kehilangan link spesifik ini, tapi baris movement-nya
--    sendiri TETAP ADA (qty/item/tanggal utuh, cuma source_label-nya jadi kosong).
-- ============================================================

alter table inventory_movements drop column purchase_writeoff_line_id;

-- ============================================================
-- 5. Drop tabel -- anak dulu (baris), baru induk (header).
-- ============================================================

drop table purchase_writeoff_lines;
drop table purchase_writeoffs;
