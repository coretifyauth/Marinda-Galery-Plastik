-- Rename item_discount_rules -> promotion_item_discount_rules, bundle_promo_rules ->
-- promotion_bundle_rules -- murni rename (ALTER TABLE RENAME), data/FK/RLS/histori jurnal
-- TIDAK berubah/hilang, cuma nama katalog yang ganti. Index/policy/trigger/constraint ikut
-- di-rename biar konsisten -- semuanya tetap nempel ke tabel yang sama (rename gak pernah
-- ngedrop objek dependen). resolve_item_discount & resolve_bundle_promo_discounts WAJIB
-- di-CREATE OR REPLACE ulang karena body-nya hardcode nama tabel lama (nama fungsi itu sendiri
-- gak diubah, cuma referensi tabel di dalamnya).

alter table item_discount_rules rename to promotion_item_discount_rules;
alter table bundle_promo_rules rename to promotion_bundle_rules;

alter index item_discount_rules_one_active_per_item rename to promotion_item_discount_rules_one_active_per_item;
alter index item_discount_rules_one_active_per_category rename to promotion_item_discount_rules_one_active_per_category;
alter index bundle_promo_rules_one_active_per_pair rename to promotion_bundle_rules_one_active_per_pair;

alter table promotion_item_discount_rules rename constraint item_discount_rules_target_xor to promotion_item_discount_rules_target_xor;
alter table promotion_item_discount_rules rename constraint item_discount_rules_percent_max_100 to promotion_item_discount_rules_percent_max_100;

alter trigger item_discount_rules_set_updated_at on promotion_item_discount_rules rename to promotion_item_discount_rules_set_updated_at;
alter trigger bundle_promo_rules_set_updated_at on promotion_bundle_rules rename to promotion_bundle_rules_set_updated_at;

alter policy item_discount_rules_select on promotion_item_discount_rules rename to promotion_item_discount_rules_select;
alter policy item_discount_rules_insert on promotion_item_discount_rules rename to promotion_item_discount_rules_insert;
alter policy item_discount_rules_update on promotion_item_discount_rules rename to promotion_item_discount_rules_update;

alter policy bundle_promo_rules_select on promotion_bundle_rules rename to promotion_bundle_rules_select;
alter policy bundle_promo_rules_insert on promotion_bundle_rules rename to promotion_bundle_rules_insert;
alter policy bundle_promo_rules_update on promotion_bundle_rules rename to promotion_bundle_rules_update;

-- FK auto-generated (inline `references`) tetap pakai nama tabel lama sampai di-rename manual --
-- dipakai eksplisit sebagai join hint PostgREST (!bundle_promo_rules_trigger_item_id_fkey) di
-- apps/erp/src/app/(app)/promo-rules/page.tsx, jadi ikut direname + query-nya diupdate.
alter table promotion_bundle_rules rename constraint bundle_promo_rules_trigger_item_id_fkey to promotion_bundle_rules_trigger_item_id_fkey;
alter table promotion_bundle_rules rename constraint bundle_promo_rules_reward_item_id_fkey to promotion_bundle_rules_reward_item_id_fkey;

-- resolve_item_discount -- signature TIDAK berubah, cuma body-nya nunjuk ke nama tabel baru.
create or replace function resolve_item_discount(p_item_id uuid, p_qty numeric, p_amount numeric)
returns table(discount_rule_id uuid, discount_amount numeric)
language plpgsql
stable
as $$
declare
  v_category_id uuid;
  v_rule promotion_item_discount_rules%rowtype;
  v_found boolean := false;
  v_raw numeric;
begin
  select category_id into v_category_id from items where id = p_item_id;

  select * into v_rule from promotion_item_discount_rules
    where item_id = p_item_id and archived_at is null
    limit 1;
  v_found := found;

  if not v_found and v_category_id is not null then
    select * into v_rule from promotion_item_discount_rules
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

-- resolve_bundle_promo_discounts -- signature TIDAK berubah, cuma body-nya nunjuk ke nama
-- tabel baru.
create or replace function resolve_bundle_promo_discounts(p_lines jsonb)
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
      select * from promotion_bundle_rules
      where reward_item_id = v_item_id and archived_at is null
      order by id
    loop
      if v_rule_id is null then
        v_rule_id := v_rule.id;
      end if;
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
