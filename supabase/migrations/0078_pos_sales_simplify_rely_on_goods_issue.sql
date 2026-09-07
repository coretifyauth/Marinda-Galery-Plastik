-- Sederhanakan pos_sales/pos_sale_lines/pos_sale_extra_credit_lines (bentuk pasca-0076/0077)
-- -- ketiganya sebagian besar isinya DUPLIKASI data yang udah ada di goods_issue_lines/
-- transaction_lines, murni buat kebutuhan tampilan struk. Desain lengkap & histori:
-- memory/scope-debt/pos-sales-simplify-rely-on-goods-issue.md (ditunda 2026-09-06, dieksekusi
-- sekarang atas persetujuan user).
--
-- Perubahan inti: ketiga tabel penanda DIHAPUS TOTAL, gak ada pengganti. Identitas "transaksi
-- ini penjualan kios" sekarang PURE STRUKTURAL (transaksi OUTBOUND + persis 1 goods_issues +
-- persis 1 payments yang melunasi penuh + gak ada retur/DP nempel) -- user eksplisit
-- memutuskan gak perlu bedain asal POS vs AR Invoice manual yang kebetulan bentuknya identik
-- (walk-in counter sale tanpa SO, lunas seketika). unit_price (satu-satunya kolom yang
-- GENUINELY baru, gak ada tempat lain nyimpennya) pindah ke goods_issue_lines.

-- ============================================================
-- 1. Drop 2 view yang JOIN ke tabel yang mau dihapus -- WAJIB duluan, DROP TABLE tanpa
--    CASCADE bakal error "other objects depend on it" kalau view masih hidup.
-- ============================================================
drop view if exists pos_sales_with_status;
drop view if exists inventory_movements_with_source;

-- ============================================================
-- 2. Drop 3 tabel penanda -- urutan anak dulu (FK ke pos_sales(transaction_id)), gak butuh
--    CASCADE (dikonfirmasi: gak ada FK aktif dari tabel lain manapun ke pos_sale_lines/
--    pos_sale_extra_credit_lines bentuk 0076 -- beda dari pos_sale_lines LAMA pra-cutover
--    yang FK-nya dari inventory_movements, itu sudah didrop cascade duluan di 0077).
-- ============================================================
drop table if exists pos_sale_extra_credit_lines;
drop table if exists pos_sale_lines;
drop table if exists pos_sales;

-- ============================================================
-- 3. Drop kolom mati inventory_movements.pos_sale_line_id -- FK-nya udah orphan sejak 0077
--    (nunjuk pos_sale_lines LAMA yang udah gak ada, 0076 gak pernah bikin FK baru ke tabel
--    pengganti). Polymorphic source column 9 -> 8 (memory/scope-debt/
--    inventory-movements-exactly-one-source-constraint.md diupdate terpisah, di luar migration).
-- ============================================================
alter table inventory_movements drop column pos_sale_line_id;

-- ============================================================
-- 4. goods_issue_lines.unit_price -- SATU-SATUNYA kolom genuinely baru (gak ada tempat lain
--    nyimpennya, beda dari qty_issued/item_id yang emang duplikat pos_sale_lines lama).
--    Nullable -- cuma keisi kalau order_line_id NULL (jalur POS/walk-in tanpa SO); kalau ada
--    order_line_id, harga tetap bersumber dari order_lines.unit_price (1 sumber kebenaran,
--    pola sama ar-invoices/[id]/view.tsx).
-- ============================================================
alter table goods_issue_lines add column unit_price numeric(14,2) check (unit_price is null or unit_price >= 0);

-- Mutual exclusivity dengan order_line_id -- kalau ada order_line_id, harga WAJIB bersumber
-- dari order_lines.unit_price (1 sumber kebenaran), bukan dobel-isi di sini. Ketauan review
-- schema-reviewer: tanpa constraint ini gak ada yang nyegah caller masa depan ngisi keduanya
-- sekaligus (caller SEKARANG -- create_pos_sale/goods-issues module -- udah otomatis patuh
-- by convention, tapi convention doang gak cukup di level schema).
alter table goods_issue_lines add constraint goods_issue_lines_unit_price_xor_order_line
  check (unit_price is null or order_line_id is null);

-- ============================================================
-- 5. create_goods_issue -- p_lines dapat 1 key baru opsional "unit_price". Body cuma nambah
--    1 array akumulasi + 1 kolom di insert -- gak ada perubahan ke parameter level fungsi,
--    caller lama (goods-issues module, gak pernah kirim unit_price) otomatis NULL (jsonb ->>
--    key yang gak ada = NULL, bukan error).
-- ============================================================
create or replace function create_goods_issue(
  p_customer_id uuid,
  p_invoice_date date,
  p_description text,
  p_source_ref text,
  p_credit_lines jsonb,
  p_receivable_account_id uuid,
  p_lines jsonb, -- array of {"item_id":uuid,"qty_issued":numeric,"order_line_id":uuid|null,"unit_price":numeric|null}
  p_hpp_account_id uuid,
  p_finished_good_account_id uuid,
  p_apply_tax boolean default false
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_issue_id uuid := gen_random_uuid();
  v_invoice_id uuid;
  v_line jsonb;
  v_item_id uuid;
  v_qty numeric;
  v_order_line_id uuid;
  v_unit_price numeric;
  v_line_cost numeric;
  v_total_cost numeric := 0;
  v_entry_id uuid;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_costs numeric[] := '{}';
  v_line_order_lines uuid[] := '{}';
  v_line_unit_prices numeric[] := '{}';
  i int;
begin
  if exists (
    select 1
    from jsonb_array_elements(p_lines) as l
    join order_lines ol on ol.id = nullif(l->>'order_line_id', '')::uuid
    join orders o on o.id = ol.order_id
    where o.cancelled_at is not null
  ) then
    raise exception 'Salah satu baris menunjuk sales order yang udah dibatalkan';
  end if;

  v_invoice_id := create_transaction(
    'OUTBOUND', p_customer_id, p_invoice_date, p_description, p_source_ref,
    p_credit_lines, p_receivable_account_id, p_apply_tax
  );

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_item_id := (v_line->>'item_id')::uuid;
    v_qty := (v_line->>'qty_issued')::numeric;
    v_order_line_id := nullif(v_line->>'order_line_id', '')::uuid;
    v_unit_price := (v_line->>'unit_price')::numeric;

    v_line_cost := consume_weighted_average(v_item_id, v_qty);

    v_line_items := array_append(v_line_items, v_item_id);
    v_line_qtys := array_append(v_line_qtys, v_qty);
    v_line_costs := array_append(v_line_costs, v_line_cost);
    v_line_order_lines := array_append(v_line_order_lines, v_order_line_id);
    v_line_unit_prices := array_append(v_line_unit_prices, v_unit_price);
    v_total_cost := v_total_cost + v_line_cost;
  end loop;

  v_entry_id := create_journal_entry(
    p_invoice_date, 'HPP ' || p_description, p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_hpp_account_id, 'debit', v_total_cost, 'credit', 0),
      jsonb_build_object('account_id', p_finished_good_account_id, 'debit', 0, 'credit', v_total_cost)
    )
  );

  insert into goods_issues (id, invoice_id, journal_entry_id, issue_date, source_ref, created_by)
  values (v_issue_id, v_invoice_id, v_entry_id, p_invoice_date, p_source_ref, auth.uid());

  for i in 1..array_length(v_line_items, 1) loop
    insert into goods_issue_lines (goods_issue_id, item_id, qty_issued, total_cost, order_line_id, unit_price)
    values (v_issue_id, v_line_items[i], v_line_qtys[i], v_line_costs[i], v_line_order_lines[i], v_line_unit_prices[i]);
  end loop;

  return v_issue_id;
end;
$$;

-- ============================================================
-- 6. create_pos_sale -- DISEDERHANAKAN, signature EKSTERNAL tetap byte-identik (apps/pos
--    nol perubahan alur create). Isinya sekarang CUMA orkestrasi create_goods_issue+
--    record_payment (unit_price diteruskan lewat p_lines ke create_goods_issue) -- semua
--    insert ke pos_sales/pos_sale_lines/pos_sale_extra_credit_lines DIHAPUS (tabelnya udah
--    gak ada). Gak perlu lagi select goods_issue_id balik -- gak ada yang butuh nunjuk ke situ.
-- ============================================================
create or replace function create_pos_sale(
  p_sale_date date,
  p_source_ref text,
  p_customer_id uuid,
  p_cash_account_id uuid,
  p_revenue_account_id uuid,
  p_hpp_account_id uuid,
  p_finished_good_account_id uuid,
  p_lines jsonb, -- array of {"item_id":uuid,"qty_sold":numeric,"unit_price":numeric}
  p_extra_credit_lines jsonb default '[]'::jsonb, -- array of {"account_id":uuid,"amount":numeric}
  p_apply_tax boolean default false
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_customer_id uuid;
  v_receivable_account_id uuid;
  v_line jsonb;
  v_qty numeric;
  v_unit_price numeric;
  v_total_amount numeric := 0;
  v_credit_lines jsonb;
  v_issue_lines jsonb := '[]'::jsonb;
  v_transaction_id uuid;
  v_settle_amount numeric;
begin
  if not exists (
    select 1 from user_roles ur
    where ur.user_id = auth.uid() and ur.role_name in ('admin', 'accountant', 'cashier')
  ) then
    raise exception 'Gak punya akses buat bikin POS Sale';
  end if;

  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'POS sale wajib punya minimal 1 baris item';
  end if;

  v_customer_id := p_customer_id;
  if v_customer_id is null then
    select walk_in_customer_id into v_customer_id from pos_settings where id = true;
    if v_customer_id is null then
      raise exception 'pos_settings.walk_in_customer_id belum diset -- hubungi admin';
    end if;
  end if;

  select account_id into v_receivable_account_id
    from default_account_settings where role_key = 'ar.receivable';
  if v_receivable_account_id is null then
    raise exception 'default_account_settings ar.receivable belum diset -- hubungi admin';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_qty := (v_line ->> 'qty_sold')::numeric;
    v_unit_price := (v_line ->> 'unit_price')::numeric;

    if v_qty <= 0 then
      raise exception 'qty_sold harus > 0';
    end if;
    if v_unit_price < 0 then
      raise exception 'unit_price gak boleh negatif';
    end if;

    v_total_amount := v_total_amount + v_qty * v_unit_price;

    v_issue_lines := v_issue_lines || jsonb_build_array(
      jsonb_build_object(
        'item_id', v_line ->> 'item_id',
        'qty_issued', v_qty,
        'order_line_id', null,
        'unit_price', v_unit_price
      )
    );
  end loop;

  v_credit_lines := jsonb_build_array(
    jsonb_build_object('account_id', p_revenue_account_id, 'amount', v_total_amount)
  );

  if p_extra_credit_lines is not null and jsonb_array_length(p_extra_credit_lines) > 0 then
    for v_line in select * from jsonb_array_elements(p_extra_credit_lines)
    loop
      if (v_line ->> 'amount')::numeric <= 0 then
        raise exception 'Nominal baris biaya tambahan harus > 0';
      end if;
      v_credit_lines := v_credit_lines || jsonb_build_array(
        jsonb_build_object('account_id', v_line ->> 'account_id', 'amount', (v_line ->> 'amount')::numeric)
      );
    end loop;
  end if;

  v_transaction_id := create_goods_issue(
    v_customer_id, p_sale_date, 'Penjualan POS', p_source_ref,
    v_credit_lines, v_receivable_account_id,
    v_issue_lines, p_hpp_account_id, p_finished_good_account_id,
    p_apply_tax
  );

  -- Lunasi SELURUH outstanding seketika (bukan v_total_amount -- pakai amount asli hasil
  -- create_transaction, karena itu udah termasuk PPN kalau p_apply_tax, dihitung 1 tempat
  -- doang biar gak ada 2 sumber kebenaran buat angka pajak).
  select amount into v_settle_amount from transactions where id = v_transaction_id;

  perform record_payment(
    'OUTBOUND', v_customer_id, p_sale_date, v_settle_amount, p_source_ref,
    p_cash_account_id, v_receivable_account_id, v_transaction_id
  );

  return v_transaction_id;
end;
$$;

-- ============================================================
-- 7. void_pos_transaction -- SENGAJA TIDAK generik. Cari goods_issue/payment LANGSUNG lewat
--    FK yang udah ada (goods_issues.invoice_id, payments.transaction_id), gak butuh tabel
--    penanda apa pun lagi. Guard eksplisit persis kriteria "pola penjualan kios sederhana"
--    (persis 1 goods_issue + persis 1 payment yang melunasi PENUH, gak ada retur/DP nempel)
--    -- kalau gak match, suruh pakai cancel_ar_invoice/mekanisme manual (RPC ini BUKAN
--    reverse_transaction generik, lihat memory/scope-debt/generic-transaction-reversal.md).
-- ============================================================
create or replace function void_pos_transaction(
  p_transaction_id uuid,
  p_entry_date date,
  p_source_ref text
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_transaction_amount numeric;
  v_transaction_journal_entry_id uuid;
  v_goods_issue_id uuid;
  v_goods_issue_journal_entry_id uuid;
  v_payment_journal_entry_id uuid;
  v_payment_amount numeric;
  v_goods_issue_count int;
  v_payment_count int;
  v_return_count int;
  v_deposit_count int;
  v_already_voided boolean;
  v_new_entry_id uuid;
  v_line record;
begin
  select amount, journal_entry_id into v_transaction_amount, v_transaction_journal_entry_id
    from transactions where id = p_transaction_id and type = 'OUTBOUND';
  if not found then
    raise exception 'Transaksi % bukan penjualan (OUTBOUND)', p_transaction_id;
  end if;

  select count(*) into v_goods_issue_count from goods_issues where invoice_id = p_transaction_id;
  select count(*) into v_payment_count from payments where transaction_id = p_transaction_id and type = 'OUTBOUND';
  select count(*) into v_return_count from returns where transaction_id = p_transaction_id;
  select count(*) into v_deposit_count from deposit_applications where transaction_id = p_transaction_id;

  if v_goods_issue_count != 1 or v_payment_count != 1 or v_return_count > 0 or v_deposit_count > 0 then
    raise exception
      'Transaksi % bukan pola penjualan kios sederhana (wajib persis 1 goods issue + 1 payment lunas penuh, tanpa retur/DP) -- pakai cancel_ar_invoice',
      p_transaction_id;
  end if;

  select id, journal_entry_id into v_goods_issue_id, v_goods_issue_journal_entry_id
    from goods_issues where invoice_id = p_transaction_id;

  select journal_entry_id, amount into v_payment_journal_entry_id, v_payment_amount
    from payments where transaction_id = p_transaction_id and type = 'OUTBOUND';

  if v_payment_amount != v_transaction_amount then
    raise exception
      'Transaksi % -- payment gak melunasi penuh (bayar %, total %) -- pakai cancel_ar_invoice',
      p_transaction_id, v_payment_amount, v_transaction_amount;
  end if;

  select exists (
    select 1 from journal_entries je where je.reverses_entry_id = v_transaction_journal_entry_id
  ) into v_already_voided;

  if v_already_voided then
    raise exception 'Transaksi % udah pernah dibatalkan', p_transaction_id;
  end if;

  -- Urutan: payment dulu (Kas<->Piutang), goods_issue (HPP<->Persediaan), baru
  -- transaction (Piutang<->Pendapatan) -- reverse_journal_entry gak peduli urutan
  -- (masing-masing independen), tapi urutan ini paling gampang dibaca di riwayat jurnal.
  perform reverse_journal_entry(v_payment_journal_entry_id, p_entry_date, p_source_ref);
  perform reverse_journal_entry(v_goods_issue_journal_entry_id, p_entry_date, p_source_ref);
  v_new_entry_id := reverse_journal_entry(v_transaction_journal_entry_id, p_entry_date, p_source_ref);

  update inventory_balances ib
    set qty_on_hand = ib.qty_on_hand + agg.qty_issued,
        updated_at = now()
    from (
      select item_id, sum(qty_issued) as qty_issued
      from goods_issue_lines
      where goods_issue_id = v_goods_issue_id
      group by item_id
    ) agg
    where ib.item_id = agg.item_id;

  for v_line in select id, item_id, qty_issued from goods_issue_lines where goods_issue_id = v_goods_issue_id loop
    insert into inventory_movements (item_id, movement_date, qty, goods_issue_line_id)
    values (v_line.item_id, p_entry_date, v_line.qty_issued, v_line.id);
  end loop;

  return v_new_entry_id;
end;
$$;

-- ============================================================
-- 8. pos_sales_with_status -- single-source, PURE STRUKTURAL (gak ada tabel penanda lagi).
--    Kolom publik TIDAK berubah (apps/erp/src/lib/pos-sales/*.ts gak perlu berubah) --
--    cash_account_id/code/name sekarang dibaca dari baris debit jurnal payment (record_payment
--    selalu tulis persis 2 baris: debit kas, kredit kontrol), bukan kolom disalin pos_sales.
-- ============================================================
create view pos_sales_with_status
  with (security_invoker = true) as
select
  t.id,
  t.date as sale_date,
  t.source_ref,
  t.journal_entry_id as revenue_journal_entry_id,
  t.amount as total,
  case when t.status = 'lunas' then 'normal' else t.status end as status,
  t.counterparty_id as customer_id,
  c.name as customer_name,
  cash_jl.account_id as cash_account_id,
  ca.code as cash_account_code,
  ca.name as cash_account_name
from transactions t
  join goods_issues gi on gi.invoice_id = t.id
  join payments pay on pay.transaction_id = t.id and pay.type = 'OUTBOUND' and pay.amount = t.amount
  left join journal_lines cash_jl on cash_jl.journal_entry_id = pay.journal_entry_id and cash_jl.debit > 0
  left join counterparties c on c.id = t.counterparty_id
  left join accounts ca on ca.id = cash_jl.account_id
where t.type = 'OUTBOUND'
  and not exists (select 1 from goods_issues gi2 where gi2.invoice_id = t.id and gi2.id <> gi.id)
  and not exists (
    select 1 from payments p2 where p2.transaction_id = t.id and p2.type = 'OUTBOUND' and p2.id <> pay.id
  )
  and not exists (select 1 from returns r where r.transaction_id = t.id)
  and not exists (select 1 from deposit_applications da where da.transaction_id = t.id);

grant select on pos_sales_with_status to authenticated;

-- ============================================================
-- 9. inventory_movements_with_source -- dibikin ulang tanpa cabang pos_sale_line_id (kolom
--    udah didrop bagian 3) -- dipakai laporan Kartu Stok buat SEMUA jenis mutasi, bukan cuma
--    POS. KOREKSI vs asumsi awal (ketauan review schema-reviewer, ditelusuri balik ke
--    0050_inventory_movements_goods_issue_pos_sale.sql): baris historis pra-cutover yang
--    pos_sale_line_id-nya keisi TIDAK PERNAH ikut ngisi goods_issue_line_id (exactly-one-source
--    invariant emang berlaku gitu di titik insert dulu) -- begitu kolomnya kehapus, baris itu
--    gak jatuh ke cabang goods_issue_line_id manapun, source_label-nya jadi NULL total (bukan
--    fallback ke label generic "Penjualan (Kirim Barang)" kayak dugaan awal). Konsekuensinya
--    cuma kosmetik di laporan Kartu Stok buat baris historis SANGAT lama (pra-0076, jurnal GL-nya
--    sendiri gak kesentuh) -- diterima sebagai bagian dari keputusan "data lama gak diprioritaskan"
--    yang sama yang udah dibuat user pas 0077 (hapus permanen pos_sales lama). Ditambah
--    security_invoker = true yang keabsenan sejak 0077 (ketauan review, gak menyebabkan bug --
--    semua RLS select di tabel yang di-JOIN broad "authenticated", diverifikasi -- tapi dibenerin
--    sekalian selagi view ini ditulis ulang, konsisten pola pos_sales_with_status).
-- ============================================================
create view inventory_movements_with_source
  with (security_invoker = true) as
select
  im.id,
  im.item_id,
  im.movement_date,
  im.qty,
  im.created_at,
  coalesce(
    case when im.goods_receipt_line_id is not null then 'Pembelian (Terima Barang)' else null end,
    case when im.production_order_id is not null then 'Produksi (Hasil)' else null end,
    case when im.return_line_id is not null and rl.type = 'INBOUND' then 'Retur dari Customer' else null end,
    case when im.stock_opname_line_id is not null then 'Penyesuaian Stock Opname' else null end,
    case when im.goods_issue_line_id is not null then 'Penjualan (Kirim Barang)' else null end,
    case when im.production_order_line_id is not null then 'Produksi (Konsumsi Bahan)' else null end,
    case when im.return_line_id is not null and rl.type = 'OUTBOUND' then 'Retur ke Supplier' else null end,
    case when im.warranty_replacement_line_id is not null then 'Penggantian Garansi' else null end,
    case when im.purchase_replacement_line_id is not null then 'Tukar Barang (Retur Supplier)' else null end
  ) as source_label,
  coalesce(ap_bill.source_ref, prod_header.source_ref, r.source_ref, so.source_ref, gi.source_ref, prod_line_header.source_ref, wr.source_ref, pr.source_ref) as source_ref
from inventory_movements im
  left join goods_receipt_lines grl on grl.id = im.goods_receipt_line_id
  left join goods_receipt_notes grn on grn.id = grl.grn_id
  left join transactions ap_bill on ap_bill.id = grn.bill_id
  left join production_orders prod_header on prod_header.id = im.production_order_id
  left join return_lines rl on rl.id = im.return_line_id
  left join returns r on r.id = rl.return_id
  left join stock_opname_lines sol on sol.id = im.stock_opname_line_id
  left join stock_opnames so on so.id = sol.stock_opname_id
  left join goods_issue_lines gil on gil.id = im.goods_issue_line_id
  left join goods_issues gi on gi.id = gil.goods_issue_id
  left join production_order_lines pol on pol.id = im.production_order_line_id
  left join production_orders prod_line_header on prod_line_header.id = pol.production_order_id
  left join warranty_replacement_lines wrl on wrl.id = im.warranty_replacement_line_id
  left join warranty_replacements wr on wr.id = wrl.warranty_replacement_id
  left join purchase_replacement_lines prpl on prpl.id = im.purchase_replacement_line_id
  left join purchase_replacements pr on pr.id = prpl.purchase_replacement_id;

grant select on inventory_movements_with_source to authenticated;
