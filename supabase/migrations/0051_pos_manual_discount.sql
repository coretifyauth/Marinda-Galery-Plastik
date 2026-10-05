-- 0051_pos_manual_discount.sql
-- Diskon manual kasir POS: 1 nominal Rupiah per TRANSAKSI, ditumpuk di atas diskon otomatis
-- (promotion_item_discount_rules + promotion_bundle_rules), dicatat NET (tanpa akun baru) --
-- konsep: docs/domain/pos.md submodule "Diskon Manual Kasir"; struktur data:
-- docs/architecture/pos-schema.md + goods-notes-schema.md.
--
-- Isi:
--   1. goods_note_lines.manual_discount_amount -- kolom TERPISAH dari discount_amount (diskon
--      otomatis), biar laporan bisa membedakan potongan promo vs nego kasir.
--   2. create_goods_issue -- signature TIDAK berubah, cuma baca field opsional
--      "manual_discount_amount" per baris (pola sama discount_amount/bundle_promo_rule_id di
--      0045/0046). transactions.discount_amount ikut mengakumulasi diskon manual (arti kolom itu
--      tetap "total diskon yang baked-in ke amount").
--   3. create_pos_sale -- param baru p_manual_discount (trailing, default 0 supaya payload outbox
--      offline lama yang belum punya param ini tetap bisa disinkronkan). Server (bukan client)
--      yang memvalidasi & membagi potongan proporsional ke baris. Signature berubah -> drop dulu,
--      create ulang, grant ulang.

-- 1. Kolom -----------------------------------------------------------------------------------

alter table goods_note_lines
  add column manual_discount_amount numeric(14,2) not null default 0 check (manual_discount_amount >= 0);

comment on column goods_note_lines.manual_discount_amount is 'OUTBOUND dari POS: porsi diskon manual kasir (1 nominal per transaksi, dibagi proporsional ke baris oleh create_pos_sale) yang kena baris ini. Terpisah dari discount_amount (diskon otomatis dari aturan promo) -- keduanya sudah baked-in ke jumlah yang dijurnal (kredit pendapatan sudah net), kolom ini murni audit trail. Selalu 0 untuk jalur selain POS. Siapa kasirnya: goods_notes.created_by.';

-- 2. create_goods_issue ----------------------------------------------------------------------

create or replace function create_goods_issue(
  p_customer_id uuid,
  p_invoice_date date,
  p_description text,
  p_source_ref text,
  p_credit_lines jsonb,
  p_receivable_account_id uuid,
  p_lines jsonb, -- array of {"item_id":uuid,"qty_issued":numeric,"order_line_id":uuid|null,"unit_price":numeric|null,"discount_rule_id":uuid|null,"discount_amount":numeric|null,"bundle_promo_rule_id":uuid|null,"manual_discount_amount":numeric|null}
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
  v_total_discount numeric := 0;
  v_entry_id uuid;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_costs numeric[] := '{}';
  v_line_order_lines uuid[] := '{}';
  v_line_unit_prices numeric[] := '{}';
  v_line_discount_rule_ids uuid[] := '{}';
  v_line_discount_amounts numeric[] := '{}';
  v_line_bundle_promo_rule_ids uuid[] := '{}';
  v_line_manual_discount_amounts numeric[] := '{}';
  v_line_id uuid;
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

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_total_discount := v_total_discount
      + coalesce((v_line->>'discount_amount')::numeric, 0)
      + coalesce((v_line->>'manual_discount_amount')::numeric, 0);
  end loop;

  v_invoice_id := create_transaction(
    'OUTBOUND', p_customer_id, p_invoice_date, p_description, p_source_ref,
    p_credit_lines, p_receivable_account_id, p_apply_tax, null, v_total_discount
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
    v_line_discount_rule_ids := array_append(v_line_discount_rule_ids, nullif(v_line->>'discount_rule_id', '')::uuid);
    v_line_discount_amounts := array_append(v_line_discount_amounts, coalesce((v_line->>'discount_amount')::numeric, 0));
    v_line_bundle_promo_rule_ids := array_append(v_line_bundle_promo_rule_ids, nullif(v_line->>'bundle_promo_rule_id', '')::uuid);
    v_line_manual_discount_amounts := array_append(v_line_manual_discount_amounts, coalesce((v_line->>'manual_discount_amount')::numeric, 0));
    v_total_cost := v_total_cost + v_line_cost;
  end loop;

  v_entry_id := create_journal_entry(
    p_invoice_date, 'HPP ' || p_description, p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_hpp_account_id, 'debit', v_total_cost, 'credit', 0),
      jsonb_build_object('account_id', p_finished_good_account_id, 'debit', 0, 'credit', v_total_cost)
    )
  );

  insert into goods_notes (id, type, transaction_id, journal_entry_id, source_ref, note_date, created_by)
  values (v_issue_id, 'OUTBOUND', v_invoice_id, v_entry_id, p_source_ref, p_invoice_date, auth.uid());

  for i in 1..array_length(v_line_items, 1) loop
    insert into goods_note_lines (
      goods_note_id, item_id, qty, total_cost, order_line_id, unit_price,
      discount_rule_id, discount_amount, bundle_promo_rule_id, manual_discount_amount
    )
    values (
      v_issue_id, v_line_items[i], v_line_qtys[i], v_line_costs[i], v_line_order_lines[i], v_line_unit_prices[i],
      v_line_discount_rule_ids[i], v_line_discount_amounts[i], v_line_bundle_promo_rule_ids[i], v_line_manual_discount_amounts[i]
    )
    returning id into v_line_id;

    insert into inventory_movements (item_id, movement_date, qty, goods_note_line_id)
    values (v_line_items[i], p_invoice_date, -v_line_qtys[i], v_line_id);
  end loop;

  return v_issue_id;
end;
$$;

-- 3. create_pos_sale -------------------------------------------------------------------------

drop function if exists create_pos_sale(date, text, uuid, uuid, uuid, uuid, uuid, jsonb, jsonb, boolean);

create function create_pos_sale(
  p_sale_date date,
  p_source_ref text,
  p_customer_id uuid,
  p_cash_account_id uuid,
  p_revenue_account_id uuid,
  p_hpp_account_id uuid,
  p_finished_good_account_id uuid,
  p_lines jsonb, -- array of {"item_id":uuid,"qty_sold":numeric,"unit_price":numeric}
  p_extra_credit_lines jsonb default '[]'::jsonb,
  p_apply_tax boolean default false,
  p_manual_discount numeric default 0 -- diskon manual kasir, 1 nominal Rupiah per transaksi, dibagi proporsional ke baris
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
  v_gross_amount numeric;
  v_net_amount numeric;
  v_total_amount numeric := 0;
  v_total_discount numeric := 0;
  v_credit_lines jsonb;
  v_issue_lines jsonb := '[]'::jsonb;
  v_goods_issue_id uuid;
  v_transaction_id uuid;
  v_settle_amount numeric;
  v_bundle_results jsonb;
  v_item_totals jsonb := '{}'::jsonb;
  v_item_discount record;
  v_item_discount_amount numeric;
  v_item_discount_rule_id uuid;
  v_bundle_discount_amount numeric;
  v_bundle_promo_rule_id uuid;
  v_line_discount_amount numeric;
  v_line_nets numeric[] := '{}';
  v_manual numeric;
  v_alloc numeric[] := '{}';
  v_alloc_sum numeric := 0;
  v_share numeric;
  v_max_idx int := 1;
  i int := 0;
  k int;
begin
  if not exists (
    select 1 from app_user_roles ur
    where ur.user_id = auth.uid() and ur.role_name in ('admin', 'cashier')
  ) then
    raise exception 'Gak punya akses buat bikin POS Sale';
  end if;

  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'POS sale wajib punya minimal 1 baris item';
  end if;

  v_manual := coalesce(p_manual_discount, 0);
  if v_manual < 0 then
    raise exception 'Diskon manual gak boleh negatif';
  end if;
  -- Nominal diskon manual selalu Rupiah bulat -- pecahan ditolak (bukan dibulatkan diam-diam) biar
  -- bagian proporsional per baris gak pernah kena kasus sisa pembulatan negatif.
  if v_manual <> trunc(v_manual) then
    raise exception 'Diskon manual harus kelipatan Rp1 (diterima: %)', v_manual;
  end if;

  v_customer_id := p_customer_id;
  if v_customer_id is null then
    select walk_in_customer_id into v_customer_id from app_settings where id = true;
    if v_customer_id is null then
      raise exception 'app_settings.walk_in_customer_id belum diset -- hubungi admin';
    end if;
  end if;

  select account_id into v_receivable_account_id
    from app_default_account_settings where role_key = 'ar.receivable';
  if v_receivable_account_id is null then
    raise exception 'app_default_account_settings ar.receivable belum diset -- hubungi admin';
  end if;

  -- resolusi bundle promo butuh lihat SEMUA baris sekaligus (trigger qty lintas baris) --
  -- dihitung sekali di sini, hasilnya array sejajar p_lines.
  v_bundle_results := resolve_bundle_promo_discounts(p_lines);

  -- total qty (satuan dasar) per barang lintas semua baris -- basis cek syarat minimal diskon.
  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_item_totals := jsonb_set(
      v_item_totals,
      array[v_line->>'item_id'],
      to_jsonb(coalesce((v_item_totals->>(v_line->>'item_id'))::numeric, 0) + (v_line->>'qty_sold')::numeric)
    );
  end loop;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    i := i + 1;
    v_qty := (v_line ->> 'qty_sold')::numeric;
    v_unit_price := (v_line ->> 'unit_price')::numeric;

    if v_qty <= 0 then
      raise exception 'qty_sold harus > 0';
    end if;
    if v_unit_price < 0 then
      raise exception 'unit_price gak boleh negatif';
    end if;

    v_gross_amount := v_qty * v_unit_price;

    -- diskon item/kategori -- resolve_item_discount return SETOF, ambil 0/1 baris. select * into
    -- record dari 0 baris bikin v_item_discount NULL keseluruhan (FOUND jadi false) -- makanya
    -- cek FOUND, bukan field-nya langsung.
    v_item_discount_rule_id := null;
    v_item_discount_amount := 0;
    select * into v_item_discount
      from resolve_item_discount(
        (v_line->>'item_id')::uuid, v_qty, v_gross_amount,
        (v_item_totals->>(v_line->>'item_id'))::numeric
      );
    if found then
      v_item_discount_rule_id := v_item_discount.discount_rule_id;
      v_item_discount_amount := v_item_discount.discount_amount;
    end if;

    -- diskon bundle promo -- hasil pre-computed di v_bundle_results, indeks sejajar p_lines
    v_bundle_promo_rule_id := (v_bundle_results->(i-1)->>'bundle_promo_rule_id')::uuid;
    v_bundle_discount_amount := coalesce((v_bundle_results->(i-1)->>'discount_amount')::numeric, 0);

    -- 2 mekanisme boleh nambah bareng di baris yang sama, dibatasi gak lebih dari gross baris ini
    v_line_discount_amount := least(v_item_discount_amount + v_bundle_discount_amount, v_gross_amount);
    v_net_amount := v_gross_amount - v_line_discount_amount;

    v_total_amount := v_total_amount + v_net_amount;
    v_total_discount := v_total_discount + v_line_discount_amount;
    v_line_nets := array_append(v_line_nets, v_net_amount);

    v_issue_lines := v_issue_lines || jsonb_build_array(
      jsonb_build_object(
        'item_id', v_line ->> 'item_id',
        'qty_issued', v_qty,
        'order_line_id', null,
        'unit_price', v_unit_price,
        'discount_rule_id', v_item_discount_rule_id,
        'discount_amount', v_line_discount_amount,
        'bundle_promo_rule_id', v_bundle_promo_rule_id,
        'manual_discount_amount', 0
      )
    );
  end loop;

  -- Diskon manual kasir -- ditumpuk DI ATAS diskon otomatis (basisnya total net setelah diskon
  -- otomatis). Pagar: harus < total net, karena transaction_lines.amount wajib > 0 (nilai
  -- transaksi gak boleh jadi Rp0/negatif) -- ini guard integritas data, bukan plafon bisnis.
  -- Dibagi proporsional ke nilai net tiap baris; sisa pembulatan (selisih v_manual vs jumlah
  -- bagian yang sudah dibulatkan) masuk ke baris net terbesar, jadi jumlah bagian PERSIS = v_manual.
  if v_manual > 0 then
    if v_manual >= v_total_amount then
      raise exception 'Diskon manual (%) harus lebih kecil dari total belanja setelah diskon otomatis (%)',
        v_manual, v_total_amount;
    end if;

    for k in 1..array_length(v_line_nets, 1) loop
      v_share := round(v_manual * v_line_nets[k] / v_total_amount, 2);
      v_alloc := array_append(v_alloc, v_share);
      v_alloc_sum := v_alloc_sum + v_share;
      if v_line_nets[k] > v_line_nets[v_max_idx] then
        v_max_idx := k;
      end if;
    end loop;
    v_alloc[v_max_idx] := v_alloc[v_max_idx] + (v_manual - v_alloc_sum);

    for k in 1..array_length(v_alloc, 1) loop
      if v_alloc[k] < 0 or v_alloc[k] > v_line_nets[k] then
        raise exception 'Alokasi diskon manual melebihi nilai baris ke-% -- kurangi diskon manual', k;
      end if;
      v_issue_lines := jsonb_set(v_issue_lines, array[(k - 1)::text, 'manual_discount_amount'], to_jsonb(v_alloc[k]));
    end loop;

    v_total_amount := v_total_amount - v_manual;
  end if;

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

  v_goods_issue_id := create_goods_issue(
    v_customer_id, p_sale_date, 'Penjualan POS', p_source_ref,
    v_credit_lines, v_receivable_account_id,
    v_issue_lines, p_hpp_account_id, p_finished_good_account_id,
    p_apply_tax
  );

  select transaction_id into v_transaction_id from goods_notes where id = v_goods_issue_id;

  select amount into v_settle_amount from transactions where id = v_transaction_id;

  perform record_payment(
    'OUTBOUND', v_customer_id, p_sale_date, v_settle_amount, p_source_ref,
    p_cash_account_id, v_receivable_account_id, v_transaction_id
  );

  return v_transaction_id;
end;
$$;

grant execute on function create_pos_sale(date, text, uuid, uuid, uuid, uuid, uuid, jsonb, jsonb, boolean, numeric) to authenticated;
