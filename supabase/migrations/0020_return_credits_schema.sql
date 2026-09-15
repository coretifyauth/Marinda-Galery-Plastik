-- Return Credits (AR Return Credit + AP Return Credit, digabung). Ref:
-- memory/architecture/data/return-credits-schema.md.
-- type='INBOUND' = saldo kredit dari retur customer (AR), type='OUTBOUND' = piutang retur dari
-- supplier (AP). return_credits gak pernah punya RPC "create" sendiri -- baris lahir inline dari
-- dalam create_ar_return/create_ap_return (0019_returns_schema.sql) begitu ada "excess" (retur
-- bikin outstanding invoice/bill jadi minus). return_id references returns(id) (bukan
-- credit_note_id/credit_notes -- rename sudah final sejak sejarahnya, migrations_new gak pernah
-- pakai nama lama).

create table return_credits (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('INBOUND', 'OUTBOUND')),
  counterparty_id uuid not null references counterparties(id),
  return_id uuid not null references returns(id),
  amount numeric(14,2) not null check (amount > 0),
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index return_credits_return_id_idx on return_credits(return_id);
create index return_credits_counterparty_id_idx on return_credits(counterparty_id);

-- Gak ada kolom source_ref -- return_credits gak pernah punya dokumen sumbernya sendiri (dia
-- derivatif otomatis dari 1 returns row, source_ref-nya dokumen itu sendiri yang dipakai).

create table return_credit_refunds (
  id uuid primary key default gen_random_uuid(),
  credit_id uuid not null references return_credits(id),
  amount numeric(14,2) not null check (amount > 0),
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create trigger return_credits_block_edit_delete
  before update or delete on return_credits
  for each row execute function block_edit_delete();

create trigger return_credits_counterparty_role_guard_inbound
  before insert on return_credits
  for each row when (new.type = 'INBOUND')
  execute function counterparty_role_guard('counterparty_id', 'customer');

create trigger return_credits_counterparty_role_guard_outbound
  before insert on return_credits
  for each row when (new.type = 'OUTBOUND')
  execute function counterparty_role_guard('counterparty_id', 'supplier');

-- Guard konsistensi: return_credits.type wajib sama dengan returns.type (via return_id). Nama
-- fungsi TETAP return_credits_type_matches_credit_note (histori), isi baca returns/return_id.
-- Aman dari race/urutan: create_ar_return/create_ap_return selalu insert returns (udah
-- divalidasi credit_notes_type_matches_transaction) SEBELUM insert return_credits.
create function return_credits_type_matches_credit_note() returns trigger as $$
declare
  v_return_type text;
begin
  select type into v_return_type from returns where id = new.return_id;
  if v_return_type is distinct from new.type then
    raise exception 'return_credits.type (%) gak cocok sama returns.type (%) buat return_id %', new.type, v_return_type, new.return_id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger return_credits_type_matches_credit_note_trigger
  before insert on return_credits
  for each row execute function return_credits_type_matches_credit_note();

-- Sync status transaksi -- return_credits nambah reducer add-back di ar_invoice_remaining/
-- ap_bill_remaining (0023), jadi insert baris baru di sini mancing recompute transaksi asalnya.
-- Beda dari payments/returns/deposit_applications yang lookup langsung transaction_id kolom
-- sendiri, return_credits HARUS lookup dulu lewat returns (gak ada FK langsung ke transactions).
create function return_credits_sync_transaction_status() returns trigger as $$
declare
  v_transaction_id uuid;
begin
  select transaction_id into v_transaction_id from returns where id = new.return_id;
  if v_transaction_id is not null then
    perform recompute_transaction_status(v_transaction_id);
  end if;
  return new;
end;
$$ language plpgsql;

create trigger return_credits_sync_transaction_status_trigger
  after insert on return_credits
  for each row execute function return_credits_sync_transaction_status();

-- return_credit_refunds: immutability + guard. Sengaja gak ada trigger sync-status -- refund
-- cuma disposisi lanjutan dari saldo yang UDAH direklasifikasi keluar dari invoice/bill asalnya
-- (transaksi asalnya gak kesentuh lagi sama sekali).
create trigger return_credit_refunds_block_edit_delete
  before update or delete on return_credit_refunds
  for each row execute function block_edit_delete();

create function return_credit_refunds_guard() returns trigger as $$
declare
  v_remaining numeric;
  v_return_ref text;
begin
  select return_credit_remaining(new.credit_id) into v_remaining;

  if new.amount > v_remaining then
    select r.source_ref into v_return_ref
      from return_credits rc join returns r on r.id = rc.return_id
      where rc.id = new.credit_id;
    raise exception 'Refund saldo kredit retur (dari %) melebihi sisa saldo (sisa %, coba refund %)',
      v_return_ref, v_remaining, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger return_credit_refunds_guard_trigger
  before insert on return_credit_refunds
  for each row execute function return_credit_refunds_guard();

-- return_credit_remaining(credit_id) -- gantiin ar_return_credit_remaining+ap_return_credit_remaining.
-- Saldo kredit retur cuma bisa diselesaikan lewat refund tunai (return_credit_refunds) --
-- gak ada jalur "settle lewat ganti barang" (replacements berdiri independen, gak nyentuh
-- return_credits sama sekali).
create function return_credit_remaining(p_credit_id uuid) returns numeric as $$
  select c.amount
    - coalesce((select sum(amount) from return_credit_refunds where credit_id = p_credit_id), 0)
  from return_credits c
  where c.id = p_credit_id;
$$ language sql stable;

-- refund_return_credit -- gantiin refund_ar_return_credit+refund_ap_return_credit (near-exact
-- mirror, pola sama refund_deposit di 0017_deposits_schema.sql). Lookup type dari return_credits
-- internal, gak butuh param p_type dari caller.
create function refund_return_credit(
  p_credit_id uuid,
  p_amount numeric,
  p_entry_date date,
  p_source_ref text,
  p_return_credit_account_id uuid, -- INBOUND: Saldo Kredit Retur Customer (liability), OUTBOUND: Piutang Retur Supplier (asset)
  p_cash_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_type text;
  v_entry_id uuid;
  v_refund_id uuid;
begin
  select type into v_type from return_credits where id = p_credit_id;

  if v_type = 'INBOUND' then
    v_entry_id := create_journal_entry(
      p_entry_date, 'Refund saldo kredit retur customer', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_return_credit_account_id, 'debit', p_amount, 'credit', 0),
        jsonb_build_object('account_id', p_cash_account_id, 'debit', 0, 'credit', p_amount)
      )
    );
  else
    v_entry_id := create_journal_entry(
      p_entry_date, 'Refund saldo kredit retur supplier', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_cash_account_id, 'debit', p_amount, 'credit', 0),
        jsonb_build_object('account_id', p_return_credit_account_id, 'debit', 0, 'credit', p_amount)
      )
    );
  end if;

  insert into return_credit_refunds (credit_id, amount, source_ref, journal_entry_id, created_by)
  values (p_credit_id, p_amount, p_source_ref, v_entry_id, auth.uid())
  returning id into v_refund_id;

  return v_refund_id;
end;
$$;

alter table return_credits enable row level security;

create policy return_credits_select on return_credits for select using (auth.role() = 'authenticated');
create policy return_credits_insert on return_credits for insert with check (
  exists (select 1 from app_user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin')
);

alter table return_credit_refunds enable row level security;

create policy return_credit_refunds_select on return_credit_refunds for select using (auth.role() = 'authenticated');
create policy return_credit_refunds_insert on return_credit_refunds for insert with check (
  exists (select 1 from app_user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin')
);

grant select, insert on return_credits to authenticated;
grant select, insert on return_credit_refunds to authenticated;

grant execute on function refund_return_credit(uuid, numeric, date, text, uuid, uuid) to authenticated;
