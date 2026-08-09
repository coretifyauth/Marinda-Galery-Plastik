-- Stock Opname (Penyesuaian Stok Fisik) -- ref memory/scope-debt/stock-opname.md (ditutup
-- migration ini). Beda mendasar dari semua fitur Inventory lain: gak menempel ke 1 transaksi
-- tertentu (retur/write-off selalu nunjuk balik ke credit note/bill sumbernya) -- dokumen
-- sumbernya justru sesi hitung fisik itu sendiri. Header (stock_opnames) gak punya
-- journal_entry_id -- jurnalnya per-baris (stock_opname_lines.journal_entry_id), karena
-- tiap barang dalam 1 sesi bisa beda arah (kurang/lebih) DAN beda akun Persediaan
-- (Bahan Baku vs Barang Jadi).
--
-- Selisih 2 arah, diakui ke 2 akun TERPISAH (bukan di-netting jadi 1 akun) -- keputusan
-- bisnis eksplisit biar laporan tetap nunjukin rincian per barang:
--   Kurang: Debit Beban Selisih Persediaan / Kredit Persediaan
--   Lebih:  Debit Persediaan / Kredit Pendapatan Selisih Persediaan
-- avg_cost TIDAK pernah disentuh -- opname murni soal qty, bukan soal harga per unit.

create table stock_opnames (
  id uuid primary key default gen_random_uuid(),
  opname_date date not null,
  source_ref text not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create trigger stock_opnames_block_edit_delete
  before update or delete on stock_opnames
  for each row execute function block_edit_delete();

-- check (qty_actual <> qty_system) -- barang yang hasil hitungnya PAS gak pernah punya
-- baris di sini sama sekali, gak ada yang perlu disesuaikan/dijurnal.
create table stock_opname_lines (
  id uuid primary key default gen_random_uuid(),
  stock_opname_id uuid not null references stock_opnames(id) on delete cascade,
  item_id uuid not null references items(id),
  qty_system numeric(14,3) not null check (qty_system >= 0),
  qty_actual numeric(14,3) not null check (qty_actual >= 0),
  unit_cost numeric(14,2) not null check (unit_cost >= 0),
  journal_entry_id uuid not null references journal_entries(id),
  created_at timestamptz not null default now(),
  check (qty_actual <> qty_system)
);

create index stock_opname_lines_stock_opname_id_idx on stock_opname_lines(stock_opname_id);

create trigger stock_opname_lines_block_edit_delete
  before update or delete on stock_opname_lines
  for each row execute function block_edit_delete();

-- p_lines: array of {"item_id":uuid,"qty_actual":numeric,"inventory_account_id":uuid}.
-- inventory_account_id diterima PER BARIS (bukan 1 parameter buat seluruh pemanggilan,
-- beda dari create_purchase_writeoff) -- 1 sesi opname bisa mencakup barang lintas kategori
-- (Bahan Baku dan Barang Jadi) sekaligus dalam 1 hari hitung.
create function record_stock_opname(
  p_opname_date date,
  p_source_ref text,
  p_lines jsonb,
  p_shortage_expense_account_id uuid,
  p_surplus_revenue_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_opname_id uuid;
  v_line jsonb;
  v_item_id uuid;
  v_qty_actual numeric;
  v_inventory_account_id uuid;
  v_qty_system numeric;
  v_avg_cost numeric;
  v_variance numeric;
  v_value numeric;
  v_entry_id uuid;
  v_any_line boolean := false;
begin
  insert into stock_opnames (opname_date, source_ref, created_by)
  values (p_opname_date, p_source_ref, auth.uid())
  returning id into v_opname_id;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_item_id := (v_line->>'item_id')::uuid;
    v_qty_actual := (v_line->>'qty_actual')::numeric;
    v_inventory_account_id := (v_line->>'inventory_account_id')::uuid;

    -- for update -- kunci baris ini sepanjang transaksi. record_stock_opname melakukan SET
    -- absolut (bukan delta kayak consume_weighted_average/create_goods_receipt), jadi jendela
    -- read-then-write di sini lebih beresiko: sesi opname bisa berlangsung lama sebelum
    -- disubmit, dan transaksi lain (goods receipt/issue/produksi) yang nyelip di antaranya
    -- bakal ketiban timpa diam-diam tanpa error kalau baris ini gak dikunci.
    select qty_on_hand, avg_cost into v_qty_system, v_avg_cost
      from inventory_balances where item_id = v_item_id
      for update;

    if not found then
      raise exception 'Item % gak punya inventory_balances', v_item_id;
    end if;

    v_variance := v_qty_actual - v_qty_system;

    if v_variance = 0 then
      continue;
    end if;

    v_value := abs(v_variance) * v_avg_cost;
    v_any_line := true;

    if v_variance < 0 then
      v_entry_id := create_journal_entry(
        p_opname_date, 'Selisih stok opname (kurang)', p_source_ref,
        jsonb_build_array(
          jsonb_build_object('account_id', p_shortage_expense_account_id, 'debit', v_value, 'credit', 0),
          jsonb_build_object('account_id', v_inventory_account_id, 'debit', 0, 'credit', v_value)
        )
      );
    else
      v_entry_id := create_journal_entry(
        p_opname_date, 'Selisih stok opname (lebih)', p_source_ref,
        jsonb_build_array(
          jsonb_build_object('account_id', v_inventory_account_id, 'debit', v_value, 'credit', 0),
          jsonb_build_object('account_id', p_surplus_revenue_account_id, 'debit', 0, 'credit', v_value)
        )
      );
    end if;

    insert into stock_opname_lines (stock_opname_id, item_id, qty_system, qty_actual, unit_cost, journal_entry_id)
    values (v_opname_id, v_item_id, v_qty_system, v_qty_actual, v_avg_cost, v_entry_id);

    update inventory_balances
      set qty_on_hand = v_qty_actual, updated_at = now()
      where item_id = v_item_id;
  end loop;

  if not v_any_line then
    raise exception 'Gak ada selisih ditemukan di opname ini -- semua item cocok, gak perlu dicatat';
  end if;

  return v_opname_id;
end;
$$;

-- RLS -- pola identik tabel transaksional lain (goods_issues, dst): select semua
-- authenticated, insert cuma admin/accountant, gak ada update/delete (immutable,
-- RLS default-deny + block_edit_delete jaring kedua).
alter table stock_opnames enable row level security;

create policy stock_opnames_select on stock_opnames
  for select using (auth.role() = 'authenticated');

create policy stock_opnames_insert on stock_opnames
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table stock_opname_lines enable row level security;

create policy stock_opname_lines_select on stock_opname_lines
  for select using (auth.role() = 'authenticated');

create policy stock_opname_lines_insert on stock_opname_lines
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

grant select, insert on stock_opnames to authenticated;
grant select, insert on stock_opname_lines to authenticated;
