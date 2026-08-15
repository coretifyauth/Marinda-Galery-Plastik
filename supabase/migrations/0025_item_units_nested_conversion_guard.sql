-- scope-debt stock-display-uom-breakdown: syarat sebelum breakdown greedy stok (box/pack/pcs)
-- bisa diandalkan -- conversion_factor antar item_units 1 item harus nested rapi (tiap
-- angka kelipatan bulat dari angka di bawahnya), biar floor(sisa/factor) gak nyisain
-- pecahan gak presisi. Trigger ini pengaman DB level (berlaku walau insert/update langsung
-- dari Supabase Studio, bukan cuma lewat UI aplikasi -- lihat memory/architecture/data/inventory-schema.md).

-- Backfill check: item yang udah ada item_units-nya SEBELUM migration ini harus lolos
-- juga -- kalau enggak, trigger baru cuma bakal ke-trigger belakangan pas ada yang
-- iseng nambah/edit satuan lain buat item itu (nyalahin baris yang gak terkait).
-- Ketauan sekarang, pas migration, bukan kejutan nanti.
do $$
declare
  bad_item record;
begin
  for bad_item in
    select item_id, array_agg(conversion_factor order by conversion_factor) as factors
    from item_units
    group by item_id
    having count(*) > 1
  loop
    if exists (
      select 1
      from unnest(bad_item.factors) with ordinality as t(f, i)
      join unnest(bad_item.factors) with ordinality as p(f, i) on p.i = t.i - 1
      where t.f <> p.f and mod(t.f, p.f) <> 0
    ) then
      raise exception
        'item_units item_id % udah punya conversion_factor gak nested rapi (%) -- benerin datanya dulu sebelum migration ini bisa jalan',
        bad_item.item_id, bad_item.factors;
    end if;
  end loop;
end $$;

create or replace function check_item_units_nested_conversion() returns trigger
language plpgsql
as $$
declare
  factors numeric(14,4)[];
  f numeric(14,4);
  prev numeric(14,4);
begin
  -- lock baris sibling item yang sama biar gak ada 2 transaksi concurrent lolos
  -- validasi masing-masing sendiri-sendiri terus kombinasinya jadi gak nested
  -- (item_units master data low-traffic, lock ini murah).
  perform 1 from item_units where item_id = new.item_id and id is distinct from new.id for update;

  select array_agg(conversion_factor order by conversion_factor)
    into factors
  from item_units
  where item_id = new.item_id
    and id is distinct from new.id;

  factors := array_append(factors, new.conversion_factor);
  select array_agg(x order by x) into factors from unnest(factors) x;

  prev := null;
  foreach f in array factors loop
    if prev is not null and f <> prev and mod(f, prev) <> 0 then
      raise exception
        'Faktor konversi satuan harus kelipatan bulat dari satuan lain di item yang sama (nested rapi) -- % bukan kelipatan %',
        f, prev;
    end if;
    prev := f;
  end loop;

  return new;
end;
$$;

create trigger item_units_nested_conversion_guard
  before insert or update of conversion_factor on item_units
  for each row execute function check_item_units_nested_conversion();
