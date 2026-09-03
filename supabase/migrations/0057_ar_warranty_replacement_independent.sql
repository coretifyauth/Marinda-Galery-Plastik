-- AR Warranty Replacement — diseragamkan jadi mutually exclusive kayak AP (keputusan owner,
-- 2026-09-03, lihat memory/scope-debt/ar-retur-mutually-exclusive.md sebelum ditutup).
--
-- Konteks: create_warranty_replacement dulu WAJIB nunjuk credit_note_id yang sudah lebih dulu
-- mencatat retur fisik + diskon (ar_credit_notes.amount, SELALU > 0 -- setiap credit note pasti
-- ngurangin piutang, gak ada jalur "amount = 0"). Kalau replacement dipanggil buat qty yang sama,
-- migration 0037 mewajibkan pembalikan proporsional diskon itu (discount_reversed_amount) biar
-- gak dobel kompensasi -- strategi "izinkan lalu koreksi".
--
-- Keputusan baru: 1 qty fisik cuma boleh diklaim SATU jalur (kredit ATAU ganti barang), dicegah
-- dari awal -- bukan diizinkan-lalu-dikoreksi. create_warranty_replacement sekarang INDEPENDEN,
-- nunjuk invoice_id langsung (bukan credit_note_id) -- mirror create_purchase_replacement (AP)
-- yang independen dari awal, nunjuk bill_id langsung, gak pernah butuh credit note ada duluan.
-- Fungsi baru sales_returned_qty() mirror purchase_returned_qty() (AP): jumlah qty yang udah
-- diklaim LINTAS SEMUA jalur (retur kredit + ganti barang) buat 1 item di 1 invoice, dipakai
-- jaga qty fisik yang sama gak bisa diklaim dobel -- ini yang beneran nyegah kompensasi ganda
-- dari akarnya, gantiin mekanisme reversal yang cuma mengoreksi belakangan.
--
-- credit_note_id TETAP ada di warranty_replacements (jadi nullable) -- baris HISTORIS (data
-- lama) tetap nunjuk situ. Kolom reversal (discount_reversed_amount dkk) juga TETAP ada buat
-- histori, RPC baru gak pernah ngisi (selalu default 0/NULL) -- gak ada backfill mundur,
-- kebijakan baru cuma berlaku ke transaksi baru.
--
-- Signature create_warranty_replacement BERUBAH TOTAL (bukan cuma nambah param) -- WAJIB drop
-- function lama dulu sebelum create baru, kalau enggak Postgres bikin overload ambigu (pelajaran
-- dari bug 0011/0012 create_ap_bill, sudah pernah kejadian persis di project ini).

-- ============================================================
-- 1. invoice_id: tambah, backfill dari credit_note_id, jadikan wajib. credit_note_id: jadi
--    nullable (baris baru gak lagi lewat jalur ini).
-- ============================================================

alter table warranty_replacements add column invoice_id uuid references ar_invoices(id);

-- warranty_replacements sudah punya trigger warranty_replacements_block_edit_delete
-- (block_edit_delete() generik, before update or delete, tolak SEMUA update tanpa syarat) --
-- backfill UPDATE di bawah ikut ketolak kalau trigger ini gak dinonaktifkan sesaat. Aman: cuma
-- ngisi kolom invoice_id yang BARU ditambah di atas (belum ada data/consumer yang bergantung ke
-- imutabilitasnya), gak nyentuh kolom lain yang sudah ada. Diaktifkan lagi persis setelah
-- backfill selesai -- pola sama persis 0042_inventory_movements_schema.sql (backfill
-- production_orders.item_id), ketauan schema-reviewer waktu 0057 belum pakai pola ini.
alter table warranty_replacements disable trigger warranty_replacements_block_edit_delete;

update warranty_replacements wr
  set invoice_id = acn.invoice_id
  from ar_credit_notes acn
  where wr.credit_note_id = acn.id;

alter table warranty_replacements enable trigger warranty_replacements_block_edit_delete;

alter table warranty_replacements alter column invoice_id set not null;
alter table warranty_replacements alter column credit_note_id drop not null;

create index warranty_replacements_invoice_id_idx on warranty_replacements(invoice_id);

-- ============================================================
-- 2. sales_returned_qty(invoice_id, item_id) — mirror purchase_returned_qty(bill_id, item_id)
--    di ap-schema.md. Gabungan qty yang udah "diklaim" dari 1 item di 1 invoice, lintas retur
--    kredit (inventory_return_lines via ar_credit_notes) + ganti barang (warranty_replacement_lines
--    via invoice_id langsung, jalur baru).
-- ============================================================

create function sales_returned_qty(p_invoice_id uuid, p_item_id uuid) returns numeric as $$
  select
    coalesce((
      select sum(irl.qty_returned) from inventory_return_lines irl
      join inventory_returns ir on ir.id = irl.inventory_return_id
      join ar_credit_notes acn on acn.id = ir.credit_note_id
      where acn.invoice_id = p_invoice_id and irl.item_id = p_item_id
    ), 0)
    +
    coalesce((
      select sum(wrl.qty_replaced) from warranty_replacement_lines wrl
      join warranty_replacements wr on wr.id = wrl.warranty_replacement_id
      where wr.invoice_id = p_invoice_id and wrl.item_id = p_item_id
    ), 0);
$$ language sql stable;

-- ============================================================
-- 2b. Trigger inventory_return_lines_guard ditulis ulang — INI ARAH YANG SEBELUMNYA KELEWAT
--    (ketauan schema-reviewer). sales_returned_qty() di atas cuma percuma kalau baru dipakai
--    1 arah (warranty_replacement_lines) doang -- trigger yang jaga arah SATUNYA (retur lewat
--    ar_credit_notes/inventory_return_lines) juga wajib ikut cek qty gabungan, kalau enggak
--    customer masih bisa dapat kompensasi ganda lewat urutan kebalik: replacement dulu, retur
--    kredit belakangan buat qty fisik yang sama -- persis skenario yang migration ini dibikin
--    buat mencegah. Mirror penuh: kedua arah sekarang baca sales_returned_qty() yang sama,
--    persis pola purchase_return_lines_no_over_return + purchase_replacement_lines_no_over_return
--    yang dua-duanya baca purchase_returned_qty() yang sama (ap-schema.md).
-- ============================================================

create or replace function inventory_return_lines_guard() returns trigger as $$
declare
  v_goods_issue_id uuid;
  v_invoice_id uuid;
  v_qty_issued numeric;
  v_already_claimed numeric;
begin
  select ir.goods_issue_id into v_goods_issue_id
    from inventory_returns ir where ir.id = new.inventory_return_id;

  select gi.invoice_id into v_invoice_id
    from goods_issues gi where gi.id = v_goods_issue_id;

  select gil.qty_issued into v_qty_issued
    from goods_issue_lines gil
    where gil.goods_issue_id = v_goods_issue_id and gil.item_id = new.item_id;

  if not found then
    raise exception 'Item % gak ada di goods_issue %, gak bisa diretur', new.item_id, v_goods_issue_id;
  end if;

  select sales_returned_qty(v_invoice_id, new.item_id) into v_already_claimed;

  if v_already_claimed + new.qty_returned > v_qty_issued then
    raise exception 'Retur item % melebihi qty terjual dikurangi yang udah diklaim lewat retur/ganti barang (terjual %, udah diklaim %, coba retur %)',
      new.item_id, v_qty_issued, v_already_claimed, new.qty_returned;
  end if;

  return new;
end;
$$ language plpgsql;

-- ============================================================
-- 3. Trigger warranty_replacement_lines_no_over_replace ditulis ulang — dari "batasi ke
--    inventory_return_lines 1 credit note" jadi "batasi ke goods_issue_lines.qty_issued
--    dikurangi sales_returned_qty()" — mirror persis purchase_replacement_lines_no_over_return
--    (ap-schema.md). CREATE OR REPLACE aman di sini, param/return type trigger function gak
--    berubah (selalu 0 param, returns trigger).
-- ============================================================

create or replace function warranty_replacement_lines_no_over_replace() returns trigger as $$
declare
  v_invoice_id uuid;
  v_goods_issue_id uuid;
  v_qty_issued numeric;
  v_already_claimed numeric;
  v_item_name text;
begin
  select wr.invoice_id into v_invoice_id
    from warranty_replacements wr where wr.id = new.warranty_replacement_id;

  select gi.id into v_goods_issue_id from goods_issues gi where gi.invoice_id = v_invoice_id;

  if v_goods_issue_id is null then
    raise exception 'Invoice % gak punya goods_issue (financial-only) — gak bisa ganti barang', v_invoice_id;
  end if;

  select gil.qty_issued into v_qty_issued
    from goods_issue_lines gil
    where gil.goods_issue_id = v_goods_issue_id and gil.item_id = new.item_id;

  if not found then
    select name into v_item_name from items where id = new.item_id;
    raise exception 'Item "%" gak ada di goods_issue invoice %, gak bisa diganti', v_item_name, v_invoice_id;
  end if;

  select sales_returned_qty(v_invoice_id, new.item_id) into v_already_claimed;

  if v_already_claimed + new.qty_replaced > v_qty_issued then
    select name into v_item_name from items where id = new.item_id;
    raise exception 'Penggantian item "%" melebihi qty terjual dikurangi yang udah diklaim (terjual %, udah diklaim lewat retur/ganti barang %, coba ganti %)',
      v_item_name, v_qty_issued, v_already_claimed, new.qty_replaced;
  end if;

  return new;
end;
$$ language plpgsql;

-- ============================================================
-- 4. create_warranty_replacement — signature baru, jauh lebih sederhana karena gak ada lagi
--    logic reversal diskon / settlement saldo kredit retur (jalur baru gak pernah nyentuh
--    ar_credit_notes/ar_return_credits sama sekali).
-- ============================================================

drop function if exists create_warranty_replacement(uuid, date, text, jsonb, uuid, uuid, uuid, uuid, uuid);

create function create_warranty_replacement(
  p_invoice_id uuid,
  p_replacement_date date,
  p_source_ref text,
  p_lines jsonb, -- array of {"item_id":uuid,"qty":numeric}
  p_hpp_account_id uuid,
  p_finished_good_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_replacement_id uuid := gen_random_uuid();
  v_line jsonb;
  v_item_id uuid;
  v_qty numeric;
  v_line_cost numeric;
  v_total_cost numeric := 0;
  v_entry_id uuid;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_costs numeric[] := '{}';
  i int;
  v_line_id uuid;
begin
  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'Penukaran barang butuh minimal 1 baris item';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_item_id := (v_line->>'item_id')::uuid;
    v_qty := (v_line->>'qty')::numeric;

    v_line_cost := consume_weighted_average(v_item_id, v_qty);

    v_line_items := array_append(v_line_items, v_item_id);
    v_line_qtys := array_append(v_line_qtys, v_qty);
    v_line_costs := array_append(v_line_costs, v_line_cost);
    v_total_cost := v_total_cost + v_line_cost;
  end loop;

  v_entry_id := create_journal_entry(
    p_replacement_date, 'Penukaran barang pasca-retur/garansi', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_hpp_account_id, 'debit', v_total_cost, 'credit', 0),
      jsonb_build_object('account_id', p_finished_good_account_id, 'debit', 0, 'credit', v_total_cost)
    )
  );

  insert into warranty_replacements (id, invoice_id, replacement_date, source_ref, journal_entry_id, created_by)
  values (v_replacement_id, p_invoice_id, p_replacement_date, p_source_ref, v_entry_id, auth.uid());

  for i in 1..array_length(v_line_items, 1) loop
    insert into warranty_replacement_lines (warranty_replacement_id, item_id, qty_replaced, total_cost)
    values (v_replacement_id, v_line_items[i], v_line_qtys[i], v_line_costs[i])
    returning id into v_line_id;

    insert into inventory_movements (item_id, movement_date, qty, warranty_replacement_line_id)
    values (v_line_items[i], p_replacement_date, -v_line_qtys[i], v_line_id);
  end loop;

  return v_replacement_id;
end;
$$;

-- ============================================================
-- 5. warranty_replacements_sync_invoice_status (0053_denormalize_transactional_status.sql)
--    diperbaiki -- dulu resolve invoice_id lewat "select invoice_id from ar_credit_notes where
--    id = new.credit_note_id", yang sejak sekarang SELALU balikin NULL buat baris baru
--    (credit_note_id NULL) -- recompute_ar_invoice_status jadi gak pernah kepanggil buat
--    warranty replacement jalur baru (silent no-op, ketauan schema-reviewer). Kebetulan gak
--    mengubah hasil apa pun HARI INI (RPC baru gak pernah ngisi discount_reversed_amount/
--    return_credit_settled_amount, dan ar_invoice_remaining() inner-join ke ar_credit_notes
--    juga cuma keitung baris lama) -- tapi kodenya nyesatin & rawan reintroduce bug serupa
--    0028 kalau nanti ada reducer baru yang nempel di jalur ini. Disederhanakan pola sama
--    goods_issues_sync_invoice_status -- baca new.invoice_id langsung, gak perlu lookup lagi.
-- ============================================================

create or replace function warranty_replacements_sync_invoice_status() returns trigger as $$
begin
  perform recompute_ar_invoice_status(new.invoice_id);
  return new;
end;
$$ language plpgsql;
