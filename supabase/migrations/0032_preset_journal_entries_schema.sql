-- Preset Jurnal -- ganti Jurnal Umum manual bebas-pilih-akun (keputusan owner 2026-09-15).
-- Ref: docs/domain/general-ledger.md submodule "Preset Jurnal".
--
-- create_journal_entry (0003_journal_entry_schema.sql) TIDAK disentuh -- tetap dipakai
-- internal semua modul lain (AR/AP/Inventory) buat baris yang dihitung otomatis. Larangan
-- "gak boleh pilih akun bebas" cuma berlaku di halaman Jurnal Umum, ditegakkan lewat RPC baru
-- (create_journal_entry_from_preset) yang reuse create_journal_entry di dalamnya -- bukan
-- lockdown di level RPC dasar.

create table app_preset_journal_entries (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  status text not null default 'draft' check (status in ('draft', 'active', 'inactive')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  activated_at timestamptz
);

create trigger app_preset_journal_entries_set_updated_at
  before update on app_preset_journal_entries
  for each row execute function set_updated_at();

create table app_preset_journal_entry_lines (
  id uuid primary key default gen_random_uuid(),
  preset_id uuid not null references app_preset_journal_entries(id) on delete cascade,
  account_id uuid not null references accounts(id),
  side text not null check (side in ('debit', 'credit')),
  label text,
  sort_order int not null,
  unique (preset_id, sort_order)
);

create index app_preset_journal_entry_lines_preset_id_idx on app_preset_journal_entry_lines(preset_id);

-- Reuse journal_lines_leaf_only() -- body-nya generic (cuma cek new.account_id), gak nyebut
-- nama tabel journal_lines secara literal, aman dipasang trigger di tabel lain.
create trigger app_preset_journal_entry_lines_leaf_only_trigger
  before insert on app_preset_journal_entry_lines
  for each row execute function journal_lines_leaf_only();

-- app_preset_journal_entry_lines_draft_only -- baris preset cuma boleh diubah selama header
-- masih status draft. Begitu header active/inactive, baris terkunci permanen (published-lock
-- pattern, sama filosofi accounts_published_lock/fixed_assets_published_lock).
create function app_preset_journal_entry_lines_draft_only() returns trigger as $$
declare
  v_status text;
  v_preset_id uuid := coalesce(new.preset_id, old.preset_id);
begin
  select status into v_status from app_preset_journal_entries where id = v_preset_id;
  -- v_status null berarti header udah kehapus duluan (cascade dari DELETE header draft) --
  -- itu bukan pelanggaran, harus lolos, bukan ditolak. ON DELETE CASCADE Postgres jalanin
  -- delete anak SETELAH baris induk kehapus (command counter sama), jadi tanpa pengecualian
  -- ini, hapus preset draft yang punya baris bakal SELALU gagal (guard salah nolak delete
  -- cascade-nya sendiri).
  if v_status is not null and v_status <> 'draft' then
    raise exception 'Preset % status % -- baris preset cuma bisa diubah selagi draft', v_preset_id, v_status;
  end if;
  return coalesce(new, old);
end;
$$ language plpgsql;

create trigger app_preset_journal_entry_lines_draft_only_trigger
  before insert or update or delete on app_preset_journal_entry_lines
  for each row execute function app_preset_journal_entry_lines_draft_only();

-- app_preset_journal_entries_status_guard -- state machine draft->active->inactive->active,
-- gak pernah balik ke draft. Aktivasi wajib minimal 2 baris + minimal 1 debit & 1 kredit
-- (kurang dari itu mustahil pernah balance, lihat journal_lines_balance_check).
create function app_preset_journal_entries_status_guard() returns trigger as $$
declare
  v_line_count int;
  v_debit_count int;
  v_credit_count int;
begin
  if new.status = old.status then
    return new;
  end if;

  if old.status = 'draft' and new.status = 'active' then
    select count(*), count(*) filter (where side = 'debit'), count(*) filter (where side = 'credit')
      into v_line_count, v_debit_count, v_credit_count
      from app_preset_journal_entry_lines where preset_id = new.id;

    if v_line_count < 2 or v_debit_count < 1 or v_credit_count < 1 then
      raise exception 'Preset % butuh minimal 2 baris dengan minimal 1 debit dan 1 kredit sebelum diaktifkan (sekarang % baris, % debit, % kredit)',
        new.id, v_line_count, v_debit_count, v_credit_count;
    end if;
    new.activated_at := now();
    return new;
  end if;

  if old.status in ('active', 'inactive') and new.status in ('active', 'inactive') then
    return new;
  end if;

  raise exception 'Transisi status preset % -> % gak diizinkan', old.status, new.status;
end;
$$ language plpgsql;

create trigger app_preset_journal_entries_status_guard_trigger
  before update on app_preset_journal_entries
  for each row execute function app_preset_journal_entries_status_guard();

-- app_preset_journal_entries_delete_guard -- cuma draft yang boleh dihapus permanen (belum
-- pernah dipakai transaksi apa pun). active/inactive cuma bisa ditoggle statusnya.
create function app_preset_journal_entries_delete_guard() returns trigger as $$
begin
  if old.status <> 'draft' then
    raise exception 'Preset % status % -- cuma preset draft yang bisa dihapus permanen, active/inactive cuma bisa ditoggle', old.id, old.status;
  end if;
  return old;
end;
$$ language plpgsql;

create trigger app_preset_journal_entries_delete_guard_trigger
  before delete on app_preset_journal_entries
  for each row execute function app_preset_journal_entries_delete_guard();

-- create_journal_entry_from_preset -- satu-satunya jalur bikin Journal Entry dari halaman
-- Jurnal Umum sekarang. Akun+sisi diambil dari preset (terkunci), user cuma kirim jumlah per
-- baris. Reuse create_journal_entry (0003) buat insert beneran -- balance check/leaf-only/
-- atomicity semuanya kepakai otomatis dari sana, gak ditulis ulang di sini.
create function create_journal_entry_from_preset(
  p_preset_id uuid,
  p_entry_date date,
  p_description text,
  p_source_ref text,
  p_line_amounts jsonb -- array of {"line_id": uuid, "amount": numeric}
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_status text;
  v_preset_line_count int;
  v_input_count int;
  v_distinct_line_count int;
  v_lines jsonb := '[]'::jsonb;
  v_input jsonb;
  v_pl app_preset_journal_entry_lines%rowtype;
  v_amount numeric;
begin
  select status into v_status from app_preset_journal_entries where id = p_preset_id;
  if v_status is null then
    raise exception 'Preset % gak ditemukan', p_preset_id;
  end if;
  if v_status <> 'active' then
    raise exception 'Preset % status % -- cuma preset aktif yang bisa dipakai posting', p_preset_id, v_status;
  end if;

  select count(*) into v_preset_line_count from app_preset_journal_entry_lines where preset_id = p_preset_id;
  select jsonb_array_length(p_line_amounts) into v_input_count;
  if v_input_count is distinct from v_preset_line_count then
    raise exception 'Jumlah baris input (%) gak cocok jumlah baris preset (%)', v_input_count, v_preset_line_count;
  end if;

  -- Jumlah cocok doang gak cukup -- caller bisa kirim line_id yang sama 2x sambil ngelewatin
  -- baris preset lain (total tetep cocok jumlahnya). Wajib distinct count-nya JUGA persis
  -- sama jumlah baris preset -- gabungan count(*) + count(distinct) + validasi tiap line_id
  -- beneran milik preset ini (loop di bawah) membuktikan bijeksi (semua & cuma baris preset
  -- ini yang boleh muncul, masing-masing tepat sekali).
  select count(distinct elem ->> 'line_id') into v_distinct_line_count
    from jsonb_array_elements(p_line_amounts) elem;
  if v_distinct_line_count is distinct from v_preset_line_count then
    raise exception 'line_id di input harus mencakup semua baris preset masing-masing tepat sekali (dapat % baris unik, preset punya %)',
      v_distinct_line_count, v_preset_line_count;
  end if;

  for v_input in select * from jsonb_array_elements(p_line_amounts)
  loop
    select * into v_pl from app_preset_journal_entry_lines
      where id = (v_input ->> 'line_id')::uuid and preset_id = p_preset_id;

    if v_pl.id is null then
      raise exception 'Baris % bukan bagian dari preset %', v_input ->> 'line_id', p_preset_id;
    end if;

    v_amount := (v_input ->> 'amount')::numeric;
    if v_amount is null or v_amount <= 0 then
      raise exception 'Jumlah baris preset % harus diisi > 0', v_pl.id;
    end if;

    v_lines := v_lines || jsonb_build_object(
      'account_id', v_pl.account_id,
      'debit', case when v_pl.side = 'debit' then v_amount else 0 end,
      'credit', case when v_pl.side = 'credit' then v_amount else 0 end
    );
  end loop;

  return create_journal_entry(p_entry_date, p_description, p_source_ref, v_lines);
end;
$$;

grant execute on function create_journal_entry_from_preset(uuid, date, text, text, jsonb) to authenticated;

-- RLS -- kelola preset (insert/update/delete) cuma role master. select terbuka semua
-- authenticated (admin/accountant butuh baca daftar preset aktif buat dropdown Jurnal Umum).
-- Posting (create_journal_entry_from_preset) gak butuh policy tersendiri di tabel ini -- yang
-- dicek RLS-nya adalah insert ke journal_entries/journal_lines di dalam create_journal_entry
-- (security invoker, tetap role admin/accountant sesuai policy 0003).

alter table app_preset_journal_entries enable row level security;

create policy app_preset_journal_entries_select on app_preset_journal_entries
  for select using (auth.role() = 'authenticated');

create policy app_preset_journal_entries_insert on app_preset_journal_entries
  for insert with check (
    exists (select 1 from app_user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'master')
  );

create policy app_preset_journal_entries_update on app_preset_journal_entries
  for update using (
    exists (select 1 from app_user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'master')
  );

create policy app_preset_journal_entries_delete on app_preset_journal_entries
  for delete using (
    exists (select 1 from app_user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'master')
  );

grant select, insert, update, delete on app_preset_journal_entries to authenticated;

alter table app_preset_journal_entry_lines enable row level security;

create policy app_preset_journal_entry_lines_select on app_preset_journal_entry_lines
  for select using (auth.role() = 'authenticated');

create policy app_preset_journal_entry_lines_insert on app_preset_journal_entry_lines
  for insert with check (
    exists (select 1 from app_user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'master')
  );

create policy app_preset_journal_entry_lines_update on app_preset_journal_entry_lines
  for update using (
    exists (select 1 from app_user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'master')
  );

create policy app_preset_journal_entry_lines_delete on app_preset_journal_entry_lines
  for delete using (
    exists (select 1 from app_user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'master')
  );

grant select, insert, update, delete on app_preset_journal_entry_lines to authenticated;
