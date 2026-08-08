-- Balikin sebagian kemampuan yang dicabut migration 0040 (histori pra-squash): payment AR
-- sekarang boleh CICIL (kurang dari sisa outstanding), TAPI tetap gak boleh overpay (lebih
-- dari sisa) dan tetap wajib nunjuk ke 1 invoice spesifik -- gak ada saldo ngambang/gak ada
-- "titip ke invoice lain". Keputusan bisnis (2026-08-08): larangan cicil ternyata kelewat
-- ketat -- yang dulu dimaksud cuma larangan kelebihan bayar yang jadi saldo bebas dipakai
-- kapan aja (ar_customer_credits, sudah dicabut permanen & TETAP dicabut, gak dibalikin di
-- migration ini). Opsi minimal (bukan restore ar_payment_allocations many-to-many penuh) --
-- 1 payment tetap 1 invoice, cuma sekarang 1 invoice boleh punya banyak baris payment dari
-- waktu ke waktu ("bayar gabungan" lintas invoice TETAP gak didukung).
-- Ref: memory/architecture/data/ar-schema.md bagian "Cicil (dibalikin sebagian, 0010)".

-- Unique constraint ini sebelumnya juga jadi index implisit buat invoice_id (satu-satunya
-- index di kolom itu, ar_payments cuma punya ar_payments_customer_id_idx eksplisit). Drop
-- constraint + bikin index eksplisit sekaligus biar lookup invoice_id gak jadi seq scan --
-- ar_invoice_remaining() manggil ini di banyak jalur hot-path (record_ar_payment,
-- create_ar_invoice credit-hold, ar_deposit_applications_guard, dst).
alter table ar_payments drop constraint ar_payments_invoice_id_key;
create index ar_payments_invoice_id_idx on ar_payments(invoice_id);

-- Reducer #1 balik dari "ambil 1 baris langsung" jadi SUM (sekarang bisa banyak baris per
-- invoice). 3 reducer lain (ar_credit_notes, ar_deposit_applications, ar_bad_debt_writeoffs)
-- gak berubah.
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
  from ar_invoices ai
  where ai.id = p_invoice_id;
$$ language sql stable;

-- Guard: cuma tolak kalau MELEBIHI sisa (overpay) -- kurang dari sisa (cicil) sekarang lolos.
create or replace function record_ar_payment(
  p_customer_id uuid,
  p_payment_date date,
  p_amount numeric,
  p_source_ref text,
  p_cash_account_id uuid,
  p_receivable_account_id uuid,
  p_invoice_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_remaining numeric;
  v_entry_id uuid;
  v_payment_id uuid;
begin
  select ar_invoice_remaining(p_invoice_id) into v_remaining;

  if p_amount > v_remaining then
    raise exception 'Payment % melebihi sisa piutang invoice % (sisa %, coba bayar %) -- gak boleh overpay',
      p_source_ref, p_invoice_id, v_remaining, p_amount;
  end if;

  v_entry_id := create_journal_entry(
    p_payment_date, 'Pelunasan piutang', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_cash_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_receivable_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into ar_payments (customer_id, invoice_id, payment_date, amount, source_ref, journal_entry_id, created_by)
  values (p_customer_id, p_invoice_id, p_payment_date, p_amount, p_source_ref, v_entry_id, auth.uid())
  returning id into v_payment_id;

  return v_payment_id;
end;
$$;
