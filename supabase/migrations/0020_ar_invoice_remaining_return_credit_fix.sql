-- Fix: ar_invoice_remaining() gak ngitung ar_return_credits (excess retur yang direklasifikasi
-- keluar dari Piutang Usaha ke Saldo Kredit Retur Customer, akun 2500) sebagai add-back reducer.
-- Akibatnya outstanding bisa keliatan minus walau Piutang Usaha sebenarnya sudah balik ke 0 lewat
-- jurnal reklasifikasi terpisah (create_ar_credit_note, submodule "AR Return Credit").
--
-- Padanan bug yang sudah diperbaiki di AP lewat migration `0010_ap_bill_remaining_return_credit_fix.sql`
-- (2026-08-12) -- dicatat waktu itu di memory/scope-debt/ar-invoice-remaining-return-credit-gap.md
-- sebagai belum diminta diperbaiki, sekarang digarap.
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
  from ar_invoices ai
  where ai.id = p_invoice_id;
$$ language sql stable;
