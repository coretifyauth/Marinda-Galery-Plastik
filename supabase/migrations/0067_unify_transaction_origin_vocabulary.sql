-- Sisa Pekerjaan #3 (memory/scope-debt/ar-ap-unify-transactions.md) -- unifikasi
-- vocabulary transactions.origin. Sebelum ini: AR pakai financial_only/sales_order/
-- goods_issue, AP pakai langsung/grn -- 2 vocabulary beda buat konsep yang sama
-- ("invoice/bill ini lahir dari mana"). Diputuskan di Fase 1 desain awal (0063) tapi
-- ditunda, dicatat sebagai item non-blocking.
--
-- Nomor migration ini SENGAJA 0067, bukan 0066 -- 0066 dipakai duluan buat bug fix kritis
-- (transactions_block_edit_delete generik nolak update recompute_transaction_status,
-- ketauan review migration ini) yang harus live SEBELUM migration ini, biar `do $$` di
-- bawah (backfill origin) gak gagal.
--
-- Vocabulary baru netral, 3-arah, dipakai KEDUA type:
--   'financial_only'  -- gak ada barang fisik yang kesentuh sama sekali
--   'order'           -- ada barang fisik DAN ketauan asalnya dari Order (SO buat INBOUND,
--                         PO buat OUTBOUND)
--   'goods_movement'  -- ada barang fisik tapi BUKAN dari Order (walk-in issue / terima
--                         barang langsung tanpa PO)
--
-- Bukan cuma rename kosmetik di sisi AP: recompute_ap_bill_status/ap_bills_with_status
-- sebelumnya cuma cek "ada goods_receipt_notes apa enggak" (2 cabang), gak pernah bedain
-- GRN yang dari PO vs GRN terima-langsung -- padahal datanya udah ada
-- (goods_receipt_notes.order_id nullable, sama persis pola order_line_id di sisi AR).
-- Migration ini nambah 1 cabang lagi di sisi OUTBOUND biar genuinely simetris 3-arah
-- sama AR, bukan sekadar tempel istilah baru di atas granularitas lama yang 2-arah.

create or replace function recompute_transaction_status(p_transaction_id uuid) returns void as $$
declare
  v_type text;
  v_journal_entry_id uuid;
  v_outstanding numeric;
  v_returned numeric;
  v_is_cancelled boolean;
  v_allocated numeric;
  v_deposit_applied numeric;
  v_status text;
  v_origin text;
begin
  select type, journal_entry_id into v_type, v_journal_entry_id from transactions where id = p_transaction_id;
  if not found then
    return;
  end if;

  select exists (
    select 1 from journal_entries je where je.reverses_entry_id = v_journal_entry_id
  ) into v_is_cancelled;

  if v_type = 'INBOUND' then
    v_outstanding := ar_invoice_remaining(p_transaction_id);

    select coalesce(sum(amount), 0) into v_returned
      from ar_credit_notes where invoice_id = p_transaction_id;

    select coalesce(sum(amount), 0) into v_allocated
      from ar_payments where invoice_id = p_transaction_id;

    select coalesce(sum(amount), 0) into v_deposit_applied
      from ar_deposit_applications where invoice_id = p_transaction_id;

    v_status := case
      when v_is_cancelled then 'dibatalkan'
      when v_outstanding <= 0.005 then 'lunas'
      when v_allocated > 0 or v_deposit_applied > 0 then 'sebagian'
      else 'belum'
    end;

    v_origin := case
      when not exists (select 1 from goods_issues gi where gi.invoice_id = p_transaction_id) then 'financial_only'
      when exists (
        select 1 from goods_issues gi
        join goods_issue_lines gil on gil.goods_issue_id = gi.id
        where gi.invoice_id = p_transaction_id and gil.order_line_id is not null
      ) then 'order'
      else 'goods_movement'
    end;

    update transactions
      set outstanding = v_outstanding, returned = v_returned, status = v_status, origin = v_origin
      where id = p_transaction_id;
  else
    v_outstanding := ap_bill_remaining(p_transaction_id);

    select coalesce(sum(amount), 0) into v_allocated
      from ap_payments where bill_id = p_transaction_id;

    -- Beda dari AR: deposit_applied di sini SENGAJA exclude yang reversed (persis
    -- ap_bills_with_status 0032/0038 dulu) -- asimetri ini bukan kelalaian, disalin
    -- apa adanya dari recompute_ap_bill_status.
    select coalesce(sum(ada.amount), 0) into v_deposit_applied
      from ap_deposit_applications ada
      where ada.bill_id = p_transaction_id
        and not exists (select 1 from journal_entries je where je.reverses_entry_id = ada.journal_entry_id);

    v_status := case
      when v_is_cancelled then 'dibatalkan'
      when v_outstanding <= 0.005 then 'lunas'
      when v_allocated > 0 or v_deposit_applied > 0 then 'sebagian'
      else 'belum'
    end;

    v_origin := case
      when not exists (select 1 from goods_receipt_notes grn where grn.bill_id = p_transaction_id) then 'financial_only'
      when exists (
        select 1 from goods_receipt_notes grn
        where grn.bill_id = p_transaction_id and grn.order_id is not null
      ) then 'order'
      else 'goods_movement'
    end;

    update transactions
      set outstanding = v_outstanding, status = v_status, origin = v_origin
      where id = p_transaction_id;
  end if;
end;
$$ language plpgsql security definer set search_path = public;

-- Backfill data existing -- reuse fungsi di atas apa adanya (bukan expresi terpisah),
-- pola sama 0053, biar gak ada 2 sumber kebenaran yang bisa drift.
do $$
declare
  v_id uuid;
begin
  for v_id in select id from transactions loop
    perform recompute_transaction_status(v_id);
  end loop;
end $$;
