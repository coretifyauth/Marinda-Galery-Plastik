-- Kartu Stok — RPC #4 dari rangkaian bertahap (retur ke supplier, 2 opsi saling eksklusif). Lihat
-- memory/architecture/data/inventory-schema.md submodule "Kartu Stok / Riwayat Mutasi per Item"
-- > "Rencana Bertahap".
--
-- GAP DITEMUKAN & DITUTUP DI SINI: `purchase_replacement_lines` (RPC create_purchase_replacement,
-- "Opsi B -- tukar barang") gak pernah masuk daftar ±10 tabel sumber asli (memory/scope-debt/
-- inventory-movement-ledger.md, dan desain 10-kolom inventory_movements di migration 0042) --
-- padahal RPC ini menggerakkan stok fisik nyata (barang rusak KELUAR, barang pengganti MASUK,
-- walau efek bersih ke qty_on_hand akhirnya nol karena item yang sama). Ditutup di sini: kolom
-- ke-11 ditambah ke inventory_movements + composite FK + CHECK diperluas. 1 baris
-- purchase_replacement_lines sekarang menghasilkan 2 baris inventory_movements (1 negatif, 1
-- positif) -- beda dari 9 sumber lain yang selalu 1:1, tapi gak melanggar constraint manapun
-- (num_nonnulls=1 dicek per BARIS ledger, bukan per baris sumber -- 2 baris ledger boleh nunjuk
-- ke 1 baris sumber yang sama).

-- ============================================================================
-- 1. Kolom ke-11: purchase_replacement_line_id
-- ============================================================================

alter table purchase_replacement_lines
  add constraint purchase_replacement_lines_id_item_id_key unique (id, item_id);

alter table inventory_movements
  add column purchase_replacement_line_id uuid;

alter table inventory_movements
  add constraint inventory_movements_purchase_replacement_line_id_fkey
  foreign key (purchase_replacement_line_id, item_id)
  references purchase_replacement_lines(id, item_id);

-- CHECK num_nonnulls lama (migration 0042) cuma tau 10 kolom -- dicari lewat DEFINISI constraint
-- (bukan nama yang ditebak, karena gak dikasih nama eksplisit pas 0042 nulisnya), baru diganti
-- versi yang tau 11 kolom.
do $$
declare
  v_constraint_name text;
begin
  select conname into v_constraint_name
  from pg_constraint
  where conrelid = 'inventory_movements'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%num_nonnulls%';

  if v_constraint_name is not null then
    execute format('alter table inventory_movements drop constraint %I', v_constraint_name);
  end if;
end $$;

alter table inventory_movements add constraint inventory_movements_exactly_one_source check (
  num_nonnulls(
    goods_receipt_line_id, production_order_id, inventory_return_line_id,
    stock_opname_line_id, goods_issue_line_id, pos_sale_line_id,
    production_order_line_id, purchase_return_line_id, purchase_writeoff_line_id,
    warranty_replacement_line_id, purchase_replacement_line_id
  ) = 1
);

-- ============================================================================
-- 2. create_ap_credit_note — tambah ledger insert buat purchase_return_lines (OUT)
-- ============================================================================
-- Cuma jalur retur FISIK (p_lines terisi) yang nyentuh stok/ledger -- jalur financial-only
-- (p_lines null/kosong) gak pernah insert purchase_return_lines sama sekali, jadi otomatis gak
-- pernah insert ke inventory_movements juga (konsisten sama badge Financial-Only vs Full yang
-- sudah ada di UI). Signature TETAP SAMA -- CREATE OR REPLACE aman.

create or replace function create_ap_credit_note(
  p_bill_id uuid,
  p_credit_note_date date,
  p_source_ref text,
  p_amount numeric,
  p_payable_account_id uuid,
  p_credit_account_id uuid,
  p_lines jsonb default null, -- array of {"item_id":uuid,"qty_returned":numeric}
  p_return_credit_asset_account_id uuid default null
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_remaining_before numeric;
  v_effective_amount numeric;
  v_entry_id uuid;
  v_credit_note_id uuid;
  v_grn_id uuid;
  v_line jsonb;
  v_item_id uuid;
  v_qty_returned numeric;
  v_line_cost numeric;
  v_total_cost_returned numeric := 0;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_costs numeric[] := '{}';
  i int;
  v_excess numeric;
  v_supplier_id uuid;
  v_return_credit_entry_id uuid;
  v_line_id uuid;
begin
  select ap_bill_remaining(p_bill_id) into v_remaining_before;

  if p_lines is not null and jsonb_array_length(p_lines) > 0 then
    select id into v_grn_id from goods_receipt_notes where bill_id = p_bill_id;

    if v_grn_id is null then
      raise exception 'Bill % gak punya goods_receipt_notes -- gak bisa retur stok', p_bill_id;
    end if;

    for v_line in select * from jsonb_array_elements(p_lines)
    loop
      v_item_id := (v_line->>'item_id')::uuid;
      v_qty_returned := (v_line->>'qty_returned')::numeric;

      v_line_cost := consume_weighted_average(v_item_id, v_qty_returned);

      v_line_items := array_append(v_line_items, v_item_id);
      v_line_qtys := array_append(v_line_qtys, v_qty_returned);
      v_line_costs := array_append(v_line_costs, v_line_cost);
      v_total_cost_returned := v_total_cost_returned + v_line_cost;
    end loop;

    v_effective_amount := v_total_cost_returned;
  else
    v_effective_amount := p_amount;
  end if;

  v_entry_id := create_journal_entry(
    p_credit_note_date, 'Retur barang ke supplier', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_payable_account_id, 'debit', v_effective_amount, 'credit', 0),
      jsonb_build_object('account_id', p_credit_account_id, 'debit', 0, 'credit', v_effective_amount)
    )
  );

  insert into ap_credit_notes (bill_id, credit_note_date, source_ref, amount, journal_entry_id, created_by)
  values (p_bill_id, p_credit_note_date, p_source_ref, v_effective_amount, v_entry_id, auth.uid())
  returning id into v_credit_note_id;

  if array_length(v_line_items, 1) is not null then
    for i in 1..array_length(v_line_items, 1) loop
      insert into purchase_return_lines (credit_note_id, item_id, qty_returned, total_cost)
      values (v_credit_note_id, v_line_items[i], v_line_qtys[i], v_line_costs[i])
      returning id into v_line_id;

      insert into inventory_movements (item_id, movement_date, qty, purchase_return_line_id)
      values (v_line_items[i], p_credit_note_date, -v_line_qtys[i], v_line_id);
    end loop;
  end if;

  v_excess := greatest(0, v_effective_amount - greatest(0, v_remaining_before));

  if v_excess > 0 then
    if p_return_credit_asset_account_id is null then
      raise exception 'Retur % bikin Utang Usaha jadi minus (excess %) -- wajib isi p_return_credit_asset_account_id',
        p_source_ref, v_excess;
    end if;

    select supplier_id into v_supplier_id from ap_bills where id = p_bill_id;

    v_return_credit_entry_id := create_journal_entry(
      p_credit_note_date, 'Piutang retur dari supplier', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_return_credit_asset_account_id, 'debit', v_excess, 'credit', 0),
        jsonb_build_object('account_id', p_payable_account_id, 'debit', 0, 'credit', v_excess)
      )
    );

    insert into ap_return_credits (supplier_id, credit_note_id, amount, journal_entry_id, created_by)
    values (v_supplier_id, v_credit_note_id, v_excess, v_return_credit_entry_id, auth.uid());
  end if;

  return v_credit_note_id;
end;
$$;

-- ============================================================================
-- 3. create_purchase_replacement — 2 baris ledger per line (OUT rusak + IN pengganti)
-- ============================================================================
-- Beda dari semua RPC ledger lain sejauh ini: 1 baris purchase_replacement_lines = 2 baris
-- inventory_movements (item yang sama, qty sama besar, tanda berlawanan) -- merepresentasikan 2
-- kejadian fisik nyata (barang rusak keluar, barang pengganti masuk) walau net ke qty_on_hand
-- akhirnya nol. Signature TETAP SAMA -- CREATE OR REPLACE aman.

create or replace function create_purchase_replacement(
  p_bill_id uuid,
  p_replacement_date date,
  p_source_ref text,
  p_lines jsonb, -- array of {"item_id":uuid,"qty":numeric}
  p_inventory_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_grn_id uuid;
  v_replacement_id uuid;
  v_line jsonb;
  v_item_id uuid;
  v_qty numeric;
  v_line_cost numeric;
  v_unit_cost numeric;
  v_total_cost numeric := 0;
  v_qty_before numeric;
  v_avg_before numeric;
  v_entry_id uuid;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_costs numeric[] := '{}';
  i int;
  v_line_id uuid;
begin
  select id into v_grn_id from goods_receipt_notes where bill_id = p_bill_id;

  if v_grn_id is null then
    raise exception 'Bill % gak punya goods_receipt_notes -- gak bisa tukar barang per item', p_bill_id;
  end if;

  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'Tukar barang butuh minimal 1 baris item';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_item_id := (v_line->>'item_id')::uuid;
    v_qty := (v_line->>'qty')::numeric;

    v_line_cost := consume_weighted_average(v_item_id, v_qty);
    v_unit_cost := v_line_cost / v_qty;

    select qty_on_hand, avg_cost into v_qty_before, v_avg_before
      from inventory_balances where item_id = v_item_id;

    update inventory_balances
      set qty_on_hand = v_qty_before + v_qty,
          avg_cost = (v_qty_before * v_avg_before + v_qty * v_unit_cost) / (v_qty_before + v_qty),
          updated_at = now()
      where item_id = v_item_id;

    v_line_items := array_append(v_line_items, v_item_id);
    v_line_qtys := array_append(v_line_qtys, v_qty);
    v_line_costs := array_append(v_line_costs, v_line_cost);
    v_total_cost := v_total_cost + v_line_cost;
  end loop;

  v_entry_id := create_journal_entry(
    p_replacement_date, 'Tukar barang rusak dengan barang baik dari supplier', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_inventory_account_id, 'debit', v_total_cost, 'credit', 0),
      jsonb_build_object('account_id', p_inventory_account_id, 'debit', 0, 'credit', v_total_cost)
    )
  );

  insert into purchase_replacements (bill_id, replacement_date, source_ref, journal_entry_id, created_by)
  values (p_bill_id, p_replacement_date, p_source_ref, v_entry_id, auth.uid())
  returning id into v_replacement_id;

  for i in 1..array_length(v_line_items, 1) loop
    insert into purchase_replacement_lines (purchase_replacement_id, item_id, qty_replaced, total_cost)
    values (v_replacement_id, v_line_items[i], v_line_qtys[i], v_line_costs[i])
    returning id into v_line_id;

    -- barang rusak KELUAR (dikonsumsi di loop atas)
    insert into inventory_movements (item_id, movement_date, qty, purchase_replacement_line_id)
    values (v_line_items[i], p_replacement_date, -v_line_qtys[i], v_line_id);

    -- barang pengganti MASUK (ditambahkan balik di loop atas, item & qty sama)
    insert into inventory_movements (item_id, movement_date, qty, purchase_replacement_line_id)
    values (v_line_items[i], p_replacement_date, v_line_qtys[i], v_line_id);
  end loop;

  return v_replacement_id;
end;
$$;
