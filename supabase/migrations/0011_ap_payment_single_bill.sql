-- Selaraskan AP payment ke pola AR pasca-0010: boleh CICIL, tapi 1 payment WAJIB nunjuk 1 bill
-- spesifik -- gak bebas nyebar ke bill mana pun sesukanya ("bayar gabungan" dicabut). Sebelum
-- ini AP pakai tabel jembatan many-to-many (ap_payment_allocations, 1 payment bisa dipecah ke
-- banyak bill sekaligus) -- itu yang dianggap "seenaknya", beda dari cicil (bayar sebagian ke
-- 1 bill yang sama, lintas waktu) yang tetap boleh. Keputusan bisnis (2026-08-08): AP dan AR
-- disamakan filosofinya -- payment selalu taat ke 1 obligasi spesifik, cuma boleh kurang
-- (cicil) gak boleh lebih (overpay), gak pernah "disebar" ke banyak obligasi dalam 1 transaksi.
-- Ref: memory/architecture/data/ap-schema.md bagian "AP Payment — Selaras AR (0011)".

drop function if exists record_ap_payment(uuid, date, numeric, text, uuid, uuid, jsonb);

drop table if exists ap_payment_allocations;

drop function if exists ap_payment_allocations_no_over_allocation();

-- ap_payments.bill_id: FK langsung, gak unique (1 bill boleh punya banyak baris payment dari
-- waktu ke waktu -- cicil), mirror persis ar_payments.invoice_id pasca-0010. 0 baris di
-- ap_payments saat ini (diverifikasi via supabase db query --linked), jadi not null aman
-- ditambah langsung tanpa default/backfill.
alter table ap_payments add column bill_id uuid not null references ap_bills(id);
create index ap_payments_bill_id_idx on ap_payments(bill_id);

-- ap_bill_remaining: reducer #1 balik dari SUM(ap_payment_allocations) jadi SUM(ap_payments)
-- langsung -- tabelnya udah gak ada lagi lapisan jembatan.
create or replace function ap_bill_remaining(p_bill_id uuid) returns numeric as $$
  select ab.amount
    - coalesce((select sum(amount) from ap_payments where bill_id = p_bill_id), 0)
    - coalesce((select sum(amount) from ap_credit_notes where bill_id = p_bill_id), 0)
  from ap_bills ab
  where ab.id = p_bill_id;
$$ language sql stable;

-- record_ap_payment: signature baru, p_bill_id tunggal gantiin p_allocations jsonb array.
-- Guard sama persis pola record_ar_payment -- cuma tolak kalau MELEBIHI sisa (overpay), kurang
-- (cicil) lolos.
create function record_ap_payment(
  p_supplier_id uuid,
  p_payment_date date,
  p_amount numeric,
  p_source_ref text,
  p_payable_account_id uuid,
  p_cash_account_id uuid,
  p_bill_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_remaining numeric;
  v_entry_id uuid;
  v_payment_id uuid;
begin
  select ap_bill_remaining(p_bill_id) into v_remaining;

  if p_amount > v_remaining then
    raise exception 'Payment % melebihi sisa utang bill % (sisa %, coba bayar %) -- gak boleh overpay',
      p_source_ref, p_bill_id, v_remaining, p_amount;
  end if;

  v_entry_id := create_journal_entry(
    p_payment_date, 'Pelunasan utang', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_payable_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_cash_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into ap_payments (supplier_id, bill_id, payment_date, amount, source_ref, journal_entry_id, created_by)
  values (p_supplier_id, p_bill_id, p_payment_date, p_amount, p_source_ref, v_entry_id, auth.uid())
  returning id into v_payment_id;

  return v_payment_id;
end;
$$;

-- cancel_ap_bill: guard payment-count balik ke ap_payments langsung (bukan lewat tabel
-- jembatan yang udah gak ada).
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
  from ap_payments where bill_id = p_bill_id;

  if v_allocated_count > 0 then
    raise exception 'Bill % udah punya % payment -- gak bisa dibatalkan lewat jalur ini', p_bill_id, v_allocated_count;
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
