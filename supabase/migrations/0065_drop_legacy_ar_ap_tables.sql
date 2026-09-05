-- Fase 3 langkah 8 (memory/scope-debt/ar-ap-unify-transactions.md) -- akhir dari jeda
-- observasi migration 0064: drop beneran tabel lama ar_invoices/ap_bills/
-- ar_invoice_credit_lines/ap_bill_debit_lines/ar_bad_debt_writeoffs (sebelumnya cuma
-- dibekukan, gak ada lagi jalur baca/tulis ke situ sejak 0064 push). Sekaligus tuntasin
-- pencabutan Credit Hold: RPC create_ar_invoice/create_ap_bill (dead code) didrop, kolom
-- counterparties.credit_limit/overdue_threshold_days didrop (gak ada lagi yang enforce).
--
-- Verifikasi sebelum apply (dijalanin manual lewat `supabase db query --linked`):
-- - Satu-satunya dependent FK yang tersisa ke 5 tabel ini adalah 3 tabel yang SAMA-SAMA
--   didrop di migration ini (ar_bad_debt_writeoffs -> ar_invoices, ar_invoice_credit_lines
--   -> ar_invoices, ap_bill_debit_lines -> ap_bills) -- gak ada tabel LIVE lain yang masih
--   nunjuk ke sini (semua udah direpoint ke transactions di 0064).
-- - 1 view non-FK ketauan masih depend: inventory_movements_with_source join ap_bills buat
--   source_ref label "Pembelian (Terima Barang)" -- diperbaiki di bagian 1 di bawah SEBELUM
--   ap_bills didrop, kalau enggak DROP TABLE bakal gagal "cannot drop table ap_bills because
--   other objects depend on it".
-- - Grep pg_proc.prosrc buat semua fungsi live yang masih nyebut ke-5 nama tabel ini --
--   hasilnya persis fungsi yang ditangani bagian 2-4 di bawah, gak ada yang kelewat.

-- ============================================================
-- 1. Perbaiki view inventory_movements_with_source -- satu-satunya dependent NON-FK ke
--    ap_bills yang ketemu. Kolom/urutan output gak berubah, cuma JOIN target-nya.
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
        case when im.purchase_writeoff_line_id is not null then 'Barang Rusak (Tulis-jadi-Beban)'::text else null::text end,
        case when im.warranty_replacement_line_id is not null then 'Penggantian Garansi'::text else null::text end,
        case when im.purchase_replacement_line_id is not null then 'Tukar Barang (Retur Supplier)'::text else null::text end
    ) as source_label,
    coalesce(ap_bill.source_ref, prod_header.source_ref, ir.source_ref, so.source_ref, gi.source_ref, ps.source_ref, prod_line_header.source_ref, acn.source_ref, pw.source_ref, wr.source_ref, pr.source_ref) as source_ref
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
    left join purchase_writeoff_lines pwl on pwl.id = im.purchase_writeoff_line_id
    left join purchase_writeoffs pw on pw.id = pwl.purchase_writeoff_id
    left join warranty_replacement_lines wrl on wrl.id = im.warranty_replacement_line_id
    left join warranty_replacements wr on wr.id = wrl.warranty_replacement_id
    left join purchase_replacement_lines prpl on prpl.id = im.purchase_replacement_line_id
    left join purchase_replacements pr on pr.id = prpl.purchase_replacement_id;

-- ============================================================
-- 2. ar_invoice_remaining/cancel_ar_invoice -- cabut reducer/guard ar_bad_debt_writeoffs
--    beneran (ditunda di 0064 karena tabelnya masih ada, sekarang tabelnya didrop bagian 5).
-- ============================================================

create or replace function ar_invoice_remaining(p_invoice_id uuid) returns numeric as $$
  select ai.amount
    - coalesce((
        select sum(amount) from ar_payments where invoice_id = p_invoice_id
      ), 0)
    - coalesce((
        select sum(amount) from ar_credit_notes where invoice_id = p_invoice_id
      ), 0)
    - coalesce((
        select sum(ada.amount) from ar_deposit_applications ada
        where ada.invoice_id = p_invoice_id
          and not exists (
            select 1 from journal_entries je where je.reverses_entry_id = ada.journal_entry_id
          )
      ), 0)
    + coalesce((
        select sum(arc.amount) from ar_return_credits arc
        join ar_credit_notes acn on acn.id = arc.credit_note_id
        where acn.invoice_id = p_invoice_id
      ), 0)
    + coalesce((
        select sum(wr.discount_reversed_amount - wr.return_credit_settled_amount)
        from warranty_replacements wr
        join ar_credit_notes cn on cn.id = wr.credit_note_id
        where cn.invoice_id = p_invoice_id
      ), 0)
  from transactions ai
  where ai.id = p_invoice_id;
$$ language sql stable;

create or replace function cancel_ar_invoice(
  p_invoice_id uuid,
  p_entry_date date,
  p_source_ref text
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_paid_count int;
  v_original_entry_id uuid;
  v_new_entry_id uuid;
  v_application record;
  v_invoice_ref text;
begin
  select count(*) into v_paid_count
  from ar_payments where invoice_id = p_invoice_id;

  if v_paid_count > 0 then
    select source_ref into v_invoice_ref from transactions where id = p_invoice_id;
    raise exception 'Invoice % udah punya payment — gak bisa dibatalkan lewat jalur ini', v_invoice_ref;
  end if;

  select journal_entry_id into v_original_entry_id from transactions where id = p_invoice_id;

  v_new_entry_id := reverse_journal_entry(v_original_entry_id, p_entry_date, p_source_ref);

  for v_application in
    select ada.journal_entry_id
    from ar_deposit_applications ada
    where ada.invoice_id = p_invoice_id
      and not exists (
        select 1 from journal_entries je where je.reverses_entry_id = ada.journal_entry_id
      )
  loop
    perform reverse_journal_entry(v_application.journal_entry_id, p_entry_date, p_source_ref);
  end loop;

  return v_new_entry_id;
end;
$$;

-- ============================================================
-- 3. Drop RPC lama yang jadi dead code sejak 0064 (nothing calls these anymore --
--    create_goods_issue/create_goods_receipt + 2 form frontend udah pindah ke
--    create_transaction).
-- ============================================================

drop function create_ar_invoice(uuid, date, text, text, jsonb, uuid, boolean);
drop function create_ap_bill(uuid, date, text, text, jsonb, uuid, boolean, text);

-- ============================================================
-- 4. Drop tabel lama -- urutan anak dulu (ar_bad_debt_writeoffs, ar_invoice_credit_lines,
--    ap_bill_debit_lines masih FK ke ar_invoices/ap_bills, belum direpoint di 0064 karena
--    ketiganya SENGAJA ikut dihapus, bukan direpoint), baru induk (ar_invoices, ap_bills).
--    Trigger yang nempel di ke-5 tabel ini (termasuk block_edit_delete/set_defaults/
--    counterparty_role_guard) OTOMATIS ke-drop bareng tabelnya -- fungsi standalone-nya
--    (yang bukan "dimiliki" tabel) baru bisa didrop SETELAH ini, lihat bagian 5.
-- ============================================================

drop table ar_bad_debt_writeoffs;
drop table ar_invoice_credit_lines;
drop table ap_bill_debit_lines;
drop table ar_invoices;
drop table ap_bills;

-- ============================================================
-- 5. Drop fungsi standalone yang tadinya nempel di ar_invoices/ap_bills (sekarang orphan
--    sejak trigger-nya ikut hilang bareng bagian 4 di atas). block_edit_delete() dan
--    counterparty_role_guard() TIDAK didrop -- dipakai bareng banyak tabel lain yang
--    masih hidup.
-- ============================================================

drop function ar_invoices_block_edit_delete_or_sync();
drop function ar_invoices_set_defaults();
drop function ap_bills_block_edit_delete_or_sync();
drop function ap_bills_set_defaults();

-- ============================================================
-- 6. Tuntasin pencabutan Credit Hold: kolom counterparties.credit_limit/
--    overdue_threshold_days didrop (gak ada lagi yang enforce/baca sejak create_ar_invoice
--    lama didrop bagian 3). create_counterparty signature berubah (2 param di akhir
--    dicabut) -- wajib drop function dulu (bukan cuma create or replace) biar Postgres
--    gak bikin overload ambigu, konvensi wajib project ini.
-- ============================================================

drop function create_counterparty(text, text, text, integer, numeric, integer);

create function create_counterparty(
  p_name text,
  p_role text,
  p_contact text default null,
  p_payment_term_days integer default 7
) returns uuid
language plpgsql
as $$
declare
  v_id uuid;
begin
  if p_role not in ('customer', 'supplier') then
    raise exception 'role harus customer atau supplier, dikasih: %', p_role;
  end if;

  insert into counterparties (name, contact, payment_term_days)
  values (p_name, p_contact, p_payment_term_days)
  returning id into v_id;

  insert into counterparty_type_mapping (counterparty_id, role) values (v_id, p_role);

  return v_id;
end;
$$;

alter table counterparties
  drop column credit_limit,
  drop column overdue_threshold_days;
