-- Bundle Promo Rules ("Beli N Gratis X") + resolusi diskon SERVER-SIDE buat create_pos_sale.
-- Ref: docs/domain/accounts-receivable.md submodule "Beli N Gratis X (Bundle Promo)",
-- docs/architecture/bundle-promo-rules-schema.md.
--
-- Beda mendasar dari item_discount_rules (0045): berbasis KUANTITAS, bukan harga -- barang
-- hadiah (reward_item_id) BOLEH beda dari barang pemicu (trigger_item_id), TIDAK PERNAH
-- ditambahkan otomatis ke invoice/keranjang (harus udah ada sebagai baris sendiri), dan
-- diselesaikan Cara A (harga baris hadiah dikoreksi jadi Rp0 sampai batas qty gratis yang
-- didapat, HPP tetap lewat akun HPP normal -- TIDAK ada akun "Beban Promosi" terpisah).
--
-- Titik komputasi BEDA dari item_discount_rules juga: create_order/create_goods_issue tetap
-- trust client (pola sama 0045 -- p_lines sekarang boleh bawa "bundle_promo_rule_id" opsional,
-- informational doang). TAPI create_pos_sale (security definer, self-computed v_total_amount,
-- role cashier gak dipercaya) WAJIB menghitung ulang sendiri di server -- baik diskon
-- item_discount_rules MAUPUN bundle_promo_rules, lewat 2 fungsi helper baru
-- (resolve_item_discount, resolve_bundle_promo_discounts) yang MIRROR logic TypeScript yang
-- dipakai sisi admin (drift-risk 2-tempat yang disadari, pola sama report_cash_flow_investing_financing
-- vs reference implementation TS-nya -- lihat memory/architecture/app/tech-stack-decisions.md).

create table bundle_promo_rules (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  trigger_item_id uuid not null references items(id),
  buy_qty numeric(14,3) not null check (buy_qty > 0),
  reward_item_id uuid not null references items(id),
  free_qty numeric(14,3) not null check (free_qty > 0),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text default (auth.jwt() ->> 'email')
);

comment on column bundle_promo_rules.created_by is 'Email snapshot saat insert (bukan FK) -- konvensi master data (items/counterparties/accounts/bom), beda dari created_by uuid FK di tabel transaksional sejak 0011+. NULL = data lama / insert di luar jalur aplikasi.';
comment on column bundle_promo_rules.trigger_item_id is 'Barang yang harus dibeli -- WAJIB barang spesifik, sengaja gak ada opsi kategori (beda dari item_discount_rules) biar gak ada ambiguitas penjumlahan qty lintas barang beda dalam 1 kategori.';
comment on column bundle_promo_rules.reward_item_id is 'Barang hadiah -- boleh sama dengan trigger_item_id (mis. "beli 2 gratis 1" barang yang sama) atau beda (mis. "beli Sabun gratis Shampo"). Harus BENERAN ada sebagai baris tersendiri di invoice/keranjang -- sistem gak pernah menambahkannya otomatis.';

-- Cuma cegah 2 aturan aktif dengan kombinasi (trigger,reward) yang SAMA -- SENGAJA
-- membolehkan beberapa aturan aktif dengan trigger_item_id sama asal reward_item_id beda
-- (mis. "beli 2 Sabun gratis Shampo" DAN "beli 3 Sabun gratis Kondisioner" boleh aktif
-- bersamaan) -- beda dari item_discount_rules yang dibatasi 1 aturan aktif per item.
create unique index bundle_promo_rules_one_active_per_pair
  on bundle_promo_rules(trigger_item_id, reward_item_id) where archived_at is null;

create trigger bundle_promo_rules_set_updated_at
  before update on bundle_promo_rules
  for each row execute function set_updated_at();

alter table bundle_promo_rules enable row level security;

create policy bundle_promo_rules_select on bundle_promo_rules for select using (auth.role() = 'authenticated');
create policy bundle_promo_rules_insert on bundle_promo_rules for insert with check (
  exists (select 1 from app_user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin')
);
create policy bundle_promo_rules_update on bundle_promo_rules for update using (
  exists (select 1 from app_user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin')
);

grant select, insert, update on bundle_promo_rules to authenticated;

-- Kolom pendukung (audit trail, sisi OUTBOUND doang, sama pola discount_rule_id di 0045) ----

alter table order_lines
  add column bundle_promo_rule_id uuid references bundle_promo_rules(id);

alter table goods_note_lines
  add column bundle_promo_rule_id uuid references bundle_promo_rules(id);

comment on column order_lines.bundle_promo_rule_id is 'Kalau baris ini kebagian gratis dari Bundle Promo (estimasi saat order dibuat) -- terpisah dari discount_rule_id (item_discount_rules), keduanya bisa nambah ke discount_amount yang sama. PURELY informational, sama seperti discount_rule_id.';
comment on column goods_note_lines.bundle_promo_rule_id is 'Kalau baris ini beneran kebagian gratis dari Bundle Promo saat realisasi -- resolusi FRESH (bukan diwarisi dari order_lines), sama pola discount_rule_id. Buat OUTBOUND dari POS, ini diisi RPC create_pos_sale sendiri (server-side, gak dipercaya dari client).';

-- resolve_item_discount -- mirror SQL dari resolveItemDiscount() TypeScript
-- (apps/erp/src/lib/item-discount-rules/schema.ts) -- item menang atas kategori, NOMINAL
-- dihitung per qty (satuan dasar), PERCENT dihitung dari amount, dibatasi gak lebih dari
-- amount baris itu sendiri. Dipakai create_pos_sale buat resolusi server-side.
create function resolve_item_discount(p_item_id uuid, p_qty numeric, p_amount numeric)
returns table(discount_rule_id uuid, discount_amount numeric)
language plpgsql
stable
as $$
declare
  v_category_id uuid;
  v_rule item_discount_rules%rowtype;
  v_found boolean := false;
  v_raw numeric;
begin
  select category_id into v_category_id from items where id = p_item_id;

  select * into v_rule from item_discount_rules
    where item_id = p_item_id and archived_at is null
    limit 1;
  v_found := found;

  if not v_found and v_category_id is not null then
    select * into v_rule from item_discount_rules
      where category_id = v_category_id and archived_at is null
      limit 1;
    v_found := found;
  end if;

  if not v_found then
    return;
  end if;

  v_raw := case when v_rule.discount_type = 'PERCENT'
    then p_amount * v_rule.discount_value / 100
    else p_qty * v_rule.discount_value
  end;

  discount_amount := least(round(v_raw, 2), p_amount);
  if discount_amount > 0 then
    discount_rule_id := v_rule.id;
    return next;
  end if;
  return;
end;
$$;

-- resolve_bundle_promo_discounts -- mirror SQL dari resolver TypeScript sisi admin (cart-wide
-- scan). Khusus bentuk p_lines create_pos_sale ({"item_id","qty_sold","unit_price"}) -- satu-
-- satunya pemanggil sekarang. Return array SEJAJAR p_lines:
-- [{"bundle_promo_rule_id":uuid|null,"discount_amount":numeric}].
-- Cara kerja: (1) jumlahkan qty_sold per item_id lintas SEMUA baris (basis trigger qty), (2)
-- per baris, kalau item baris itu adalah reward_item_id dari 1+ aturan aktif, hitung total qty
-- gratis yang "didapat" dari trigger_qty (floor(trigger_qty/buy_qty)*free_qty per aturan,
-- diakumulasi lintas aturan yang reward_item_id-nya sama), dibatasi gak lebih dari qty baris
-- itu sendiri. TIDAK PERNAH menambah baris baru -- kalau reward_item gak ada di p_lines,
-- gak ada apa pun yang terjadi buat trigger itu.
--
-- KASUS KHUSUS trigger_item_id = reward_item_id (barang hadiah = barang pemicu, mis. "beli 2
-- gratis 1 barang yang sama"): trigger_qty & qty baris hadiah adalah POOL UNIT FISIK YANG
-- SAMA, jadi pembaginya WAJIB (buy_qty+free_qty) -- 1 "set" = buy_qty dibayar + free_qty
-- gratis, total unit yang harus ada di keranjang. Kalau dibagi buy_qty doang (kayak kasus
-- trigger != reward), unit yang udah digratiskan ikut kehitung lagi jadi basis gratis
-- berikutnya (over-grant) -- ketemu waktu review sebelum migration ini diapply.
create function resolve_bundle_promo_discounts(p_lines jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  v_qty_by_item jsonb := '{}'::jsonb;
  v_line jsonb;
  v_item_id uuid;
  v_qty numeric;
  v_unit_price numeric;
  v_earned numeric;
  v_capped_qty numeric;
  v_rule_id uuid;
  v_rule record;
  v_result jsonb := '[]'::jsonb;
begin
  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_item_id := (v_line->>'item_id')::uuid;
    v_qty := (v_line->>'qty_sold')::numeric;
    v_qty_by_item := jsonb_set(
      v_qty_by_item,
      array[v_item_id::text],
      to_jsonb(coalesce((v_qty_by_item->>(v_item_id::text))::numeric, 0) + v_qty)
    );
  end loop;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_item_id := (v_line->>'item_id')::uuid;
    v_qty := (v_line->>'qty_sold')::numeric;
    v_unit_price := (v_line->>'unit_price')::numeric;

    v_earned := 0;
    v_rule_id := null;
    for v_rule in
      select * from bundle_promo_rules
      where reward_item_id = v_item_id and archived_at is null
      order by id
    loop
      if v_rule_id is null then
        v_rule_id := v_rule.id;
      end if;
      -- trigger = reward (mis. "beli 2 gratis 1 barang yang sama"): qty pemicu & qty hadiah
      -- adalah POOL UNIT FISIK YANG SAMA -- 1 "set" berarti (buy_qty+free_qty) unit di-scan
      -- total, BUKAN buy_qty doang, atau unit yang udah digratiskan bakal ikut jadi basis
      -- gratis berikutnya (over-grant). trigger != reward: pool-nya independen, tetap
      -- floor(trigger_qty/buy_qty) seperti biasa.
      if v_rule.trigger_item_id = v_rule.reward_item_id then
        v_earned := v_earned + floor(
          coalesce((v_qty_by_item->>(v_rule.trigger_item_id::text))::numeric, 0) / (v_rule.buy_qty + v_rule.free_qty)
        ) * v_rule.free_qty;
      else
        v_earned := v_earned + floor(
          coalesce((v_qty_by_item->>(v_rule.trigger_item_id::text))::numeric, 0) / v_rule.buy_qty
        ) * v_rule.free_qty;
      end if;
    end loop;

    v_capped_qty := least(v_earned, v_qty);

    if v_capped_qty > 0 then
      v_result := v_result || jsonb_build_array(
        jsonb_build_object('bundle_promo_rule_id', v_rule_id, 'discount_amount', round(v_capped_qty * v_unit_price, 2))
      );
    else
      v_result := v_result || jsonb_build_array(
        jsonb_build_object('bundle_promo_rule_id', null, 'discount_amount', 0)
      );
    end if;
  end loop;

  return v_result;
end;
$$;

-- create_order -- signature TIDAK berubah, cuma tambah parsing "bundle_promo_rule_id" opsional
-- per baris (sama pola discount_rule_id di 0045). Aman create or replace biasa.
create or replace function create_order(
  p_direction text,
  p_counterparty_id uuid,
  p_order_date date,
  p_expected_date date,
  p_source_ref text,
  p_lines jsonb -- array of {"item_id":uuid,"qty_ordered":numeric,"unit_price":numeric,"discount_rule_id":uuid|null,"discount_amount":numeric|null,"bundle_promo_rule_id":uuid|null}
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_order_id uuid;
  v_line jsonb;
begin
  if p_direction not in ('PURCHASE','SALE') then
    raise exception 'p_direction harus PURCHASE atau SALE, dapat %', p_direction;
  end if;

  insert into orders (counterparty_id, direction, order_date, expected_date, source_ref, created_by)
  values (p_counterparty_id, p_direction, p_order_date, p_expected_date, p_source_ref, auth.uid())
  returning id into v_order_id;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    insert into order_lines (order_id, item_id, qty_ordered, unit_price, discount_rule_id, discount_amount, bundle_promo_rule_id)
    values (
      v_order_id,
      (v_line->>'item_id')::uuid,
      (v_line->>'qty_ordered')::numeric,
      (v_line->>'unit_price')::numeric,
      nullif(v_line->>'discount_rule_id', '')::uuid,
      coalesce((v_line->>'discount_amount')::numeric, 0),
      nullif(v_line->>'bundle_promo_rule_id', '')::uuid
    );
  end loop;

  return v_order_id;
end;
$$;

-- create_goods_issue -- signature TIDAK berubah, cuma tambah parsing "bundle_promo_rule_id"
-- opsional per baris (sama pola discount_rule_id di 0045). Aman create or replace biasa.
create or replace function create_goods_issue(
  p_customer_id uuid,
  p_invoice_date date,
  p_description text,
  p_source_ref text,
  p_credit_lines jsonb,
  p_receivable_account_id uuid,
  p_lines jsonb, -- array of {"item_id":uuid,"qty_issued":numeric,"order_line_id":uuid|null,"unit_price":numeric|null,"discount_rule_id":uuid|null,"discount_amount":numeric|null,"bundle_promo_rule_id":uuid|null}
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
    v_total_discount := v_total_discount + coalesce((v_line->>'discount_amount')::numeric, 0);
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
      discount_rule_id, discount_amount, bundle_promo_rule_id
    )
    values (
      v_issue_id, v_line_items[i], v_line_qtys[i], v_line_costs[i], v_line_order_lines[i], v_line_unit_prices[i],
      v_line_discount_rule_ids[i], v_line_discount_amounts[i], v_line_bundle_promo_rule_ids[i]
    )
    returning id into v_line_id;

    insert into inventory_movements (item_id, movement_date, qty, goods_note_line_id)
    values (v_line_items[i], p_invoice_date, -v_line_qtys[i], v_line_id);
  end loop;

  return v_issue_id;
end;
$$;

-- create_pos_sale -- PERUBAHAN UTAMA: resolusi item_discount_rules + bundle_promo_rules
-- sekarang dihitung DI DALAM RPC (server-side), bukan dipercaya dari client -- konsisten
-- sama desain awal RPC ini yang udah gak pernah percaya v_total_amount dari client. Signature
-- TIDAK berubah (p_lines tetap {"item_id","qty_sold","unit_price"} apa adanya) -- resolusi
-- rule murni pakai item_id+qty_sold yang udah ada, gak butuh input baru dari client.
create or replace function create_pos_sale(
  p_sale_date date,
  p_source_ref text,
  p_customer_id uuid,
  p_cash_account_id uuid,
  p_revenue_account_id uuid,
  p_hpp_account_id uuid,
  p_finished_good_account_id uuid,
  p_lines jsonb, -- array of {"item_id":uuid,"qty_sold":numeric,"unit_price":numeric}
  p_extra_credit_lines jsonb default '[]'::jsonb,
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
  v_item_discount record;
  v_item_discount_amount numeric;
  v_item_discount_rule_id uuid;
  v_bundle_discount_amount numeric;
  v_bundle_promo_rule_id uuid;
  v_line_discount_amount numeric;
  i int := 0;
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

    -- diskon item/kategori (item_discount_rules) -- resolve_item_discount return SETOF,
    -- ambil 0/1 baris. select * into record dari 0 baris bikin v_item_discount NULL
    -- keseluruhan (FOUND jadi false) -- makanya cek FOUND, bukan field-nya langsung.
    v_item_discount_rule_id := null;
    v_item_discount_amount := 0;
    select * into v_item_discount
      from resolve_item_discount((v_line->>'item_id')::uuid, v_qty, v_gross_amount);
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

    v_issue_lines := v_issue_lines || jsonb_build_array(
      jsonb_build_object(
        'item_id', v_line ->> 'item_id',
        'qty_issued', v_qty,
        'order_line_id', null,
        'unit_price', v_unit_price,
        'discount_rule_id', v_item_discount_rule_id,
        'discount_amount', v_line_discount_amount,
        'bundle_promo_rule_id', v_bundle_promo_rule_id
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

grant execute on function resolve_item_discount(uuid, numeric, numeric) to authenticated;
grant execute on function resolve_bundle_promo_discounts(jsonb) to authenticated;
