-- Fix: ar_invoice_remaining() gak ngitung reversal dari warranty_replacement sebagai add-back
-- reducer. create_warranty_replacement bikin jurnal "Debit Piutang Usaha / Kredit Retur &
-- Potongan Penjualan" (warranty_replacements.discount_reversed_amount) yang nambah balik piutang
-- proporsional ke qty yang ditukar barang (customer gak jadi dapat diskon retur, karena
-- barangnya diganti bukan direfund) -- tapi ar_invoice_remaining() cuma ngurangin
-- ar_credit_notes.amount doang (angka retur asli, immutable), gak pernah nambah balik reversal
-- yang kejadian belakangan lewat warranty_replacement.
--
-- Bug nyata: invoice belum ada payment sama sekali -> retur PENUH (credit note = full amount,
-- outstanding pas itu jadi 0) -> warranty replacement PENUH (discount_reversed_amount = full
-- amount, GL Piutang Usaha balik ke full amount lewat jurnal reversal) -- tapi
-- ar_invoice_remaining() tetap ngitung 0 (masih "lunas") karena reversal-nya gak pernah
-- ketambahin balik. Guard yang manggil fungsi ini (record_ar_payment no-overpay,
-- no-over-writeoff) ikut salah: customer yang sebenarnya berutang lagi malah ditolak bayar.
--
-- Padanan pola bug yang sama kayak `0020_ar_invoice_remaining_return_credit_fix.sql` (reducer
-- baru yang lupa ditambahin ke fungsi terpusat) -- lihat memory/domain/accounts-receivable.md
-- Common Mistakes "Nambah reducer baru ke ar_invoices tanpa nge-extend ar_invoice_remaining()".
--
-- PENTING: add-back-nya HARUS di-net-in sama warranty_replacements.return_credit_settled_amount,
-- BUKAN discount_reversed_amount mentah. Kalau credit note sumbernya punya ar_return_credits
-- aktif, create_warranty_replacement bikin jurnal KETIGA (Debit return_credit_liability / Kredit
-- Piutang Usaha) buat nyettle saldo kredit retur itu pakai barang -- nominalnya SELALU sama persis
-- dengan discount_reversed_amount pas kasus ini (lihat create_warranty_replacement: v_settlement_amount
-- := v_reversal_amount begitu ada ar_return_credits buat credit note itu). Net efeknya ke Piutang
-- Usaha invoice = 0 (reversal jurnal ke-2 dan settlement jurnal ke-3 saling menetralkan), jadi
-- add-back yang benar itu (discount_reversed_amount - return_credit_settled_amount), bukan
-- discount_reversed_amount doang -- kalau enggak, outstanding kehitung kelebihan persis sejumlah
-- return_credit_settled_amount tiap kali replacement-nya nyettle saldo kredit retur.
--
-- Signature gak berubah (create or replace), jadi gak perlu drop function dulu.
create or replace function ar_invoice_remaining(p_invoice_id uuid) returns numeric as $$
  select ai.amount
    - coalesce((
        select sum(amount) from ar_payments where invoice_id = p_invoice_id
      ), 0)
    - coalesce((
        select sum(amount) from ar_credit_notes where invoice_id = p_invoice_id
      ), 0)
    - coalesce((
        select sum(ada.amount) from ar_deposit_applications ada
        where ada.invoice_id = p_invoice_id
          and not exists (
            select 1 from journal_entries je where je.reverses_entry_id = ada.journal_entry_id
          )
      ), 0)
    - coalesce((
        select sum(abw.amount) from ar_bad_debt_writeoffs abw
        where abw.invoice_id = p_invoice_id
          and not exists (
            select 1 from journal_entries je where je.reverses_entry_id = abw.journal_entry_id
          )
      ), 0)
    + coalesce((
        select sum(arc.amount) from ar_return_credits arc
        join ar_credit_notes acn on acn.id = arc.credit_note_id
        where acn.invoice_id = p_invoice_id
      ), 0)
    + coalesce((
        select sum(wr.discount_reversed_amount - wr.return_credit_settled_amount)
        from warranty_replacements wr
        join ar_credit_notes cn on cn.id = wr.credit_note_id
        where cn.invoice_id = p_invoice_id
      ), 0)
  from ar_invoices ai
  where ai.id = p_invoice_id;
$$ language sql stable;
