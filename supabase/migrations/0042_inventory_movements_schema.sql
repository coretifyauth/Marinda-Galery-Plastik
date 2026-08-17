-- Kartu Stok / Riwayat Mutasi per Item (Inventory Movement Ledger).
-- Menutup memory/scope-debt/inventory-movement-ledger.md — tabel ledger terpusat baru
-- (BUKAN view gabungan, keputusan arsitektur eksplisit: baca riwayat lebih cepat & konsisten
-- jangka panjang, ditukar biaya awal lebih besar karena harus ubah ±9-10 RPC + backfill data lama).
--
-- Migration ini CUMA schema dasar (kolom production_orders.item_id + tabel inventory_movements
-- + constraint/index/RLS). RPC yang di-extend buat nulis ke tabel ini, dan backfill data historis,
-- masing-masing migration terpisah (direncanakan bertahap dari RPC paling jarang dipakai ke paling
-- sering, lihat memory/architecture/data/inventory-schema.md submodule "Kartu Stok").

-- ============================================================================
-- 1. production_orders.item_id — kolom baru, backfill dari bom_headers.finished_item_id
-- ============================================================================
-- production_orders (header hasil produksi) sebelum ini gak punya item_id langsung -- item
-- barang jadinya cuma bisa didapat gak langsung lewat bom_header_id -> bom_headers.finished_item_id.
-- Ditambah di sini supaya composite FK (production_order_id, item_id) di inventory_movements bisa
-- seragam kayak 9 tabel sumber lain (semuanya sudah punya item_id langsung) -- bukan dikecualikan
-- pakai trigger validasi terpisah.

alter table production_orders add column item_id uuid references items(id);

-- production_orders sudah punya trigger production_orders_block_edit_delete (block_edit_delete()
-- generik, before update or delete) -- backfill UPDATE di bawah ikut ketolak kalau trigger ini
-- gak dinonaktifkan sesaat. Aman: cuma ngisi kolom item_id yang BARU ditambah di atas (belum ada
-- data/consumer yang bergantung ke imutabilitasnya), gak nyentuh kolom lain yang sudah ada.
-- Diaktifkan lagi persis setelah backfill selesai.
alter table production_orders disable trigger production_orders_block_edit_delete;

update production_orders po
set item_id = bh.finished_item_id
from bom_headers bh
where po.bom_header_id = bh.id;

alter table production_orders enable trigger production_orders_block_edit_delete;

alter table production_orders alter column item_id set not null;

-- ============================================================================
-- 1b. create_production_order — perbaiki INSERT supaya ngisi item_id yang baru
-- ============================================================================
-- WAJIB deploy ATOMIK bareng kolom item_id di atas, bukan ditunda ke migration lain --
-- v_finished_item_id sudah dihitung dari bom_headers sejak awal fungsi ini (dipakai buat
-- inventory_balances di baris paling akhir), cuma belum pernah dipakai buat ngisi kolom
-- production_orders.item_id yang baru ditambah -- tanpa perbaikan ini, INSERT di bawah bakal
-- gagal violation "null value in column item_id" begitu migration ini diapply (ketauan lewat
-- schema-reviewer sebelum apply, bukan pas production order pertama coba dibuat).
-- Signature TETAP SAMA -- CREATE OR REPLACE aman, gak perlu DROP FUNCTION dulu.

create or replace function create_production_order(
  p_bom_header_id uuid,
  p_qty_produced numeric,
  p_production_date date,
  p_source_ref text,
  p_finished_good_debit_account_id uuid,
  p_raw_material_credit_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_po_id uuid := gen_random_uuid();
  v_finished_item_id uuid;
  v_output_qty numeric;
  v_batch_multiplier numeric;
  v_bom_line record;
  v_qty_needed numeric;
  v_line_cost numeric;
  v_total_raw_cost numeric := 0;
  v_entry_id uuid;
  v_unit_cost numeric;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_costs numeric[] := '{}';
  i int;
begin
  select finished_item_id, output_qty into v_finished_item_id, v_output_qty
    from bom_headers where id = p_bom_header_id;

  v_batch_multiplier := p_qty_produced / v_output_qty;

  for v_bom_line in
    select bl.raw_material_item_id, bl.qty_per_batch
    from bom_lines bl
    where bl.bom_header_id = p_bom_header_id
  loop
    v_qty_needed := v_bom_line.qty_per_batch * v_batch_multiplier;

    v_line_cost := consume_weighted_average(v_bom_line.raw_material_item_id, v_qty_needed);

    v_line_items := array_append(v_line_items, v_bom_line.raw_material_item_id);
    v_line_qtys := array_append(v_line_qtys, v_qty_needed);
    v_line_costs := array_append(v_line_costs, v_line_cost);
    v_total_raw_cost := v_total_raw_cost + v_line_cost;
  end loop;

  v_entry_id := create_journal_entry(
    p_production_date, 'Produksi ' || p_qty_produced || ' unit', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_finished_good_debit_account_id, 'debit', v_total_raw_cost, 'credit', 0),
      jsonb_build_object('account_id', p_raw_material_credit_account_id, 'debit', 0, 'credit', v_total_raw_cost)
    )
  );

  insert into production_orders (id, bom_header_id, item_id, qty_produced, production_date, source_ref, journal_entry_id, created_by)
  values (v_po_id, p_bom_header_id, v_finished_item_id, p_qty_produced, p_production_date, p_source_ref, v_entry_id, auth.uid());

  for i in 1..array_length(v_line_items, 1) loop
    insert into production_order_lines (production_order_id, item_id, qty_consumed, total_cost)
    values (v_po_id, v_line_items[i], v_line_qtys[i], v_line_costs[i]);
  end loop;

  v_unit_cost := v_total_raw_cost / p_qty_produced;

  insert into inventory_balances (item_id, qty_on_hand, avg_cost)
  values (v_finished_item_id, p_qty_produced, v_unit_cost)
  on conflict (item_id) do update
    set qty_on_hand = inventory_balances.qty_on_hand + excluded.qty_on_hand,
        avg_cost = (inventory_balances.qty_on_hand * inventory_balances.avg_cost + excluded.qty_on_hand * excluded.avg_cost)
                   / (inventory_balances.qty_on_hand + excluded.qty_on_hand),
        updated_at = now();

  return v_po_id;
end;
$$;

-- ============================================================================
-- 2. Unique (id, item_id) di tiap tabel sumber — prasyarat composite FK di bawah
-- ============================================================================
-- `id` di tiap tabel ini sudah unique (primary key) -- menambah item_id ke situ gak mengubah
-- keunikannya, cuma menyediakan target yang bisa ditunjuk composite FK. Ini yang bikin database
-- sendiri yang jamin item_id di baris inventory_movements COCOK sama item_id di baris sumber yang
-- ditunjuk, bukan cuma "ID-nya ada di tabel yang benar" (FK 1 kolom biasa gak nangkep kasus
-- "ID benar tapi item_id ketuker" -- kelas bug yang rawan muncul karena logic ini disebar ke
-- ±9-10 RPC berbeda).

alter table goods_receipt_lines add constraint goods_receipt_lines_id_item_id_key unique (id, item_id);
alter table production_orders add constraint production_orders_id_item_id_key unique (id, item_id);
alter table inventory_return_lines add constraint inventory_return_lines_id_item_id_key unique (id, item_id);
alter table stock_opname_lines add constraint stock_opname_lines_id_item_id_key unique (id, item_id);
alter table goods_issue_lines add constraint goods_issue_lines_id_item_id_key unique (id, item_id);
alter table pos_sale_lines add constraint pos_sale_lines_id_item_id_key unique (id, item_id);
alter table production_order_lines add constraint production_order_lines_id_item_id_key unique (id, item_id);
alter table purchase_return_lines add constraint purchase_return_lines_id_item_id_key unique (id, item_id);
alter table purchase_writeoff_lines add constraint purchase_writeoff_lines_id_item_id_key unique (id, item_id);
alter table warranty_replacement_lines add constraint warranty_replacement_lines_id_item_id_key unique (id, item_id);

-- ============================================================================
-- 3. inventory_movements — ledger terpusat
-- ============================================================================
-- 1 baris = 1 kejadian mutasi qty 1 item. `qty` bertanda (positif = masuk, negatif = keluar,
-- BUKAN kolom direction terpisah) supaya SUM(qty) langsung jadi saldo berjalan -- gak ada kolom
-- running_balance tersimpan sama sekali, saldo berjalan derived (opening-balance + halaman,
-- mirror report_account_ledger_opening_balance/0041, General Ledger) pas dibaca dari API, bukan
-- dihitung incremental pas insert -- pilihan ini disengaja demi akurasi (gak ada risiko nilai
-- tersimpan yang diam-diam menyimpang dari data mutasi asli) ketimbang performa tulis.
--
-- 10 kolom penunjuk sumber, semua nullable, tepat 1 yang terisi per baris (dijaga CHECK
-- num_nonnulls di bawah) -- kolom mana yang terisi = jenis mutasinya, gak perlu kolom source_type
-- teks terpisah yang rawan salah ketik pas disalin ke ±9-10 RPC berbeda.

create table inventory_movements (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references items(id),
  movement_date date not null,
  qty numeric(14,3) not null check (qty <> 0),
  created_at timestamptz not null default now(),

  goods_receipt_line_id uuid,
  production_order_id uuid,
  inventory_return_line_id uuid,
  stock_opname_line_id uuid,
  goods_issue_line_id uuid,
  pos_sale_line_id uuid,
  production_order_line_id uuid,
  purchase_return_line_id uuid,
  purchase_writeoff_line_id uuid,
  warranty_replacement_line_id uuid,

  foreign key (goods_receipt_line_id, item_id) references goods_receipt_lines(id, item_id),
  foreign key (production_order_id, item_id) references production_orders(id, item_id),
  foreign key (inventory_return_line_id, item_id) references inventory_return_lines(id, item_id),
  foreign key (stock_opname_line_id, item_id) references stock_opname_lines(id, item_id),
  foreign key (goods_issue_line_id, item_id) references goods_issue_lines(id, item_id),
  foreign key (pos_sale_line_id, item_id) references pos_sale_lines(id, item_id),
  foreign key (production_order_line_id, item_id) references production_order_lines(id, item_id),
  foreign key (purchase_return_line_id, item_id) references purchase_return_lines(id, item_id),
  foreign key (purchase_writeoff_line_id, item_id) references purchase_writeoff_lines(id, item_id),
  foreign key (warranty_replacement_line_id, item_id) references warranty_replacement_lines(id, item_id),

  -- Tepat 1 dari 10 kolom penunjuk sumber yang boleh terisi per baris -- num_nonnulls() bawaan
  -- Postgres, lebih ringkas dari rantai CASE WHEN manual buat cek "berapa yang non-null".
  check (
    num_nonnulls(
      goods_receipt_line_id, production_order_id, inventory_return_line_id,
      stock_opname_line_id, goods_issue_line_id, pos_sale_line_id,
      production_order_line_id, purchase_return_line_id, purchase_writeoff_line_id,
      warranty_replacement_line_id
    ) = 1
  )
);

-- Dipakai opening-balance query (SUM(qty) WHERE item_id=... AND movement_date < cutoff) dan
-- pagination halaman (ORDER BY movement_date, id WHERE item_id=...) -- kolom id ikut diindex buat
-- tie-break urutan yang deterministik kalau ada >1 mutasi item yang sama di tanggal yang sama.
create index inventory_movements_item_id_movement_date_id_idx
  on inventory_movements(item_id, movement_date, id);

-- Immutable, pola sama tabel transaksional lain di modul ini -- riwayat mutasi gak boleh diubah/
-- dihapus manual setelah tercatat, koreksi harus lewat transaksi pembalik di sumbernya (retur,
-- opname susulan, dst), bukan edit langsung ke baris ledger.
create trigger inventory_movements_block_edit_delete
  before update or delete on inventory_movements
  for each row execute function block_edit_delete();

-- ============================================================================
-- RLS & Grant
-- ============================================================================
-- Pola identik tabel transaksional lain: select terbuka semua authenticated (siapa pun yang login
-- boleh lihat kartu stok), insert cuma admin/accountant (baris ledger cuma boleh lahir dari RPC
-- transaksi yang sudah role-gated -- RPC create_pos_sale yang security definer tetap bisa insert
-- lewat privilege pemilik fungsi, gak butuh role cashier eksplisit di sini). Gak ada policy
-- update/delete -- immutable total, 2 lapis proteksi (RLS default-deny + trigger block_edit_delete
-- di atas), sama kayak journal_entries/goods_issue_lines/dst.

alter table inventory_movements enable row level security;

create policy inventory_movements_select on inventory_movements
  for select using (auth.role() = 'authenticated');

create policy inventory_movements_insert on inventory_movements
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

grant select, insert on inventory_movements to authenticated;
