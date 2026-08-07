-- Period Closing schema.
-- Konsolidasi dari migration historis 0016 — lihat git log untuk riwayat evolusi.
-- Ref: docs/domain/general-ledger.md bagian "Period Closing".

-- period_closings — ledger append-only rentang tanggal yang udah ditutup. Gak ada tabel
-- "periods" terpisah dengan status open/closed — "terbuka" cuma berarti "belum ada baris
-- di sini yang nyakup tanggal itu". journal_entry_id nullable karena periode tanpa aktivitas
-- revenue/expense gak butuh closing entry sama sekali (gak ada yang perlu di-nol-in).
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

-- Jaring kedua buat overlap, DI LEVEL DATABASE (bukan cuma dicek di plpgsql close_period
-- di bawah) — 2 pemanggilan close_period yang balapan sama-sama bisa lolos SELECT-cek-overlap
-- sebelum salah satunya commit (classic TOCTOU race). Constraint ini bikin overlap gak
-- mungkin ke-INSERT sama sekali, terlepas dari race apapun di level aplikasi.
create extension if not exists btree_gist;

alter table period_closings add constraint period_closings_no_overlap
  exclude using gist (daterange(start_date, end_date, '[]') with &&);

-- Trigger di journal_entries (modul journal_entry, 0003) — tolak entry baru yang bertanggal
-- masuk ke rentang yang udah ditutup. Taruh di sini (bukan file journal_entry) karena
-- butuh period_closings. Sengaja BEFORE INSERT doang (bukan UPDATE, karena journal_entries
-- emang udah gak bisa di-UPDATE sama sekali sejak block_edit_delete).
--
-- Urutan pemanggilan penting: closing entry-nya sendiri (dibuat RPC close_period di bawah)
-- diinsert SEBELUM baris period_closings terkait ditambahkan — jadi trigger ini belum
-- "melihat" rentang itu sebagai tertutup pas closing entry-nya sendiri lagi diproses.
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

-- close_period — hitung saldo Revenue/Expense periode itu LANGSUNG dari journal_lines (gak
-- percaya angka dari client), bikin closing entry lewat create_journal_entry yang udah ada
-- (reuse balance-check & atomicity-nya), baru catat rentangnya sebagai tertutup.
--
-- Risiko residual yang SENGAJA belum ditutup (skala UMKM project ini, frekuensi closing
-- rendah): entry biasa (bukan close_period) yang lagi di-INSERT bertanggal di rentang yang
-- lagi ditutup, pas persis di window antara SELECT saldo Revenue/Expense di bawah selesai
-- dan baris period_closings ini commit, teorinya bisa kelewat kehitung atau enggak
-- tergantung timing snapshot — advisory lock di atas cuma nyerialize ANTAR-close_period, gak
-- ngunci insert journal_entries biasa. Solusi penuh butuh SERIALIZABLE isolation atau lock
-- yang lebih agresif, belum ada preseden itu di project ini, jadi sengaja ditunda.
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
  -- Serialize semua pemanggilan close_period lintas transaksi — tanpa ini, 2 closing yang
  -- balapan bisa sama-sama lolos cek overlap/kontiguitas di bawah sebelum salah satunya
  -- commit. Lock dilepas otomatis pas transaksi ini selesai (commit atau rollback).
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

  -- Wajib berurutan & bersambung — cegah ada rentang yang kelewat (gap) atau ditutup gak
  -- sesuai urutan waktu.
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

  -- Saldo bersih (debit-kredit) tiap akun Revenue/Expense DALAM rentang ini doang (bukan
  -- kumulatif) — karena closing sebelumnya udah nge-nol-in saldo s/d tanggal itu, rentang
  -- ini otomatis representasi "sejak closing terakhir", persis kayak Income Statement.
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

  -- Selisihnya = Laba Bersih periode ini (positif = laba, negatif = rugi) — pindah ke Laba
  -- Ditahan biar entry balance, sekaligus itu ADALAH closing entry-nya.
  v_net := v_total_debit - v_total_credit;
  if v_net > 0 then
    v_lines := v_lines || jsonb_build_object('account_id', p_retained_earnings_account_id, 'debit', 0, 'credit', v_net);
  elsif v_net < 0 then
    v_lines := v_lines || jsonb_build_object('account_id', p_retained_earnings_account_id, 'debit', -v_net, 'credit', 0);
  end if;

  -- Rentang tanpa aktivitas Revenue/Expense sama sekali -> gak ada yang perlu di-nol-in,
  -- cukup dicatat tertutup tanpa closing entry.
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

-- RLS — pola identik journal_entries: select terbuka authenticated, insert cuma
-- admin/accountant, gak ada update/delete (immutable, sama filosofi "periode yang udah
-- ditutup gak boleh diutak-atik").
alter table period_closings enable row level security;

create policy period_closings_select on period_closings
  for select using (auth.role() = 'authenticated');

create policy period_closings_insert on period_closings
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );
-- sengaja gak ada policy UPDATE/DELETE -> RLS default deny

create trigger period_closings_block_edit_delete
  before update or delete on period_closings
  for each row execute function block_edit_delete();

grant select, insert on period_closings to authenticated;
