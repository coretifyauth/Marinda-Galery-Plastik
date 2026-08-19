-- Nutup memory/scope-debt/void-pos-sale-inventory-movement-gap.md.
--
-- void_pos_sale (0009, terakhir di-redefine 0015) sudah bener balikin
-- inventory_balances.qty_on_hand lewat UPDATE agregat, tapi gak pernah insert baris
-- kompensasi ke inventory_movements (Kartu Stok) -- riwayat mutasi tetap nunjukin barang
-- "keluar" buat transaksi yang udah dibatalkan, walau saldo real-time udah benar. Drift
-- permanen antara qty_on_hand (benar) vs SUM(inventory_movements.qty) (salah).
--
-- Pola mirror purchase_replacement_lines (0046): 1 pos_sale_line_id boleh ditunjuk lebih
-- dari 1 baris ledger (num_nonnulls di inventory_movements dicek per BARIS ledger, bukan
-- per baris sumber) -- baris kompensasi ini nunjuk ke pos_sale_line_id yang SAMA dengan
-- baris movement OUT asli dari create_pos_sale (0050), qty POSITIF (barang balik masuk).
--
-- Dicek lewat db push sebelumnya (memory/scope-debt file): belum ada riwayat void POS sale
-- di data live, jadi migration ini gak butuh backfill -- cuma nutup RPC-nya ke depan.

create or replace function void_pos_sale(
  p_sale_id uuid,
  p_entry_date date,
  p_source_ref text
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_sale record;
  v_already_voided boolean;
  v_new_revenue_entry_id uuid;
  v_line record;
begin
  select * into v_sale from pos_sales where id = p_sale_id;

  if not found then
    raise exception 'POS sale % gak ditemukan', p_sale_id;
  end if;

  select exists (
    select 1 from journal_entries je where je.reverses_entry_id = v_sale.revenue_journal_entry_id
  ) into v_already_voided;

  if v_already_voided then
    raise exception 'POS sale % udah pernah dibatalkan', v_sale.source_ref;
  end if;

  v_new_revenue_entry_id := reverse_journal_entry(v_sale.revenue_journal_entry_id, p_entry_date, p_source_ref);
  perform reverse_journal_entry(v_sale.cogs_journal_entry_id, p_entry_date, p_source_ref);

  update inventory_balances ib
    set qty_on_hand = ib.qty_on_hand + agg.qty_sold,
        updated_at = now()
    from (
      select item_id, sum(qty_sold) as qty_sold
      from pos_sale_lines
      where pos_sale_id = p_sale_id
      group by item_id
    ) agg
    where ib.item_id = agg.item_id;

  for v_line in select id, item_id, qty_sold from pos_sale_lines where pos_sale_id = p_sale_id loop
    insert into inventory_movements (item_id, movement_date, qty, pos_sale_line_id)
    values (v_line.item_id, p_entry_date, v_line.qty_sold, v_line.id);
  end loop;

  return v_new_revenue_entry_id;
end;
$$;
