-- Promo berbasis qty & satuan: (1) Diskon Penjualan dengan syarat minimal qty (bertingkat,
-- aturan level barang saja), (2) Beli N Gratis X dengan N/X dalam satuan tertentu + hadiah
-- gratis/persen/nominal, (3) jatah hadiah bundle dibagi berurutan antar baris (fix hitung ganda).
-- Ref: docs/domain/accounts-receivable.md submodule "Diskon Penjualan" & "Beli N Gratis X",
-- docs/architecture/promotion-item-discount-rules-schema.md, promotion-bundle-rules-schema.md.
--
-- Prinsip migrasi: HANYA nambah kolom nullable/ber-default -- aturan yang sudah ada tetap
-- jalan persis seperti sebelumnya (tanpa syarat minimal, N/X dalam satuan dasar, hadiah FREE).
-- Kolom basis kanonik yang dipakai resolver tetap satuan DASAR (min_qty_base, buy_qty, free_qty);
-- kolom satuan/qty-ketikan (min_qty+min_qty_unit_id, buy_unit_qty+buy_unit_id,
-- reward_unit_qty+reward_unit_id) cuma metadata input admin, dikonversi otomatis oleh trigger.
-- Periode promo (tanggal mulai/berakhir) SENGAJA belum termasuk.

-- 1. Diskon Penjualan: syarat minimal qty (opsional, hanya aturan level barang)
alter table promotion_item_discount_rules
  add column min_qty numeric(14,3) check (min_qty is null or min_qty > 0),
  add column min_qty_unit_id uuid references item_units(id),
  add column min_qty_base numeric(14,3);

comment on column promotion_item_discount_rules.min_qty is 'Syarat minimal qty sebagaimana diketik admin (dalam satuan min_qty_unit_id). NULL = tanpa syarat (perilaku lama).';
comment on column promotion_item_discount_rules.min_qty_unit_id is 'Satuan jual milik item_id yang dipakai admin menulis syarat (mis. dos).';
comment on column promotion_item_discount_rules.min_qty_base is 'min_qty x conversion_factor, DIISI TRIGGER -- inilah nilai yang dibandingkan resolver ke total qty satuan dasar barang itu lintas semua baris.';

-- syarat minimal cuma buat aturan barang (satuan itu milik tiap barang -- di kategori ambigu)
alter table promotion_item_discount_rules add constraint promotion_item_discount_rules_min_qty_item_only
  check (category_id is null or min_qty is null);
alter table promotion_item_discount_rules add constraint promotion_item_discount_rules_min_qty_complete
  check ((min_qty is null) = (min_qty_unit_id is null) and (min_qty is null) = (min_qty_base is null));

create function promotion_item_discount_rules_fill_min_qty_base() returns trigger
language plpgsql
as $$
declare
  v_unit_item_id uuid;
  v_factor numeric;
begin
  if new.min_qty is not null and new.min_qty_unit_id is not null then
    select item_id, conversion_factor into v_unit_item_id, v_factor
      from item_units where id = new.min_qty_unit_id;
    if v_unit_item_id is distinct from new.item_id then
      raise exception 'Satuan syarat minimal harus milik barang yang dinaungi aturan ini';
    end if;
    new.min_qty_base := new.min_qty * v_factor;
  else
    new.min_qty_base := null; -- setengah isi (qty tanpa satuan atau sebaliknya) ditolak CHECK min_qty_complete
  end if;
  return new;
end;
$$;

-- Tanpa daftar kolom (jalan di tiap insert/update): murah & idempoten, dan menutup jalur
-- UPDATE langsung ke min_qty_base yang bikin nilai kanonik menyimpang dari min_qty x faktor.
create trigger promotion_item_discount_rules_fill_min_qty_base_trigger
  before insert or update on promotion_item_discount_rules
  for each row execute function promotion_item_discount_rules_fill_min_qty_base();

-- Keunikan: sebelumnya 1 aturan aktif per barang. Sekarang 1 per (barang, nilai syarat minimal)
-- -- termasuk 1 aturan "tanpa syarat" (min_qty_base NULL dianggap 0). Bertingkat (>=10 dos,
-- >=50 dos) jadi boleh, tapi 2 aturan dengan syarat SAMA tetap ditolak. Index kategori gak berubah.
drop index if exists promotion_item_discount_rules_one_active_per_item;
create unique index promotion_item_discount_rules_one_active_per_item_tier
  on promotion_item_discount_rules(item_id, coalesce(min_qty_base, 0))
  where item_id is not null and archived_at is null;

-- 2. Beli N Gratis X: N & X dalam satuan tertentu + jenis hadiah
alter table promotion_bundle_rules
  add column buy_unit_id uuid references item_units(id),
  add column buy_unit_qty numeric(14,3) check (buy_unit_qty is null or buy_unit_qty > 0),
  add column reward_unit_id uuid references item_units(id),
  add column reward_unit_qty numeric(14,3) check (reward_unit_qty is null or reward_unit_qty > 0),
  add column reward_type text not null default 'FREE' check (reward_type in ('FREE', 'PERCENT', 'NOMINAL')),
  add column reward_value numeric(14,2);

comment on column promotion_bundle_rules.buy_qty is 'Qty beli (N) dalam SATUAN DASAR barang pemicu -- kanonik buat resolver. Kalau buy_unit_id terisi, diisi trigger dari buy_unit_qty x conversion_factor.';
comment on column promotion_bundle_rules.free_qty is 'Qty hadiah (X) dalam SATUAN DASAR barang hadiah -- kanonik buat resolver. Kalau reward_unit_id terisi, diisi trigger dari reward_unit_qty x conversion_factor.';
comment on column promotion_bundle_rules.reward_type is 'FREE = harga baris hadiah jadi Rp0 (perilaku lama); PERCENT/NOMINAL = diskon pada qty hadiah yang berhak (NOMINAL = Rupiah per satuan dasar barang hadiah).';

alter table promotion_bundle_rules add constraint promotion_bundle_rules_buy_unit_complete
  check ((buy_unit_id is null) = (buy_unit_qty is null));
alter table promotion_bundle_rules add constraint promotion_bundle_rules_reward_unit_complete
  check ((reward_unit_id is null) = (reward_unit_qty is null));
alter table promotion_bundle_rules add constraint promotion_bundle_rules_reward_value_matches_type
  check (
    (reward_type = 'FREE' and reward_value is null)
    or (reward_type = 'PERCENT' and reward_value is not null and reward_value > 0 and reward_value <= 100)
    or (reward_type = 'NOMINAL' and reward_value is not null and reward_value > 0)
  );

create function promotion_bundle_rules_fill_base_qty() returns trigger
language plpgsql
as $$
declare
  v_unit_item_id uuid;
  v_factor numeric;
begin
  if new.buy_unit_id is not null then
    select item_id, conversion_factor into v_unit_item_id, v_factor from item_units where id = new.buy_unit_id;
    if v_unit_item_id is distinct from new.trigger_item_id then
      raise exception 'Satuan beli harus milik barang pemicu';
    end if;
    new.buy_qty := new.buy_unit_qty * v_factor;
  end if;

  if new.reward_unit_id is not null then
    select item_id, conversion_factor into v_unit_item_id, v_factor from item_units where id = new.reward_unit_id;
    if v_unit_item_id is distinct from new.reward_item_id then
      raise exception 'Satuan hadiah harus milik barang hadiah';
    end if;
    new.free_qty := new.reward_unit_qty * v_factor;
  end if;

  return new;
end;
$$;

-- Tanpa daftar kolom -- sama alasan dengan trigger diskon (tutup UPDATE langsung ke buy_qty/free_qty).
create trigger promotion_bundle_rules_fill_base_qty_trigger
  before insert or update on promotion_bundle_rules
  for each row execute function promotion_bundle_rules_fill_base_qty();

-- 3. Faktor konversi satuan yang dipakai aturan promo gak boleh diubah -- nilai basis
-- (min_qty_base/buy_qty/free_qty) sudah dihitung dari faktor lama dan gak otomatis ikut. Satuan
-- yang salah faktor: bikin satuan baru, jangan ubah yang sudah dipakai promo (sama prinsip
-- tutorial "jangan ubah faktor satuan yang sudah berjalan"). Aturan yang diarsipkan tetap
-- dihitung -- bisa diaktifkan lagi kapan saja.
create function item_units_guard_promo_conversion_factor() returns trigger
language plpgsql
as $$
begin
  -- item_id juga dijaga: memindahkan satuan ke barang lain bikin FK promo menunjuk satuan milik
  -- barang yang salah tanpa dicek ulang.
  if (new.conversion_factor is distinct from old.conversion_factor or new.item_id is distinct from old.item_id) and (
    exists (select 1 from promotion_item_discount_rules where min_qty_unit_id = old.id)
    or exists (select 1 from promotion_bundle_rules where buy_unit_id = old.id or reward_unit_id = old.id)
  ) then
    raise exception 'Satuan % dipakai aturan promo -- faktor konversi/barangnya gak boleh diubah; buat satuan baru', old.unit_label;
  end if;
  return new;
end;
$$;

create trigger item_units_guard_promo_conversion_factor_trigger
  before update of conversion_factor, item_id on item_units
  for each row execute function item_units_guard_promo_conversion_factor();

-- 4. resolve_item_discount -- tambah p_total_qty (total qty satuan DASAR barang ini lintas SEMUA
-- baris transaksi, dipakai buat cek syarat minimal; NULL = pakai p_qty baris ini sendiri, jadi
-- caller lama tetap benar). Syarat dicek ke p_total_qty, tapi diskon dihitung ke p_qty/p_amount
-- BARIS ini -- begitu syarat terpenuhi, seluruh qty tiap baris barang itu kena diskon.
-- Pilih aturan barang dengan syarat tertinggi yang terpenuhi; kalau gak ada yang terpenuhi,
-- jatuh ke aturan kategori (kategori selalu tanpa syarat).
drop function resolve_item_discount(uuid, numeric, numeric);
create function resolve_item_discount(
  p_item_id uuid,
  p_qty numeric,
  p_amount numeric,
  p_total_qty numeric default null
)
returns table(discount_rule_id uuid, discount_amount numeric)
language plpgsql
stable
as $$
declare
  v_category_id uuid;
  v_rule promotion_item_discount_rules%rowtype;
  v_found boolean := false;
  v_raw numeric;
  v_threshold_qty numeric := coalesce(p_total_qty, p_qty);
begin
  select * into v_rule from promotion_item_discount_rules
    where item_id = p_item_id
      and archived_at is null
      and coalesce(min_qty_base, 0) <= v_threshold_qty
    order by coalesce(min_qty_base, 0) desc, id
    limit 1;
  v_found := found;

  if not v_found then
    select category_id into v_category_id from items where id = p_item_id;
    if v_category_id is not null then
      select * into v_rule from promotion_item_discount_rules
        where category_id = v_category_id and archived_at is null
        limit 1;
      v_found := found;
    end if;
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

-- 5. resolve_bundle_promo_discounts -- signature sama (jsonb -> jsonb sejajar p_lines). Beda:
--  * jatah hadiah per aturan = POOL yang dibagi berurutan antar baris (urutan p_lines) -- barang
--    hadiah yang muncul di >1 baris (mis. pcs + ikat) gak bisa lagi masing-masing ngeklaim jatah
--    penuh (fix hitung ganda: total gratis selalu <= hak).
--  * jenis hadiah: FREE (harga jadi Rp0), PERCENT, NOMINAL (Rupiah per satuan dasar).
-- Semua qty dalam satuan dasar (p_lines dari create_pos_sale sudah dikonversi). Aturan diproses
-- urut id (deterministik); bundle_promo_rule_id = aturan pertama yang menyumbang diskon baris itu.
create or replace function resolve_bundle_promo_discounts(p_lines jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  v_qty_by_item jsonb := '{}'::jsonb;
  v_pool jsonb := '{}'::jsonb;
  v_line jsonb;
  v_item_id uuid;
  v_qty numeric;
  v_unit_price numeric;
  v_remaining numeric;
  v_take numeric;
  v_line_discount numeric;
  v_first_rule_id uuid;
  v_trigger_qty numeric;
  v_set_size numeric;
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

    v_remaining := v_qty;
    v_line_discount := 0;
    v_first_rule_id := null;

    -- baris berharga 0 gak bisa dapat diskon -- jangan sampai menghabiskan jatah pool yang
    -- seharusnya dipakai baris berikutnya yang berharga.
    if v_unit_price <= 0 then
      v_result := v_result || jsonb_build_array(
        jsonb_build_object('bundle_promo_rule_id', null, 'discount_amount', 0)
      );
      continue;
    end if;

    for v_rule in
      select * from promotion_bundle_rules
      where reward_item_id = v_item_id and archived_at is null
      order by id
    loop
      exit when v_remaining <= 0;

      -- pool aturan ini diinisialisasi sekali (waktu pertama kali dilihat): jumlah set penuh x qty gratis.
      -- trigger = reward (barang sama): 1 set = buy+free unit fisik yang sama (lihat 0046).
      if v_pool->>(v_rule.id::text) is null then
        v_trigger_qty := coalesce((v_qty_by_item->>(v_rule.trigger_item_id::text))::numeric, 0);
        v_set_size := case when v_rule.trigger_item_id = v_rule.reward_item_id
          then v_rule.buy_qty + v_rule.free_qty
          else v_rule.buy_qty
        end;
        v_pool := jsonb_set(v_pool, array[v_rule.id::text], to_jsonb(floor(v_trigger_qty / v_set_size) * v_rule.free_qty));
      end if;

      v_take := least((v_pool->>(v_rule.id::text))::numeric, v_remaining);
      if v_take <= 0 then
        continue;
      end if;

      v_line_discount := v_line_discount + v_take * case v_rule.reward_type
        when 'FREE' then v_unit_price
        when 'PERCENT' then v_unit_price * v_rule.reward_value / 100
        else least(v_rule.reward_value, v_unit_price)
      end;
      v_remaining := v_remaining - v_take;
      v_pool := jsonb_set(v_pool, array[v_rule.id::text], to_jsonb((v_pool->>(v_rule.id::text))::numeric - v_take));
      if v_first_rule_id is null then
        v_first_rule_id := v_rule.id;
      end if;
    end loop;

    if v_line_discount > 0 then
      v_result := v_result || jsonb_build_array(
        jsonb_build_object('bundle_promo_rule_id', v_first_rule_id, 'discount_amount', round(v_line_discount, 2))
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

grant execute on function resolve_item_discount(uuid, numeric, numeric, numeric) to authenticated;

-- 6. create_pos_sale -- sama persis 0046, bedanya: total qty (satuan dasar) tiap barang
-- lintas semua baris dihitung dulu (v_item_totals) lalu diteruskan ke resolve_item_discount
-- sebagai p_total_qty, buat cek syarat minimal. Signature/return/grant gak berubah.
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
  v_item_totals jsonb := '{}'::jsonb;
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
