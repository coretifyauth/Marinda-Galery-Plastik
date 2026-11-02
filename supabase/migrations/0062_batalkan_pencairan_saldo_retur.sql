-- 0062 Batalkan Pencairan Saldo Retur Supplier.
-- 0061 menolak membatalkan retur yang saldo Piutang Retur Supplier-nya sudah dicairkan tunai. Migration ini menambah jalur
-- membatalkan pencairan itu (pola sama payment_cancellations: jurnal dibalik, alasan, dan jawaban "uangnya benar berpindah"),
-- lalu membuat saldo retur hanya menghitung pencairan AKTIF. Urutan batal lengkap: pencairan -> retur -> pembayaran ->
-- barang masuk -> tagihan. Hanya pencairan saldo retur ke supplier (type OUTBOUND); sisi customer (AR) tidak berubah.

create table return_credit_refund_cancellations (
  refund_id uuid primary key references return_credit_refunds(id),
  journal_entry_id uuid not null references journal_entries(id),   -- pembalik jurnal pencairan
  reason text not null check (length(trim(reason)) > 0),
  money_moved boolean not null, -- uangnya benar-benar masuk dari supplier: catatan kas wajib disesuaikan dengan rekening koran
  cancelled_by uuid references auth.users(id),
  cancelled_at timestamptz not null default now()
);

create trigger return_credit_refund_cancellations_block_edit_delete
  before update or delete on return_credit_refund_cancellations
  for each row execute function block_edit_delete();

alter table return_credit_refund_cancellations enable row level security;

create policy return_credit_refund_cancellations_select on return_credit_refund_cancellations
  for select using (auth.role() = 'authenticated');

create policy return_credit_refund_cancellations_insert on return_credit_refund_cancellations
  for insert with check (
    exists (select 1 from app_user_roles ur
            where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );

grant select, insert on return_credit_refund_cancellations to authenticated;

create function return_credit_refund_is_active(p_refund_id uuid) returns boolean
language sql stable
as $$
  select not exists (select 1 from return_credit_refund_cancellations c where c.refund_id = p_refund_id)
$$;

-- return_credit_remaining -- sama persis 0061 kecuali pencairan yang dibatalkan tidak dihitung.
create or replace function return_credit_remaining(p_credit_id uuid) returns numeric as $$
  select case when return_is_active(c.return_id)
              then c.amount - coalesce((
                select sum(f.amount) from return_credit_refunds f
                where f.credit_id = p_credit_id and return_credit_refund_is_active(f.id)), 0)
              else 0 end
  from return_credits c
  where c.id = p_credit_id;
$$ language sql stable;

-- cancel_ap_return -- sama persis 0061 kecuali pencairan tunai yang sudah dibatalkan tidak lagi menghalangi.
create or replace function cancel_ap_return(
  p_return_id uuid,
  p_entry_date date,
  p_reason text
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_return returns%rowtype;
  v_bill transactions%rowtype;
  v_credit return_credits%rowtype;
  v_newer_ref text;
  v_line record;
  v_reversal_id uuid;
  v_credit_reversal_id uuid;
begin
  select * into v_return from returns where id = p_return_id and type = 'OUTBOUND';
  if not found then
    raise exception 'Retur % gak ditemukan', p_return_id;
  end if;

  -- urutan lock sama dengan cancel_ap_bill: cancel_transaction -> kolam
  perform pg_advisory_xact_lock(hashtext('cancel_transaction:' || v_return.transaction_id::text));
  perform pg_advisory_xact_lock(hashtext('ap_bill_pool:' || v_return.transaction_id::text));

  if not return_is_active(p_return_id) then
    raise exception 'Retur % sudah dibatalkan', v_return.source_ref;
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'Alasan pembatalan retur wajib diisi';
  end if;

  select * into v_bill from transactions where id = v_return.transaction_id;
  if v_bill.status = 'dibatalkan' then
    raise exception 'Tagihan % sudah dibatalkan', v_bill.source_ref;
  end if;

  if p_entry_date < v_return.credit_note_date then
    raise exception 'Tanggal pembatalan % lebih awal dari tanggal retur % -- histori stok jadi janggal', p_entry_date, v_return.credit_note_date;
  end if;
  perform assert_period_open(p_entry_date);

  select r.source_ref into v_newer_ref
    from returns r
    where r.transaction_id = v_return.transaction_id and r.type = 'OUTBOUND' and r.id <> p_return_id
      and return_is_active(r.id)
      and (r.created_at, r.id) > (v_return.created_at, v_return.id)
    order by r.created_at, r.id
    limit 1;
  if v_newer_ref is not null then
    raise exception 'Retur % gak bisa dibatalkan: masih ada retur yang lebih baru (%) di tagihan yang sama -- batalkan yang terbaru dulu',
      v_return.source_ref, v_newer_ref;
  end if;

  select * into v_credit from return_credits where return_id = p_return_id;
  if found then
    perform pg_advisory_xact_lock(hashtext('return_credit:' || v_credit.id::text)); -- kunci yang sama dengan refund_return_credit
  end if;
  if v_credit.id is not null and exists (
    select 1 from return_credit_refunds f where f.credit_id = v_credit.id and return_credit_refund_is_active(f.id)
  ) then
    raise exception 'Retur % gak bisa dibatalkan: saldo Piutang Retur Supplier-nya sudah dicairkan tunai (uangnya sudah kembali ke kas) -- batalkan pencairannya dulu', v_return.source_ref;
  end if;

  for v_line in
    select id, item_id, qty_returned, total_cost from return_lines where return_id = p_return_id order by id
  loop
    perform inventory_restore_stock(v_line.item_id, v_line.qty_returned, v_line.total_cost / v_line.qty_returned);

    insert into inventory_movements (item_id, movement_date, qty, return_line_id)
    values (v_line.item_id, p_entry_date, v_line.qty_returned, v_line.id);
  end loop;

  v_reversal_id := reverse_journal_entry(v_return.journal_entry_id, p_entry_date, v_return.source_ref || '/BTL');

  if v_credit.id is not null then
    v_credit_reversal_id := reverse_journal_entry(v_credit.journal_entry_id, p_entry_date, v_return.source_ref || '/BTL');
  end if;

  insert into return_cancellations (return_id, journal_entry_id, credit_journal_entry_id, reason, cancelled_by)
  values (p_return_id, v_reversal_id, v_credit_reversal_id, trim(p_reason), auth.uid());

  perform recompute_transaction_status(v_return.transaction_id);

  return v_reversal_id;
end;
$$;

-- cancel_return_credit_refund -- membalik jurnal pencairan (Debit Kas/Bank, Kredit Piutang Retur Supplier): kas berkurang,
-- saldo Piutang Retur Supplier kembali. Artinya "catatannya salah", bukan "uangnya kembali ke supplier": kalau uangnya
-- benar-benar sudah masuk (p_money_moved), saldo kas/bank di buku sengaja berbeda dari rekening koran sampai pencairan yang
-- benar dicatat ulang, atau sampai pembayaran yang dikembalikan itu juga dibatalkan (keduanya saling menutup).
create function cancel_return_credit_refund(
  p_refund_id uuid,
  p_entry_date date,
  p_reason text,
  p_money_moved boolean
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_refund return_credit_refunds%rowtype;
  v_credit return_credits%rowtype;
  v_return returns%rowtype;
  v_refund_date date;
  v_reversal_id uuid;
begin
  select * into v_refund from return_credit_refunds where id = p_refund_id;
  if not found then
    raise exception 'Pencairan % gak ditemukan', p_refund_id;
  end if;

  select * into v_credit from return_credits where id = v_refund.credit_id;
  if v_credit.type <> 'OUTBOUND' then
    raise exception 'Hanya pencairan saldo retur ke supplier yang bisa dibatalkan';
  end if;
  select * into v_return from returns where id = v_credit.return_id;

  -- kunci yang sama dengan refund_return_credit/cancel_ap_return, lalu kunci tagihan (urutan sama cancel_ap_return)
  perform pg_advisory_xact_lock(hashtext('cancel_transaction:' || v_return.transaction_id::text));
  perform pg_advisory_xact_lock(hashtext('ap_bill_pool:' || v_return.transaction_id::text));
  perform pg_advisory_xact_lock(hashtext('return_credit:' || v_credit.id::text));

  if not return_credit_refund_is_active(p_refund_id) then
    raise exception 'Pencairan % sudah dibatalkan', v_refund.source_ref;
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'Alasan pembatalan pencairan wajib diisi';
  end if;
  if p_money_moved is null then
    raise exception 'Wajib dijawab: apakah uangnya benar-benar berpindah';
  end if;

  select entry_date into v_refund_date from journal_entries where id = v_refund.journal_entry_id;
  if p_entry_date < v_refund_date then
    raise exception 'Tanggal pembatalan % lebih awal dari tanggal pencairan %', p_entry_date, v_refund_date;
  end if;
  perform assert_period_open(p_entry_date);

  v_reversal_id := reverse_journal_entry(v_refund.journal_entry_id, p_entry_date, v_refund.source_ref || '/BTL');

  insert into return_credit_refund_cancellations (refund_id, journal_entry_id, reason, money_moved, cancelled_by)
  values (p_refund_id, v_reversal_id, trim(p_reason), p_money_moved, auth.uid());

  return v_reversal_id;
end;
$$;

grant execute on function cancel_return_credit_refund(uuid, date, text, boolean) to authenticated;
