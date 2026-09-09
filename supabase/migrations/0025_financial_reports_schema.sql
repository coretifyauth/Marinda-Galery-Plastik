-- Financial Reports -- Period Closing (Tutup Buku). Ref:
-- memory/architecture/data/financial-reports-schema.md.
-- 4 laporan baca (Trial Balance/Income Statement/Balance Sheet/Cash Flow) GAK ADA tabel/RPC
-- baru -- murni fetch+reduce di TypeScript dari accounts+journal_entries+journal_lines yang
-- udah ada sejak 0002/0003. Satu-satunya bagian yang beneran nambah objek DB di modul ini
-- adalah Period Closing di bawah.

create table period_closings (
  id uuid primary key default gen_random_uuid(),
  start_date date not null,
  end_date date not null check (end_date >= start_date),
  journal_entry_id uuid references journal_entries(id),
  source_ref text not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index period_closings_range_idx on period_closings(start_date, end_date);

alter table period_closings add constraint period_closings_no_overlap
  exclude using gist (daterange(start_date, end_date, '[]') with &&);

create function journal_entries_block_retroactive_into_closed_period() returns trigger as $$
begin
  if exists (
    select 1 from period_closings
    where new.entry_date between start_date and end_date
  ) then
    raise exception 'Tanggal % sudah masuk periode yang ditutup — catat transaksi ini dengan tanggal periode yang sedang berjalan, bukan tanggal lama', new.entry_date;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger journal_entries_block_retroactive_into_closed_period_trigger
  before insert on journal_entries
  for each row execute function journal_entries_block_retroactive_into_closed_period();

-- close_period -- hitung saldo Revenue/Expense LANGSUNG dari journal_lines (gak percaya
-- angka client), bikin closing entry via create_journal_entry, catat rentang tertutup.
create function close_period(
  p_start_date date,
  p_end_date date,
  p_retained_earnings_account_id uuid,
  p_source_ref text
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_last_end date;
  v_re_category account_category;
  v_lines jsonb := '[]'::jsonb;
  v_total_debit numeric := 0;
  v_total_credit numeric := 0;
  v_net numeric;
  v_entry_id uuid;
  v_closing_id uuid;
  rec record;
begin
  perform pg_advisory_xact_lock(hashtext('period_closings'));

  if p_end_date < p_start_date then
    raise exception 'end_date (%) gak boleh sebelum start_date (%)', p_end_date, p_start_date;
  end if;

  if exists (
    select 1 from period_closings
    where p_start_date <= end_date and start_date <= p_end_date
  ) then
    raise exception 'Rentang % s/d % tumpang tindih sama periode yang udah ditutup', p_start_date, p_end_date;
  end if;

  select max(end_date) into v_last_end from period_closings;
  if v_last_end is not null and p_start_date <> v_last_end + 1 then
    raise exception 'start_date (%) harus persis sehari setelah periode terakhir ditutup (%)', p_start_date, v_last_end;
  end if;

  select category into v_re_category from accounts where id = p_retained_earnings_account_id;
  if v_re_category is null then
    raise exception 'p_retained_earnings_account_id gak ditemukan';
  end if;
  if v_re_category is distinct from 'equity' then
    raise exception 'p_retained_earnings_account_id harus akun kategori equity (biasanya Laba Ditahan)';
  end if;

  for rec in
    select jl.account_id, sum(jl.debit) - sum(jl.credit) as net
    from journal_lines jl
    join journal_entries je on je.id = jl.journal_entry_id
    join accounts a on a.id = jl.account_id
    where a.category in ('revenue', 'expense')
      and je.entry_date between p_start_date and p_end_date
    group by jl.account_id
    having sum(jl.debit) - sum(jl.credit) <> 0
  loop
    if rec.net > 0 then
      v_lines := v_lines || jsonb_build_object('account_id', rec.account_id, 'debit', 0, 'credit', rec.net);
      v_total_credit := v_total_credit + rec.net;
    else
      v_lines := v_lines || jsonb_build_object('account_id', rec.account_id, 'debit', -rec.net, 'credit', 0);
      v_total_debit := v_total_debit + (-rec.net);
    end if;
  end loop;

  v_net := v_total_debit - v_total_credit;
  if v_net > 0 then
    v_lines := v_lines || jsonb_build_object('account_id', p_retained_earnings_account_id, 'debit', 0, 'credit', v_net);
  elsif v_net < 0 then
    v_lines := v_lines || jsonb_build_object('account_id', p_retained_earnings_account_id, 'debit', -v_net, 'credit', 0);
  end if;

  if jsonb_array_length(v_lines) > 0 then
    v_entry_id := create_journal_entry(
      p_end_date,
      'Tutup buku periode ' || p_start_date || ' s/d ' || p_end_date,
      p_source_ref,
      v_lines
    );
  end if;

  insert into period_closings (start_date, end_date, journal_entry_id, source_ref, created_by)
  values (p_start_date, p_end_date, v_entry_id, p_source_ref, auth.uid())
  returning id into v_closing_id;

  return v_closing_id;
end;
$$;

alter table period_closings enable row level security;

create policy period_closings_select on period_closings
  for select using (auth.role() = 'authenticated');

create policy period_closings_insert on period_closings
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

create trigger period_closings_block_edit_delete
  before update or delete on period_closings
  for each row execute function block_edit_delete();

grant select, insert on period_closings to authenticated;
