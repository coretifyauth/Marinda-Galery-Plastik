-- 0067_report_item_flow.sql
-- Dashboard Arus Barang: satu fungsi baca, satu baris per barang. Tanpa tabel baru, tanpa penulisan.
-- Konsep: docs/domain/inventory.md "Dashboard Arus Barang (Analisis Kebutuhan)"; struktur: docs/architecture/inventory-ledger-schema.md.
--
--   * opening     = jumlah mutasi SEBELUM p_from (saldo awal periode), dari riwayat mutasi.
--   * breakdown   = array jsonb {label, in, out} per source_label view inventory_movements_with_source untuk mutasi
--                   p_from..p_to inklusif. in = jumlah qty positif, out = jumlah qty negatif (dipositifkan).
--   * current_qty = stok SEKARANG (inventory_balances) -- dasar perkiraan "cukup berapa hari".
-- Barang yang dikembalikan: punya mutasi di periode, ATAU saldo awal <> 0, ATAU stok sekarang <> 0.
-- Urut nama lalu id supaya stabil untuk paginasi .range() di client (PostgREST membatasi baris per request).
-- security invoker: RLS tabel sumber tetap berlaku.

create or replace function report_item_flow(
  p_from date,
  p_to date
)
returns table (
  item_id uuid,
  item_name text,
  uom text,
  item_type text,
  opening numeric,
  current_qty numeric,
  breakdown jsonb
)
language sql
stable
security invoker
as $$
  with moved as (
    select m.item_id,
           coalesce(m.source_label, 'Lainnya') as label,
           coalesce(sum(m.qty) filter (where m.qty > 0), 0) as q_in,
           coalesce(-sum(m.qty) filter (where m.qty < 0), 0) as q_out
    from inventory_movements_with_source m
    where m.movement_date >= p_from and m.movement_date <= p_to
    group by m.item_id, coalesce(m.source_label, 'Lainnya')
  ),
  opening_qty as (
    select im.item_id, sum(im.qty) as q
    from inventory_movements im
    where im.movement_date < p_from
    group by im.item_id
  ),
  ids as (
    select item_id from moved
    union select item_id from opening_qty where q <> 0
    union select item_id from inventory_balances where qty_on_hand <> 0
  )
  select
    i.id,
    i.name,
    i.uom,
    i.item_type,
    coalesce(o.q, 0),
    coalesce(b.qty_on_hand, 0),
    coalesce(
      (select jsonb_agg(jsonb_build_object('label', mv.label, 'in', mv.q_in, 'out', mv.q_out) order by mv.label)
       from moved mv where mv.item_id = i.id),
      '[]'::jsonb
    )
  from ids
  join items i on i.id = ids.item_id
  left join opening_qty o on o.item_id = i.id
  left join inventory_balances b on b.item_id = i.id
  order by i.name, i.id
$$;

grant execute on function report_item_flow(date, date) to authenticated;
