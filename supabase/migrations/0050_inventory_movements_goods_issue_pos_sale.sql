-- Kartu Stok — RPC #8, TERAKHIR dari rangkaian bertahap (transaksi paling sering/harian —
-- disentuh paling akhir, setelah pola insert-nya terbukti aman di 7 RPC sebelumnya). Lihat
-- memory/architecture/data/inventory-schema.md submodule "Kartu Stok / Riwayat Mutasi per Item"
-- > "Rencana Bertahap". Menutup rangkaian RPC — sisa pekerjaan cuma backfill data historis +
-- rekonsiliasi.
--
-- Body ASLI kedua fungsi disalin dari definisi TERKINI (create_goods_issue dari
-- 0024_purchase_order_sales_order_cancel.sql, create_pos_sale dari 0009_pos_schema.sql — belum
-- pernah di-CREATE OR REPLACE lagi sejak itu). Signature TETAP SAMA di keduanya. Satu-satunya
-- perubahan: tiap baris goods_issue_lines/pos_sale_lines yang diinsert sekarang diikuti 1 baris
-- inventory_movements (qty negatif — barang jadi KELUAR karena terjual).
--
-- Catatan create_pos_sale: fungsi ini SECURITY DEFINER (satu-satunya di project ini) -- role
-- cashier gak punya akses insert langsung ke inventory_movements (cuma admin/accountant di
-- policy insert-nya, migration 0042), tapi itu gak masalah karena security definer jalan pakai
-- privilege PEMILIK fungsi, bukan privilege caller -- pola yang sama persis kenapa cashier bisa
-- insert ke pos_sales/pos_sale_lines walau gak ada policy insert authenticated buat tabel itu.

create or replace function create_goods_issue(
  p_customer_id uuid,
  p_invoice_date date,
  p_description text,
  p_source_ref text,
  p_credit_lines jsonb,
  p_receivable_account_id uuid,
  p_lines jsonb,
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
  v_so_line_id uuid;
  v_line_cost numeric;
  v_total_cost numeric := 0;
  v_entry_id uuid;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_costs numeric[] := '{}';
  v_line_so_lines uuid[] := '{}';
  i int;
  v_line_id uuid;
begin
  if exists (
    select 1
    from jsonb_array_elements(p_lines) as l
    join sales_order_lines sol on sol.id = nullif(l->>'so_line_id', '')::uuid
    join sales_orders so on so.id = sol.sales_order_id
    where so.cancelled_at is not null
  ) then
    raise exception 'Salah satu baris menunjuk sales order yang udah dibatalkan';
  end if;

  v_invoice_id := create_ar_invoice(
    p_customer_id, p_invoice_date, p_description, p_source_ref,
    p_credit_lines, p_receivable_account_id, p_apply_tax
  );

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_item_id := (v_line->>'item_id')::uuid;
    v_qty := (v_line->>'qty_issued')::numeric;
    v_so_line_id := nullif(v_line->>'so_line_id', '')::uuid;

    v_line_cost := consume_weighted_average(v_item_id, v_qty);

    v_line_items := array_append(v_line_items, v_item_id);
    v_line_qtys := array_append(v_line_qtys, v_qty);
    v_line_costs := array_append(v_line_costs, v_line_cost);
    v_line_so_lines := array_append(v_line_so_lines, v_so_line_id);
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
    insert into goods_issue_lines (goods_issue_id, item_id, qty_issued, total_cost, so_line_id)
    values (v_issue_id, v_line_items[i], v_line_qtys[i], v_line_costs[i], v_line_so_lines[i])
    returning id into v_line_id;

    insert into inventory_movements (item_id, movement_date, qty, goods_issue_line_id)
    values (v_line_items[i], p_invoice_date, -v_line_qtys[i], v_line_id);
  end loop;

  return v_issue_id;
end;
$$;

create or replace function create_pos_sale(
  p_sale_date date,
  p_source_ref text,
  p_customer_id uuid,
  p_cash_account_id uuid,
  p_revenue_account_id uuid,
  p_hpp_account_id uuid,
  p_finished_good_account_id uuid,
  p_lines jsonb, -- array of {"item_id":uuid,"qty_sold":numeric,"unit_price":numeric}
  p_extra_credit_lines jsonb default '[]'::jsonb, -- array of {"account_id":uuid,"amount":numeric} -- packing/ongkir dkk, BUKAN PPN
  p_apply_tax boolean default false
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_line jsonb;
  v_item_id uuid;
  v_qty numeric;
  v_unit_price numeric;
  v_line_amount numeric;
  v_line_cost numeric;
  v_total_amount numeric := 0;
  v_total_cost numeric := 0;
  v_sale_id uuid;
  v_revenue_entry_id uuid;
  v_cogs_entry_id uuid;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_prices numeric[] := '{}';
  v_line_amounts numeric[] := '{}';
  v_line_costs numeric[] := '{}';
  v_extra_amount numeric;
  v_extra_total numeric := 0;
  v_tax_amount numeric := 0;
  v_tax_active boolean;
  v_tax_rate numeric;
  v_tax_account_id uuid;
  v_credit_lines jsonb;
  v_grand_total numeric;
  v_line_id uuid;
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

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_item_id := (v_line ->> 'item_id')::uuid;
    v_qty := (v_line ->> 'qty_sold')::numeric;
    v_unit_price := (v_line ->> 'unit_price')::numeric;

    if v_qty <= 0 then
      raise exception 'qty_sold harus > 0';
    end if;
    if v_unit_price < 0 then
      raise exception 'unit_price gak boleh negatif';
    end if;

    v_line_amount := v_qty * v_unit_price;
    -- consume_weighted_average raise exception sendiri kalau stok gak cukup (no-oversell)
    v_line_cost := consume_weighted_average(v_item_id, v_qty);

    v_total_amount := v_total_amount + v_line_amount;
    v_total_cost := v_total_cost + v_line_cost;

    v_line_items := array_append(v_line_items, v_item_id);
    v_line_qtys := array_append(v_line_qtys, v_qty);
    v_line_prices := array_append(v_line_prices, v_unit_price);
    v_line_amounts := array_append(v_line_amounts, v_line_amount);
    v_line_costs := array_append(v_line_costs, v_line_cost);
  end loop;

  if p_extra_credit_lines is not null and jsonb_array_length(p_extra_credit_lines) > 0 then
    for v_line in select * from jsonb_array_elements(p_extra_credit_lines)
    loop
      v_extra_amount := (v_line->>'amount')::numeric;
      if v_extra_amount <= 0 then
        raise exception 'Nominal baris biaya tambahan harus > 0';
      end if;
      v_extra_total := v_extra_total + v_extra_amount;
    end loop;
  end if;

  if p_apply_tax then
    select is_active, ppn_rate, ppn_keluaran_account_id
      into v_tax_active, v_tax_rate, v_tax_account_id
      from tax_settings where id = true;

    if not coalesce(v_tax_active, false) then
      raise exception 'PPN gak aktif di Pengaturan Pajak -- gak bisa nambah baris PPN Keluaran';
    end if;
    if v_tax_account_id is null then
      raise exception 'Akun PPN Keluaran belum diset di Pengaturan Pajak';
    end if;

    v_tax_amount := round((v_total_amount + v_extra_total) * v_tax_rate / 100, 2);
  end if;

  v_grand_total := v_total_amount + v_extra_total + v_tax_amount;

  v_credit_lines := jsonb_build_array(
    jsonb_build_object('account_id', p_revenue_account_id, 'debit', 0, 'credit', v_total_amount)
  );

  if p_extra_credit_lines is not null and jsonb_array_length(p_extra_credit_lines) > 0 then
    for v_line in select * from jsonb_array_elements(p_extra_credit_lines)
    loop
      v_credit_lines := v_credit_lines || jsonb_build_array(
        jsonb_build_object('account_id', (v_line->>'account_id')::uuid, 'debit', 0, 'credit', (v_line->>'amount')::numeric)
      );
    end loop;
  end if;

  if p_apply_tax then
    v_credit_lines := v_credit_lines || jsonb_build_array(
      jsonb_build_object('account_id', v_tax_account_id, 'debit', 0, 'credit', v_tax_amount)
    );
  end if;

  v_revenue_entry_id := create_journal_entry(
    p_sale_date, 'Penjualan POS', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_cash_account_id, 'debit', v_grand_total, 'credit', 0)
    ) || v_credit_lines
  );

  v_cogs_entry_id := create_journal_entry(
    p_sale_date, 'HPP Penjualan POS', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_hpp_account_id, 'debit', v_total_cost, 'credit', 0),
      jsonb_build_object('account_id', p_finished_good_account_id, 'debit', 0, 'credit', v_total_cost)
    )
  );

  insert into pos_sales (
    customer_id, sale_date, cash_account_id, revenue_account_id,
    revenue_journal_entry_id, cogs_journal_entry_id, source_ref, created_by
  ) values (
    p_customer_id, p_sale_date, p_cash_account_id, p_revenue_account_id,
    v_revenue_entry_id, v_cogs_entry_id, p_source_ref, auth.uid()
  ) returning id into v_sale_id;

  for i in 1..array_length(v_line_items, 1) loop
    insert into pos_sale_lines (pos_sale_id, item_id, qty_sold, unit_price, line_amount, total_cost)
    values (v_sale_id, v_line_items[i], v_line_qtys[i], v_line_prices[i], v_line_amounts[i], v_line_costs[i])
    returning id into v_line_id;

    insert into inventory_movements (item_id, movement_date, qty, pos_sale_line_id)
    values (v_line_items[i], p_sale_date, -v_line_qtys[i], v_line_id);
  end loop;

  if p_extra_credit_lines is not null and jsonb_array_length(p_extra_credit_lines) > 0 then
    for v_line in select * from jsonb_array_elements(p_extra_credit_lines)
    loop
      insert into pos_sale_extra_credit_lines (pos_sale_id, account_id, amount, is_tax)
      values (v_sale_id, (v_line->>'account_id')::uuid, (v_line->>'amount')::numeric, false);
    end loop;
  end if;

  if p_apply_tax then
    insert into pos_sale_extra_credit_lines (pos_sale_id, account_id, amount, is_tax)
    values (v_sale_id, v_tax_account_id, v_tax_amount, true);
  end if;

  return v_sale_id;
end;
$$;
