-- 0068_sync_base_unit_label.sql
-- Satuan dasar punya dua tempat nama: items.uom dan baris item_units (is_base) -- konvensi project: keduanya HARUS sama
-- (lihat komentar createItemUnitSchema, docs/domain/inventory.md "Satuan Jual & Harga"). Selama ini konvensi itu cuma dijaga
-- UI, dan halaman Edit Item hanya mengubah items.uom, sehingga nama di item_units tertinggal.
--
-- Migration ini:
--   1. trigger: ganti items.uom otomatis mengganti unit_label baris satuan dasar barang itu, dalam transaksi yang sama.
--      Kalau nama baru bentrok dengan satuan lain barang itu (unique item_id+unit_label), update ditolak dengan pesan jelas.
--   2. memperbaiki data lama yang sudah terlanjur tidak sinkron (hanya yang tidak bentrok; yang bentrok dibiarkan dan dicatat NOTICE).
-- Tidak mengubah faktor, harga, stok, atau dokumen apa pun: nama satuan tidak disalin ke dokumen.

create function items_sync_base_unit_label() returns trigger
language plpgsql
as $$
begin
  if new.uom is distinct from old.uom then
    if exists (
      select 1 from item_units
      where item_id = new.id and not is_base and unit_label = new.uom
    ) then
      raise exception 'Barang ini sudah punya satuan jual bernama "%" -- ganti nama satuan itu dulu atau pilih nama lain', new.uom;
    end if;
    update item_units set unit_label = new.uom where item_id = new.id and is_base;
  end if;
  return new;
end;
$$;

create trigger items_sync_base_unit_label_trigger
  after update of uom on items
  for each row execute function items_sync_base_unit_label();

-- Perbaikan data lama.
do $$
declare
  r record;
begin
  for r in
    select b.id as unit_id, i.id as item_id, i.name, i.uom
    from item_units b
    join items i on i.id = b.item_id
    where b.is_base and b.unit_label is distinct from i.uom
  loop
    if exists (select 1 from item_units where item_id = r.item_id and not is_base and unit_label = r.uom) then
      raise notice 'Dilewati (nama bentrok dengan satuan lain): % -> %', r.name, r.uom;
    else
      update item_units set unit_label = r.uom where id = r.unit_id;
    end if;
  end loop;
end;
$$;
