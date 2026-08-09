-- Satuan Jual & Harga (Multi Unit of Measure) -- ref memory/scope-debt/multi-unit-of-measure.md
-- (ditutup migration ini). Gantiin items.default_price (migration 0018, di-drop di sini) --
-- item bisa dijual dalam >1 satuan (misal "buah" dan "lusin"), masing-masing punya faktor
-- konversi ke satuan dasar (items.uom, TIDAK berubah -- tetap dipakai semua pelacakan
-- stok/costing di PO/GRN/BOM/production/goods issue) dan harga sendiri, independen (bukan
-- hasil kali otomatis dari harga satuan lain -- diskon grosir itu keputusan bisnis manual).
--
-- Murni data master/referensi -- 0 perubahan ke create_goods_issue/goods_issue_lines. RPC itu
-- TETAP nerima qty di satuan dasar persis kayak sebelumnya; konversi "N satuan jual -> qty
-- satuan dasar" dan hitung "N x price satuan jual" terjadi di UI, SEBELUM RPC dipanggil.

create table item_units (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references items(id),
  unit_label text not null,
  conversion_factor numeric(14,4) not null check (conversion_factor > 0),
  price numeric(14,2) check (price is null or price >= 0),
  is_base boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((is_base and conversion_factor = 1) or not is_base),
  unique (item_id, unit_label)
);

-- Persis 1 baris "satuan dasar" per item -- unit_label baris ini konvensinya harus sama
-- persis items.uom (input-trust, gak ada trigger cross-table -- pola sama pemilihan akun
-- debit manual di create_ap_bill).
create unique index item_units_one_base_per_item
  on item_units(item_id) where is_base;

create trigger item_units_set_updated_at
  before update on item_units
  for each row execute function set_updated_at();

-- Migrasi data dari items.default_price (migration 0018) -- tiap item yang udah punya
-- default_price dimigrasi jadi 1 baris satuan dasar di sini.
insert into item_units (item_id, unit_label, conversion_factor, price, is_base)
select id, uom, 1, default_price, true
from items
where default_price is not null;

alter table items drop column default_price;

-- RLS -- pola sama bom_lines (master data mutable, anak dari item, insert/update/delete
-- bebas -- beda dari tabel transaksional immutable kayak goods_issue_lines).
alter table item_units enable row level security;

create policy item_units_select on item_units
  for select using (auth.role() = 'authenticated');

create policy item_units_insert on item_units
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

create policy item_units_update on item_units
  for update using (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

create policy item_units_delete on item_units
  for delete using (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

grant select, insert, update, delete on item_units to authenticated;
