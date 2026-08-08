-- Cabut mekanisme "saldo kredit retur AP dipakai motong bill lain" (apply_ap_return_credit +
-- ap_return_credit_applications), menyusul keputusan bisnis (2026-08-08): fitur ini bukan
-- fondasi AP -- ap_return_credits tetap tertelusuri & terselesaikan lewat refund tunai
-- (refund_ap_return_credit) yang gak berubah. Padanan AR (apply_ar_return_credit) sudah lebih
-- dulu dicabut migration 0041 (histori pra-squash) demi kebijakan penagihan ketat; AP gak
-- pernah ikut kebijakan ketat itu, jadi pencabutan di sini murni soal kesederhanaan, bukan
-- konsistensi kebijakan penagihan.
-- Ref: memory/architecture/data/ap-schema.md, memory/scope-debt (dibahas, gak dicatat jadi
-- scope-debt karena keputusannya final, bukan ditunda).

drop function if exists apply_ap_return_credit(uuid, uuid, numeric, date, text, uuid, uuid);

drop table if exists ap_return_credit_applications;

drop function if exists ap_return_credit_applications_guard();

-- ap_bill_remaining: balik ke 2 reducer (payment allocation + credit note), reducer ke-3
-- (return credit application) gak relevan lagi karena tabelnya udah gak ada.
create or replace function ap_bill_remaining(p_bill_id uuid) returns numeric as $$
  select ab.amount
    - coalesce((select sum(amount) from ap_payment_allocations where bill_id = p_bill_id), 0)
    - coalesce((select sum(amount) from ap_credit_notes where bill_id = p_bill_id), 0)
  from ap_bills ab
  where ab.id = p_bill_id;
$$ language sql stable;

-- ap_return_credit_remaining: cuma 1 disposisi tersisa (refund tunai).
create or replace function ap_return_credit_remaining(p_credit_id uuid) returns numeric as $$
  select c.amount
    - coalesce((select sum(amount) from ap_return_credit_refunds where credit_id = p_credit_id), 0)
  from ap_return_credits c
  where c.id = p_credit_id;
$$ language sql stable;

-- cancel_ap_bill: loop auto-reverse ap_return_credit_applications dihapus, tabelnya udah gak
-- ada. 2 guard lain (payment allocation, credit note) gak berubah.
create or replace function cancel_ap_bill(
  p_bill_id uuid,
  p_entry_date date,
  p_source_ref text
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_allocated_count int;
  v_credit_note_count int;
  v_original_entry_id uuid;
  v_new_entry_id uuid;
begin
  select count(*) into v_allocated_count
  from ap_payment_allocations where bill_id = p_bill_id;

  if v_allocated_count > 0 then
    raise exception 'Bill % udah punya % alokasi payment -- gak bisa dibatalkan lewat jalur ini', p_bill_id, v_allocated_count;
  end if;

  select count(*) into v_credit_note_count
  from ap_credit_notes where bill_id = p_bill_id;

  if v_credit_note_count > 0 then
    raise exception 'Bill % udah punya % retur (credit note) -- gak bisa dibatalkan lewat jalur ini', p_bill_id, v_credit_note_count;
  end if;

  select journal_entry_id into v_original_entry_id from ap_bills where id = p_bill_id;

  v_new_entry_id := reverse_journal_entry(v_original_entry_id, p_entry_date, p_source_ref);

  return v_new_entry_id;
end;
$$;
