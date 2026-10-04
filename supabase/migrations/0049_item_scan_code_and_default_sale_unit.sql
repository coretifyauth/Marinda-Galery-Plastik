-- Kode scan level barang (items.barcode) + satuan jual default (item_units.is_default_sale).
-- Ref: docs/domain/inventory.md submodule "Kode Scan Barang", docs/architecture/items-schema.md.
--
-- Konteks: sebelumnya kode scan CUMA ada per satuan jual (item_units.barcode) -- barang
-- tanpa label pabrik (kasus umum toko plastik) jadi harus dicetak 1 label per satuan. Sekarang
-- ada 2 level, keduanya opsional dan boleh dipakai bareng:
--   * items.barcode            -> 1 kode per barang; scan masuk keranjang POS di satuan jual
--                                 default barang itu (item_units.is_default_sale), atau satuan
--                                 dasar kalau belum ada yang ditandai (fallback di aplikasi).
--   * item_units.barcode       -> tetap seperti sebelumnya, satuan persis yang discan.
-- Cuma POS yang pakai satuan default -- Sales Order/Goods Issue/katalog POS gak berubah.
-- create_pos_sale TIDAK diubah (tetap nerima qty & harga satuan dasar).

-- 1. Kolom baru
alter table items add column barcode text unique;

alter table item_units add column is_default_sale boolean not null default false;

-- Kode kosong/spasi doang dianggap bukan kode (bakal bikin semua barang lain ditolak "kode sudah
-- dipakai"). items.barcode kolom baru -> langsung di-enforce; item_units.barcode sudah ada sejak
-- 0005 dan datanya belum tentu bersih -> NOT VALID (baris baru/yang di-update dicek, baris lama
-- gak discan ulang).
alter table items add constraint items_barcode_not_blank
  check (barcode is null or btrim(barcode) <> '');
alter table item_units add constraint item_units_barcode_not_blank
  check (barcode is null or btrim(barcode) <> '') not valid;

comment on column items.barcode is 'Kode scan level barang (opsional). Unik lintas items.barcode DAN item_units.barcode -- dijaga trigger check_scan_code_unique_across_tables.';
comment on column item_units.is_default_sale is 'Satuan jual default buat scan items.barcode di POS. Maks 1 per item, wajib punya price. Gak ada yang ditandai = fallback ke satuan dasar (is_base) di sisi aplikasi.';

-- Satuan default wajib punya harga jual -- satuan tanpa harga gak bisa dijual di POS.
alter table item_units add constraint item_units_default_sale_needs_price
  check (not is_default_sale or price is not null);

create unique index item_units_one_default_sale_per_item
  on item_units(item_id) where is_default_sale;

-- Harga satuan default dikosongkan -> tanda default dicabut otomatis (balik fallback satuan
-- dasar), bukan ditolak. BEFORE trigger jalan sebelum CHECK constraint, jadi UPDATE price=null
-- pada baris default lolos. Insert / set is_default_sale=true bareng price null tetap ditolak
-- constraint (old.is_default_sale false -> trigger gak nyentuh).
create function item_units_clear_default_on_price_null() returns trigger
language plpgsql
as $$
begin
  if new.price is null and old.is_default_sale and new.is_default_sale then
    new.is_default_sale := false;
  end if;
  return new;
end;
$$;

create trigger item_units_clear_default_on_price_null_trigger
  before update of price on item_units
  for each row execute function item_units_clear_default_on_price_null();

-- 2. Keunikan kode lintas 2 tabel -- unique index gak bisa lintas tabel, jadi pakai trigger.
-- Advisory lock per kode biar 2 insert bersamaan dengan kode sama (beda tabel) gak lolos
-- dua-duanya. Pakai errcode unique_violation supaya retry-on-conflict di RPC generate_*
-- bekerja sama untuk bentrokan lintas tabel.
create function check_scan_code_unique_across_tables() returns trigger
language plpgsql
as $$
begin
  if new.barcode is null then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext('scan_code:' || new.barcode));

  if tg_table_name = 'items' then
    if exists (select 1 from item_units where barcode = new.barcode) then
      raise exception 'Kode scan % sudah dipakai satuan jual barang lain', new.barcode
        using errcode = 'unique_violation';
    end if;
  else
    if exists (select 1 from items where barcode = new.barcode) then
      raise exception 'Kode scan % sudah dipakai sebagai kode barang', new.barcode
        using errcode = 'unique_violation';
    end if;
  end if;

  return new;
end;
$$;

create trigger items_scan_code_unique_across_tables
  before insert or update of barcode on items
  for each row execute function check_scan_code_unique_across_tables();

create trigger item_units_scan_code_unique_across_tables
  before insert or update of barcode on item_units
  for each row execute function check_scan_code_unique_across_tables();

-- 3. RPC
-- set_item_default_sale_unit -- ganti satuan default atomik (unique index parsial gak bisa
-- deferred, jadi "cabut yang lama lalu pasang yang baru" harus 1 transaksi). p_unit_id null
-- gak didukung di sini; buat nyabut default tanpa ganti, kirim unit_id satuan yang mau dicabut
-- ke clear_item_default_sale_unit (di bawah).
create function set_item_default_sale_unit(p_unit_id uuid) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item_id uuid;
  v_price numeric;
begin
  if not exists (
    select 1 from app_user_roles ur
    where ur.user_id = auth.uid() and ur.role_name = 'admin'
  ) then
    raise exception 'Cuma admin yang boleh mengatur satuan jual default';
  end if;

  select item_id, price into v_item_id, v_price from item_units where id = p_unit_id;
  if v_item_id is null then
    raise exception 'Satuan jual tidak ditemukan';
  end if;

  -- Serialisasi 2 admin yang ganti default barang yang sama bersamaan, biar yang kalah dapat
  -- hasil bersih (bukan unique_violation mentah dari index parsial).
  perform 1 from items where id = v_item_id for update;
  if v_price is null then
    raise exception 'Satuan jual default wajib punya harga jual';
  end if;

  update item_units set is_default_sale = false
    where item_id = v_item_id and is_default_sale and id <> p_unit_id;
  update item_units set is_default_sale = true where id = p_unit_id;
end;
$$;

create function clear_item_default_sale_unit(p_item_id uuid) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from app_user_roles ur
    where ur.user_id = auth.uid() and ur.role_name = 'admin'
  ) then
    raise exception 'Cuma admin yang boleh mengatur satuan jual default';
  end if;

  update item_units set is_default_sale = false where item_id = p_item_id and is_default_sale;
end;
$$;

-- generate_item_barcode -- pola sama generate_item_unit_barcode (0005): pakai counter
-- 'item_unit_barcodes' yang SAMA (prefix SKU-), jadi kode barang & kode satuan hasil generate
-- gak pernah bentrok satu sama lain. Retry-on-conflict kalau kode hasil generate ternyata
-- sudah dipakai (mis. kode diketik manual).
create function generate_item_barcode(p_item_id uuid) returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_code text;
  v_attempt int := 0;
  v_max_attempts constant int := 20;
begin
  if not exists (
    select 1 from app_user_roles ur
    where ur.user_id = auth.uid() and ur.role_name = 'admin'
  ) then
    raise exception 'Cuma admin yang boleh generate kode scan';
  end if;

  if not exists (select 1 from items where id = p_item_id) then
    raise exception 'Barang tidak ditemukan';
  end if;

  loop
    v_attempt := v_attempt + 1;
    v_code := generate_document_number('item_unit_barcodes');
    begin
      update items set barcode = v_code where id = p_item_id;
      if not found then
        raise exception 'Barang tidak ditemukan atau sudah dihapus';
      end if;
      return v_code;
    exception when unique_violation then
      if v_attempt >= v_max_attempts then
        raise exception 'Gagal generate kode scan unik setelah % percobaan', v_attempt;
      end if;
      -- kode ini hangus (counter sudah maju) -- lanjut loop coba nomor berikutnya
    end;
  end loop;
end;
$$;

grant execute on function set_item_default_sale_unit(uuid) to authenticated;
grant execute on function clear_item_default_sale_unit(uuid) to authenticated;
grant execute on function generate_item_barcode(uuid) to authenticated;
