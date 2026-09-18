-- Transactions (AR Invoice + AP Bill, digabung). Ref: memory/architecture/data/transactions-schema.md.
-- type='OUTBOUND' = piutang (AR, barang keluar), type='INBOUND' = utang (AP, barang masuk).

create table transactions (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('INBOUND', 'OUTBOUND')),
  counterparty_id uuid not null references counterparties(id),
  date date not null,
  due_date date not null,
  description text,
  source_ref text not null,
  amount numeric(14,2) not null check (amount > 0),
  outstanding numeric(14,2) not null,
  returned numeric(14,2) not null default 0,
  status text not null default 'belum',
  origin text not null default 'financial_only',
  supplier_document_ref text,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index transactions_counterparty_id_idx on transactions(counterparty_id);
create index transactions_journal_entry_id_idx on transactions(journal_entry_id);
create index transactions_type_idx on transactions(type);

create trigger transactions_counterparty_role_guard_inbound
  before insert on transactions
  for each row when (new.type = 'INBOUND')
  execute function counterparty_role_guard('counterparty_id', 'supplier');

create trigger transactions_counterparty_role_guard_outbound
  before insert on transactions
  for each row when (new.type = 'OUTBOUND')
  execute function counterparty_role_guard('counterparty_id', 'customer');

create table transaction_lines (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references transactions(id),
  account_id uuid not null references accounts(id),
  amount numeric(14,2) not null check (amount > 0),
  is_tax boolean not null default false
);

create index transaction_lines_transaction_id_idx on transaction_lines(transaction_id);

create trigger transactions_block_edit_delete
  before update or delete on transactions
  for each row execute function block_edit_delete();

create trigger transaction_lines_block_edit_delete
  before update or delete on transaction_lines
  for each row execute function block_edit_delete();

-- create_transaction -- reuse create_journal_entry, cabang p_type nentuin arah debit/kredit.
create function create_transaction(
  p_type text,
  p_counterparty_id uuid,
  p_date date,
  p_description text,
  p_source_ref text,
  p_lines jsonb, -- array of {"account_id":uuid,"amount":numeric} -- BUKAN termasuk PPN
  p_control_account_id uuid,
  p_apply_tax boolean default false,
  p_supplier_document_ref text default null
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_transaction_id uuid;
  v_line jsonb;
  v_total_amount numeric := 0;
  v_journal_lines jsonb := '[]'::jsonb;
  v_entry_id uuid;
  v_counterparty counterparties%rowtype;
  v_due_date date;
  v_ppn_rate numeric;
  v_ppn_account_id uuid;
  v_ppn_amount numeric := 0;
begin
  if p_type not in ('INBOUND', 'OUTBOUND') then
    raise exception 'p_type harus INBOUND atau OUTBOUND, dapat %', p_type;
  end if;

  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'Transaksi butuh minimal 1 baris kategori';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    if (v_line->>'amount')::numeric <= 0 then
      raise exception 'Nominal baris harus > 0';
    end if;
    v_total_amount := v_total_amount + (v_line->>'amount')::numeric;
  end loop;

  select * into v_counterparty from counterparties where id = p_counterparty_id;
  v_due_date := p_date + (v_counterparty.payment_term_days || ' days')::interval;

  if p_apply_tax then
    select ppn_rate,
           case when p_type = 'OUTBOUND' then ppn_keluaran_account_id else ppn_masukan_account_id end
      into v_ppn_rate, v_ppn_account_id
      from app_settings where id = true and is_active = true;

    if v_ppn_rate is null or v_ppn_account_id is null then
      raise exception 'PPN belum aktif/diset -- cek Pengaturan Pajak';
    end if;

    v_ppn_amount := round(v_total_amount * v_ppn_rate / 100, 2);
  end if;

  -- baris FIXED (control account, Piutang/Utang) + baris VARIABEL (kategori) + PPN opsional
  v_journal_lines := jsonb_build_array(
    jsonb_build_object(
      'account_id', p_control_account_id,
      'debit', case when p_type = 'OUTBOUND' then v_total_amount + v_ppn_amount else 0 end,
      'credit', case when p_type = 'INBOUND' then v_total_amount + v_ppn_amount else 0 end
    )
  );

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_journal_lines := v_journal_lines || jsonb_build_array(
      jsonb_build_object(
        'account_id', v_line->>'account_id',
        'debit', case when p_type = 'INBOUND' then (v_line->>'amount')::numeric else 0 end,
        'credit', case when p_type = 'OUTBOUND' then (v_line->>'amount')::numeric else 0 end
      )
    );
  end loop;

  if p_apply_tax then
    v_journal_lines := v_journal_lines || jsonb_build_array(
      jsonb_build_object(
        'account_id', v_ppn_account_id,
        'debit', case when p_type = 'INBOUND' then v_ppn_amount else 0 end,
        'credit', case when p_type = 'OUTBOUND' then v_ppn_amount else 0 end
      )
    );
  end if;

  v_entry_id := create_journal_entry(p_date, p_description, p_source_ref, v_journal_lines);

  insert into transactions (
    type, counterparty_id, date, due_date, description, source_ref, amount, outstanding,
    origin, supplier_document_ref, journal_entry_id, created_by
  )
  values (
    p_type, p_counterparty_id, p_date, v_due_date, p_description, p_source_ref,
    v_total_amount + v_ppn_amount, v_total_amount + v_ppn_amount,
    'financial_only', p_supplier_document_ref, v_entry_id, auth.uid()
  )
  returning id into v_transaction_id;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    insert into transaction_lines (transaction_id, account_id, amount, is_tax)
    values (v_transaction_id, (v_line->>'account_id')::uuid, (v_line->>'amount')::numeric, false);
  end loop;

  if p_apply_tax then
    insert into transaction_lines (transaction_id, account_id, amount, is_tax)
    values (v_transaction_id, v_ppn_account_id, v_ppn_amount, true);
  end if;

  return v_transaction_id;
end;
$$;

-- charge_categories -- katalog kategori tambahan (dropdown UI), module pos/ar/ap. Gak ada
-- FK dari sini ke transaction_lines -- murni resolve pilihan di UI sebelum manggil RPC.
create table charge_categories (
  id uuid primary key default gen_random_uuid(),
  module text not null check (module in ('pos', 'ar', 'ap')),
  name text not null,
  account_id uuid not null references accounts(id),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger charge_categories_set_updated_at
  before update on charge_categories
  for each row execute function set_updated_at();

alter table charge_categories enable row level security;

create policy charge_categories_select on charge_categories for select using (auth.role() = 'authenticated');
create policy charge_categories_insert on charge_categories for insert with check (
  exists (select 1 from app_user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin')
);
create policy charge_categories_update on charge_categories for update using (
  exists (select 1 from app_user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin')
);

grant select, insert, update on charge_categories to authenticated;

-- ar_invoice_remaining/ap_bill_remaining -- reducer "sisa outstanding riil". Mereferensikan
-- payments/returns/deposit_applications/return_credits yang baru didefinisikan di file
-- belakangan (0016 payments/0017 deposits/0019 returns/0020 return_credits) -- aman, SQL
-- function stable resolve lazy saat dipanggil.
create function ar_invoice_remaining(p_invoice_id uuid) returns numeric as $$
declare
  v_result numeric;
begin
  select ai.amount
    - coalesce((select sum(amount) from payments where transaction_id = p_invoice_id and type = 'OUTBOUND'), 0)
    - coalesce((select sum(amount) from returns where transaction_id = p_invoice_id and type = 'INBOUND'), 0)
    - coalesce((
        select sum(da.amount) from deposit_applications da
        where da.transaction_id = p_invoice_id
          and not exists (select 1 from journal_entries je where je.reverses_entry_id = da.journal_entry_id)
      ), 0)
    + coalesce((
        select sum(rc.amount) from return_credits rc
        join returns r on r.id = rc.return_id
        where r.transaction_id = p_invoice_id
      ), 0)
  into v_result
  from transactions ai
  where ai.id = p_invoice_id;
  return v_result;
end;
$$ language plpgsql stable;

create function ap_bill_remaining(p_bill_id uuid) returns numeric as $$
declare
  v_result numeric;
begin
  select ab.amount
    - coalesce((select sum(amount) from payments where transaction_id = p_bill_id and type = 'INBOUND'), 0)
    - coalesce((select sum(amount) from returns where transaction_id = p_bill_id and type = 'OUTBOUND'), 0)
    - coalesce((
        select sum(da.amount) from deposit_applications da
        where da.transaction_id = p_bill_id
          and not exists (select 1 from journal_entries je where je.reverses_entry_id = da.journal_entry_id)
      ), 0)
    + coalesce((
        select sum(rc.amount) from return_credits rc
        join returns r on r.id = rc.return_id
        where r.transaction_id = p_bill_id
      ), 0)
  into v_result
  from transactions ab
  where ab.id = p_bill_id;
  return v_result;
end;
$$ language plpgsql stable;

-- cancel_ar_invoice/cancel_ap_bill -- reversing entry, guard payment/return-count.
create function cancel_ar_invoice(
  p_invoice_id uuid, p_entry_date date, p_source_ref text
) returns uuid language plpgsql security invoker as $$
declare
  v_paid_count int; v_original_entry_id uuid; v_new_entry_id uuid;
  v_application record; v_invoice_ref text;
begin
  select count(*) into v_paid_count
  from payments where transaction_id = p_invoice_id and type = 'OUTBOUND';

  if v_paid_count > 0 then
    select source_ref into v_invoice_ref from transactions where id = p_invoice_id;
    raise exception 'Invoice % udah punya payment -- gak bisa dibatalkan lewat jalur ini', v_invoice_ref;
  end if;

  select journal_entry_id into v_original_entry_id from transactions where id = p_invoice_id;
  v_new_entry_id := reverse_journal_entry(v_original_entry_id, p_entry_date, p_source_ref);

  for v_application in
    select da.journal_entry_id from deposit_applications da
    where da.transaction_id = p_invoice_id
      and not exists (select 1 from journal_entries je where je.reverses_entry_id = da.journal_entry_id)
  loop
    perform reverse_journal_entry(v_application.journal_entry_id, p_entry_date, p_source_ref);
  end loop;

  return v_new_entry_id;
end;
$$;

-- cancel_ap_bill juga nolak kalau bill berasal dari penerimaan barang (GRN) yang barangnya
-- udah masuk stok -- kalau lolos, jurnal pembalik menghapus utang + efek Dr Inventory/Cr AP
-- di buku, tapi stok fisik (inventory_movements/qty_on_hand) TETAP ada. Gap ini sebelumnya
-- cuma dicatat sebagai peringatan manual di docs/tutorial/accounts-payable/batalkan-bill-ap.md,
-- sekarang ditegakkan sistem. Jalur yang benar buat kasus ini: Retur AP
-- (docs/tutorial/accounts-payable/retur-barang-ap.md) yang membalik stok DAN jurnal/utang
-- sekaligus. Referensi ke goods_notes (0018, sama seperti referensi returns di bawah ke 0019)
-- forward-reference aman -- lihat catatan generate_item_unit_barcode di 0005. TIDAK unwind
-- deposit_applications kayak cancel_ar_invoice di atas -- gap terpisah, lihat
-- memory/scope-debt/cancel-ap-bill-deposit-unwind.md.
create function cancel_ap_bill(
  p_bill_id uuid, p_entry_date date, p_source_ref text
) returns uuid language plpgsql security invoker as $$
declare
  v_allocated_count int; v_return_count int; v_goods_receipt_count int;
  v_original_entry_id uuid; v_new_entry_id uuid; v_bill_ref text;
begin
  select count(*) into v_allocated_count
  from payments where transaction_id = p_bill_id and type = 'INBOUND';

  if v_allocated_count > 0 then
    select source_ref into v_bill_ref from transactions where id = p_bill_id;
    raise exception 'Bill % udah punya % payment -- gak bisa dibatalkan lewat jalur ini', v_bill_ref, v_allocated_count;
  end if;

  select count(*) into v_return_count
  from returns where transaction_id = p_bill_id and type = 'OUTBOUND';

  if v_return_count > 0 then
    select source_ref into v_bill_ref from transactions where id = p_bill_id;
    raise exception 'Bill % udah punya % retur -- gak bisa dibatalkan lewat jalur ini', v_bill_ref, v_return_count;
  end if;

  select count(*) into v_goods_receipt_count
  from goods_notes where transaction_id = p_bill_id and type = 'INBOUND';

  if v_goods_receipt_count > 0 then
    select source_ref into v_bill_ref from transactions where id = p_bill_id;
    raise exception
      'Bill % berasal dari penerimaan barang (GRN) -- barang udah masuk stok, gak bisa dibatalkan langsung. Pakai jalur Retur AP buat balikin stok dan jurnal/utangnya sekaligus.',
      v_bill_ref;
  end if;

  select journal_entry_id into v_original_entry_id from transactions where id = p_bill_id;
  v_new_entry_id := reverse_journal_entry(v_original_entry_id, p_entry_date, p_source_ref);

  return v_new_entry_id;
end;
$$;

-- recompute_transaction_status -- gantiin recompute_ar_invoice_status+recompute_ap_bill_status,
-- versi FINAL (origin classification pasca goods_notes, migration 0082_goods_notes_repoint.sql).
create function recompute_transaction_status(p_transaction_id uuid) returns void as $$
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

  if v_type = 'OUTBOUND' then
    v_outstanding := ar_invoice_remaining(p_transaction_id);

    select coalesce(sum(amount), 0) into v_returned
      from returns where transaction_id = p_transaction_id and type = 'INBOUND';

    select coalesce(sum(amount), 0) into v_allocated
      from payments where transaction_id = p_transaction_id and type = 'OUTBOUND';

    select coalesce(sum(amount), 0) into v_deposit_applied
      from deposit_applications where transaction_id = p_transaction_id;

    v_status := case
      when v_is_cancelled then 'dibatalkan'
      when v_outstanding <= 0.005 then 'lunas'
      when v_allocated > 0 or v_deposit_applied > 0 then 'sebagian'
      else 'belum'
    end;

    v_origin := case
      when not exists (select 1 from goods_notes gn where gn.transaction_id = p_transaction_id and gn.type = 'OUTBOUND') then 'financial_only'
      when exists (
        select 1 from goods_notes gn
        join goods_note_lines gnl on gnl.goods_note_id = gn.id
        where gn.transaction_id = p_transaction_id and gn.type = 'OUTBOUND' and gnl.order_line_id is not null
      ) then 'order'
      else 'goods_movement'
    end;

    update transactions
      set outstanding = v_outstanding, returned = v_returned, status = v_status, origin = v_origin
      where id = p_transaction_id;
  else
    v_outstanding := ap_bill_remaining(p_transaction_id);

    select coalesce(sum(amount), 0) into v_allocated
      from payments where transaction_id = p_transaction_id and type = 'INBOUND';

    select coalesce(sum(da.amount), 0) into v_deposit_applied
      from deposit_applications da
      where da.transaction_id = p_transaction_id
        and not exists (select 1 from journal_entries je where je.reverses_entry_id = da.journal_entry_id);

    v_status := case
      when v_is_cancelled then 'dibatalkan'
      when v_outstanding <= 0.005 then 'lunas'
      when v_allocated > 0 or v_deposit_applied > 0 then 'sebagian'
      else 'belum'
    end;

    v_origin := case
      when not exists (select 1 from goods_notes gn where gn.transaction_id = p_transaction_id and gn.type = 'INBOUND') then 'financial_only'
      when exists (
        select 1 from goods_notes gn
        where gn.transaction_id = p_transaction_id and gn.type = 'INBOUND' and gn.order_id is not null
      ) then 'order'
      else 'goods_movement'
    end;

    update transactions
      set outstanding = v_outstanding, status = v_status, origin = v_origin
      where id = p_transaction_id;
  end if;
end;
$$ language plpgsql security definer set search_path = public;

-- View status -- 2 view terfilter type di atas 1 tabel transactions.
create view ar_invoices_with_status
  with (security_invoker = true) as
select
  id, counterparty_id as customer_id, date as invoice_date, due_date, description, source_ref, amount,
  journal_entry_id, created_at, outstanding::numeric as outstanding, returned::numeric as returned,
  status, origin
from transactions
where type = 'OUTBOUND';

create view ap_bills_with_status
  with (security_invoker = true) as
select
  id, counterparty_id as supplier_id, date as bill_date, due_date, description, source_ref, supplier_document_ref,
  amount, journal_entry_id, created_at, outstanding::numeric as outstanding, status, origin
from transactions
where type = 'INBOUND';

grant select on ar_invoices_with_status to authenticated;
grant select on ap_bills_with_status to authenticated;

alter table transactions enable row level security;

create policy transactions_select on transactions
  for select using (auth.role() = 'authenticated');

create policy transactions_insert on transactions
  for insert with check (
    exists (select 1 from app_user_roles ur
            where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );

alter table transaction_lines enable row level security;

create policy transaction_lines_select on transaction_lines
  for select using (auth.role() = 'authenticated');

create policy transaction_lines_insert on transaction_lines
  for insert with check (
    exists (select 1 from app_user_roles ur
            where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );

grant select, insert on transactions to authenticated;
grant select, insert on transaction_lines to authenticated;
