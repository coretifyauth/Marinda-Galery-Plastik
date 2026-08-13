-- Fix: ap_bill_remaining() gak ngitung ap_return_credits (excess retur yang direklasifikasi
-- keluar dari Utang Usaha ke Piutang Retur Supplier) sebagai add-back reducer. Akibatnya
-- outstanding bisa keliatan minus walau Utang Usaha sebenarnya sudah balik ke 0 lewat jurnal
-- reklasifikasi terpisah (create_ap_credit_note, submodule "Retur Barang ke Supplier").
--
-- Kejadian nyata (2026-08-12): bill "Pembelian Piring plastik 200 lusin" (Rp6.271.500) dibayar
-- lunas, lalu diretur penuh -> ap_bill_remaining() melaporkan -6.271.500, padahal jurnal
-- reklasifikasi excess (Debit Piutang Retur Supplier / Kredit Utang Usaha) sudah membalikkan
-- Utang Usaha ke 0. ar_invoice_remaining() (AR) punya gap identik, tapi belum diminta diperbaiki
-- di migration ini -- cuma AP yang dilaporkan.
--
-- Signature gak berubah (create or replace), jadi gak perlu drop function dulu.
create or replace function ap_bill_remaining(p_bill_id uuid) returns numeric as $$
  select ab.amount
    - coalesce((select sum(amount) from ap_payments where bill_id = p_bill_id), 0)
    - coalesce((select sum(amount) from ap_credit_notes where bill_id = p_bill_id), 0)
    - coalesce((
        select sum(ada.amount) from ap_deposit_applications ada
        where ada.bill_id = p_bill_id
          and not exists (
            select 1 from journal_entries je where je.reverses_entry_id = ada.journal_entry_id
          )
      ), 0)
    + coalesce((
        select sum(arc.amount) from ap_return_credits arc
        join ap_credit_notes acn on acn.id = arc.credit_note_id
        where acn.bill_id = p_bill_id
      ), 0)
  from ap_bills ab
  where ab.id = p_bill_id;
$$ language sql stable;
