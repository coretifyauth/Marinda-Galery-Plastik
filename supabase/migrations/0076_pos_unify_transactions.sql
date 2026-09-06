-- Unifikasi POS Sale ke dalam transactions(OUTBOUND) + orkestrasi payments otomatis.
-- Desain lengkap & histori keputusan: memory/scope-debt/pos-unify-transactions.md
--
-- Data historis pos_sales TIDAK di-backfill (lihat "Temuan kritis" di scope-debt) --
-- struktur jurnal lama (1 jurnal Kas<->Pendapatan) gak bisa "dipecah" jadi pola baru
-- (2 jurnal Piutang<->Pendapatan + Kas<->Piutang) tanpa mengubah journal_entries yang
-- immutable. Tabel lama di-rename jadi *_legacy, dibekukan permanen sebagai arsip.
--
-- CATATAN HISTORIS (2026-09-06): keputusan "bekukan jadi *_legacy" di migration ini
-- KEMUDIAN DIBATALKAN oleh user (data lama diputuskan dihapus permanen, bukan
-- dibekukan) -- tapi versi INI (rename ke *_legacy) yang SUDAH KEBURU ter-apply ke
-- project live sebelum keputusan itu final (lihat memory/scope-debt/pos-unify-transactions.md
-- bagian "Ronde review pasca-apply" buat kronologi lengkap). Migration `0077` menyusul
-- buat menyelesaikan transisi ke keputusan final (hapus permanen `*_legacy` + fix-fix
-- lanjutan yang ketauan review ronde 3-5). File ini SENGAJA gak diedit lagi -- convention
-- project ini: migration yang udah diapply gak boleh diubah, tambahan lewat migration baru.

-- ============================================================
-- 1. Bekukan data lama -- rename, trigger/RLS/grant ikut (Postgres preserve by OID)
-- ============================================================

alter table pos_sales rename to pos_sales_legacy;
alter table pos_sale_lines rename to pos_sale_lines_legacy;
alter table pos_sale_extra_credit_lines rename to pos_sale_extra_credit_lines_legacy;

comment on table pos_sales_legacy is
  'Dibekukan migration 0076 -- riwayat POS pra-cutover, jurnal 1-tahap (Kas<->Pendapatan), gak bisa dipetakan ke transactions/payments tanpa mengubah journal_entries immutable. Baca-saja, bukan dipakai transaksi baru.';

-- ============================================================
-- 2. pos_settings -- singleton, pola persis tax_settings/default_account_settings.
--    Nyimpen ID counterparty "Pelanggan Umum" (walk-in), bukan hardcode/lookup by name
--    (counterparties.name gak ada unique constraint).
-- ============================================================

create table pos_settings (
  id boolean primary key default true,
  walk_in_customer_id uuid not null references counterparties(id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  constraint pos_settings_singleton check (id)
);

create trigger pos_settings_set_updated_at
  before update on pos_settings
  for each row execute function set_updated_at();

alter table pos_settings enable row level security;

create policy pos_settings_select on pos_settings
  for select using (auth.role() = 'authenticated');

create policy pos_settings_update on pos_settings
  for update using (
    exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );

-- Sengaja gak ada policy insert (role_key/isi singleton ditentukan migration, pola tax_settings).
grant select, update on pos_settings to authenticated;

-- Seed 1 baris "Pelanggan Umum" -- insert langsung (bukan lewat create_counterparty),
-- migration jalan di luar konteks auth.uid()/RLS session normal.
do $$
declare
  v_customer_id uuid;
begin
  insert into counterparties (name, payment_term_days)
  values ('Pelanggan Umum', 1)
  returning id into v_customer_id;

  insert into counterparty_type_mapping (counterparty_id, role)
  values (v_customer_id, 'customer');

  insert into pos_settings (walk_in_customer_id) values (v_customer_id);
end $$;

-- ============================================================
-- 3. pos_sales (nama dipakai ulang) -- BUKAN header transaksi lagi, cuma PENANDA tipis
--    "transaksi ini lahir dari kasir POS" + pointer ke 3 baris yang harus di-reverse
--    bareng kalau dibatalkan. Data finansial ASLI (jumlah yang diposting ke GL) ada di
--    transactions/transaction_lines/goods_issues/goods_issue_lines/payments -- gak
--    diduplikasi di sini. pos_sale_lines/pos_sale_extra_credit_lines (dibikin setelahnya,
--    di bawah) ITU duplikasi -- tapi murni buat tampilan struk, bukan angka yang
--    diposting emanapun (lihat komentar DDL-nya).
-- ============================================================

create table pos_sales (
  transaction_id uuid primary key references transactions(id),
  goods_issue_id uuid not null references goods_issues(id),
  payment_id uuid not null references payments(id),
  -- payments TIDAK nyimpen cash_account_id sendiri (cuma kebaca dari journal_lines) --
  -- disalin ke sini murni buat display list/detail, biar gak butuh correlated subquery
  -- ke journal_lines tiap row di view pos_sales_with_status (0053 lesson: hindari itu
  -- di list page tanpa filter tanggal).
  cash_account_id uuid not null references accounts(id),
  created_at timestamptz not null default now()
);

create trigger pos_sales_block_edit_delete
  before update or delete on pos_sales
  for each row execute function block_edit_delete();

alter table pos_sales enable row level security;

create policy pos_sales_select on pos_sales
  for select using (auth.role() = 'authenticated');

-- Sengaja gak ada policy/grant insert -- pola persis versi lama, satu-satunya jalur
-- nulis adalah create_pos_sale (security definer).
grant select on pos_sales to authenticated;

-- pos_sale_lines/pos_sale_extra_credit_lines (nama dipakai ulang, sama pola pos_sales) --
-- BUKAN sumber kebenaran akuntansi (itu tetap transaction_lines/goods_issue_lines),
-- murni salinan buat kebutuhan TAMPILAN STRUK (cetak ulang/kirim WA di apps/pos --
-- fetchRecentSales query pos_sale_lines.unit_price/line_amount, dan goods_issue_lines
-- CUMA nyimpen qty_issued+total_cost buat HPP, gak pernah nyimpen harga jual per baris).
-- Diisi create_pos_sale bareng insert pos_sales, gak pernah dibaca RPC finansial manapun.
create table pos_sale_lines (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references pos_sales(transaction_id) on delete cascade,
  item_id uuid not null references items(id),
  qty_sold numeric(14,3) not null check (qty_sold > 0),
  unit_price numeric(14,2) not null check (unit_price >= 0),
  line_amount numeric(14,2) not null check (line_amount >= 0)
);

create index pos_sale_lines_transaction_id_idx on pos_sale_lines(transaction_id);

create trigger pos_sale_lines_block_edit_delete
  before update or delete on pos_sale_lines
  for each row execute function block_edit_delete();

alter table pos_sale_lines enable row level security;

create policy pos_sale_lines_select on pos_sale_lines
  for select using (auth.role() = 'authenticated');

grant select on pos_sale_lines to authenticated;

create table pos_sale_extra_credit_lines (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references pos_sales(transaction_id) on delete cascade,
  account_id uuid not null references accounts(id),
  amount numeric(14,2) not null check (amount > 0),
  is_tax boolean not null default false
);

create index pos_sale_extra_credit_lines_transaction_id_idx on pos_sale_extra_credit_lines(transaction_id);

create trigger pos_sale_extra_credit_lines_block_edit_delete
  before update or delete on pos_sale_extra_credit_lines
  for each row execute function block_edit_delete();

alter table pos_sale_extra_credit_lines enable row level security;

create policy pos_sale_extra_credit_lines_select on pos_sale_extra_credit_lines
  for select using (auth.role() = 'authenticated');

grant select on pos_sale_extra_credit_lines to authenticated;

-- ============================================================
-- 4. FIX KRITIS -- journal_entries_sync_reversal_status (0071) nulis manual ke
--    "pos_sales.status"/"pos_sales.revenue_journal_entry_id" lewat NAMA TABEL "pos_sales".
--    Begitu bagian 1 di atas rename pos_sales -> pos_sales_legacy DAN bagian 3 pakai
--    ulang nama "pos_sales" buat tabel penanda baru (kolom beda total), literal SQL
--    "update pos_sales set status=..." di fungsi lama bakal nunjuk ke tabel BARU yang
--    gak punya kolom status/revenue_journal_entry_id -> ERROR "column does not exist"
--    di SETIAP reversal di seluruh sistem (bukan cuma POS -- cancel_ar_invoice, refund
--    deposit, dst juga manggil reverse_journal_entry -> trigger ini jalan). Fix: literal
--    itu direpoint eksplisit ke "pos_sales_legacy" (bukan dihapus -- void_pos_sale, bagian
--    7, masih hidup buat riwayat pra-cutover dan masih butuh baris ini keupdate). Cabang
--    loop transactions (807-809 versi 0071) yang nutup POS BARU (statusnya nempel di
--    transactions, bukan di tabel penanda) -- ketauan review schema-reviewer: draft awal
--    migration ini kehapus baris pos_sales_legacy-nya sekalian, bukan direpoint.
-- ============================================================

create or replace function journal_entries_sync_reversal_status() returns trigger as $$
declare
  v_id uuid;
begin
  if new.reverses_entry_id is null then
    return new;
  end if;

  for v_id in select id from transactions where journal_entry_id = new.reverses_entry_id loop
    perform recompute_transaction_status(v_id);
  end loop;

  -- pos_sales_legacy (bekas pos_sales) MASIH butuh cabang ini -- void_pos_sale (bagian 7)
  -- tetap manggil reverse_journal_entry buat riwayat pra-cutover, dan tabel legacy itu
  -- MASIH punya kolom status/revenue_journal_entry_id asli (rename doang, bukan restruktur).
  -- pos_sales BENTUK BARU (bagian 3) gak butuh cabang sendiri -- statusnya nempel di
  -- transactions, udah ke-cover loop di atas.
  update pos_sales_legacy set status = 'dibatalkan' where revenue_journal_entry_id = new.reverses_entry_id;

  for v_id in select transaction_id from deposit_applications where journal_entry_id = new.reverses_entry_id loop
    perform recompute_transaction_status(v_id);
  end loop;
  for v_id in select deposit_id from deposit_applications where journal_entry_id = new.reverses_entry_id loop
    perform recompute_deposit_status(v_id);
  end loop;

  return new;
end;
$$ language plpgsql security definer set search_path = public;

-- ============================================================
-- 4b. FIX -- ar_invoice_remaining/ap_bill_remaining nge-sum SEMUA payments tanpa
--     nge-exclude yang jurnalnya udah di-reverse (beda dari deposit_applications di
--     fungsi yang sama, yang UDAH nge-exclude reversed). Sebelum void_pos_transaction
--     ada, gap ini gak pernah kena -- cancel_ar_invoice/cancel_ap_bill nolak jalan
--     kalau transaksi udah punya payments sama sekali, jadi gak ada RPC manapun yang
--     reverse jurnal 1 payment doang sambil ngebiarin baris payments-nya tetap hidup.
--     void_pos_transaction PERTAMA yang begitu -- tanpa fix ini, transactions.outstanding
--     abis dibatalkan bakal kebaca 0 (keliatan "lunas") padahal harusnya balik ke
--     amount penuh (voided). status tetap benar (dihitung independen dari exists-check
--     reverses_entry_id), tapi kolom outstanding sendiri jadi menyesatkan buat laporan
--     yang baca kolom itu langsung. Signature/fungsi lain gak berubah, cuma nambah
--     1 exists-check per fungsi, pola identik yang udah dipakai deposit_applications.
-- ============================================================

create or replace function ar_invoice_remaining(p_invoice_id uuid) returns numeric as $$
  select ai.amount
    - coalesce((
        select sum(p.amount) from payments p
        where p.transaction_id = p_invoice_id and p.type = 'OUTBOUND'
          and not exists (select 1 from journal_entries je where je.reverses_entry_id = p.journal_entry_id)
      ), 0)
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
  from transactions ai
  where ai.id = p_invoice_id;
$$ language sql stable;

create or replace function ap_bill_remaining(p_bill_id uuid) returns numeric as $$
  select ab.amount
    - coalesce((
        select sum(p.amount) from payments p
        where p.transaction_id = p_bill_id and p.type = 'INBOUND'
          and not exists (select 1 from journal_entries je where je.reverses_entry_id = p.journal_entry_id)
      ), 0)
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
  from transactions ab
  where ab.id = p_bill_id;
$$ language sql stable;

-- ============================================================
-- 5. create_pos_sale -- DIGANTI TOTAL jadi orkestrator, signature EKSTERNAL BYTE-IDENTIK
--    (apps/pos/src/app/page.tsx nol perubahan buat alur create). Isinya sekarang:
--      create_goods_issue(...)  -> transactions(OUTBOUND)+transaction_lines+goods_issues+
--                                   goods_issue_lines+jurnal Piutang<->Pendapatan+jurnal HPP
--      record_payment(...)      -> payments+jurnal Kas<->Piutang, lunas seketika
--    Akun Piutang Usaha diambil dari default_account_settings (role_key 'ar.receivable',
--    SAMA persis yang dipakai AR Invoice) -- BUKAN parameter baru, biar signature gak
--    berubah. Customer walk-in diambil dari pos_settings kalau kasir gak pilih.
--    PPN gak dihitung manual lagi di sini -- diteruskan p_apply_tax ke create_goods_issue
--    (yang neruskan ke create_transaction), dihitung SEKALI di sana dari tax_settings,
--    gak dobel-hitung.
-- ============================================================

create or replace function create_pos_sale(
  p_sale_date date,
  p_source_ref text,
  p_customer_id uuid,
  p_cash_account_id uuid,
  p_revenue_account_id uuid,
  p_hpp_account_id uuid,
  p_finished_good_account_id uuid,
  p_lines jsonb, -- array of {"item_id":uuid,"qty_sold":numeric,"unit_price":numeric}
  p_extra_credit_lines jsonb default '[]'::jsonb, -- array of {"account_id":uuid,"amount":numeric}
  p_apply_tax boolean default false
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_customer_id uuid;
  v_receivable_account_id uuid;
  v_line jsonb;
  v_qty numeric;
  v_unit_price numeric;
  v_total_amount numeric := 0;
  v_credit_lines jsonb;
  v_issue_lines jsonb := '[]'::jsonb;
  v_transaction_id uuid;
  v_goods_issue_id uuid;
  v_payment_id uuid;
  v_settle_amount numeric;
begin
  if not exists (
    select 1 from user_roles ur
    where ur.user_id = auth.uid() and ur.role_name in ('admin', 'accountant', 'cashier')
  ) then
    raise exception 'Gak punya akses buat bikin POS Sale';
  end if;

  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'POS sale wajib punya minimal 1 baris item';
  end if;

  v_customer_id := p_customer_id;
  if v_customer_id is null then
    select walk_in_customer_id into v_customer_id from pos_settings where id = true;
    if v_customer_id is null then
      raise exception 'pos_settings.walk_in_customer_id belum diset -- hubungi admin';
    end if;
  end if;

  select account_id into v_receivable_account_id
    from default_account_settings where role_key = 'ar.receivable';
  if v_receivable_account_id is null then
    raise exception 'default_account_settings ar.receivable belum diset -- hubungi admin';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_qty := (v_line ->> 'qty_sold')::numeric;
    v_unit_price := (v_line ->> 'unit_price')::numeric;

    if v_qty <= 0 then
      raise exception 'qty_sold harus > 0';
    end if;
    if v_unit_price < 0 then
      raise exception 'unit_price gak boleh negatif';
    end if;

    v_total_amount := v_total_amount + v_qty * v_unit_price;

    v_issue_lines := v_issue_lines || jsonb_build_array(
      jsonb_build_object(
        'item_id', v_line ->> 'item_id',
        'qty_issued', v_qty,
        'order_line_id', null
      )
    );
  end loop;

  v_credit_lines := jsonb_build_array(
    jsonb_build_object('account_id', p_revenue_account_id, 'amount', v_total_amount)
  );

  if p_extra_credit_lines is not null and jsonb_array_length(p_extra_credit_lines) > 0 then
    for v_line in select * from jsonb_array_elements(p_extra_credit_lines)
    loop
      if (v_line ->> 'amount')::numeric <= 0 then
        raise exception 'Nominal baris biaya tambahan harus > 0';
      end if;
      v_credit_lines := v_credit_lines || jsonb_build_array(
        jsonb_build_object('account_id', v_line ->> 'account_id', 'amount', (v_line ->> 'amount')::numeric)
      );
    end loop;
  end if;

  v_transaction_id := create_goods_issue(
    v_customer_id, p_sale_date, 'Penjualan POS', p_source_ref,
    v_credit_lines, v_receivable_account_id,
    v_issue_lines, p_hpp_account_id, p_finished_good_account_id,
    p_apply_tax
  );

  select id into v_goods_issue_id from goods_issues where invoice_id = v_transaction_id;

  -- Lunasi SELURUH outstanding seketika (bukan v_total_amount -- pakai amount asli hasil
  -- create_transaction, karena itu udah termasuk PPN kalau p_apply_tax, dihitung 1 tempat
  -- doang biar gak ada 2 sumber kebenaran buat angka pajak).
  select amount into v_settle_amount from transactions where id = v_transaction_id;

  v_payment_id := record_payment(
    'OUTBOUND', v_customer_id, p_sale_date, v_settle_amount, p_source_ref,
    p_cash_account_id, v_receivable_account_id, v_transaction_id
  );

  insert into pos_sales (transaction_id, goods_issue_id, payment_id, cash_account_id)
  values (v_transaction_id, v_goods_issue_id, v_payment_id, p_cash_account_id);

  -- Salinan buat struk (bukan sumber kebenaran -- lihat komentar di DDL pos_sale_lines).
  -- Loop ulang p_lines (bukan reuse v_issue_lines) karena v_issue_lines udah dibentuk
  -- dalam format goods_issue_lines (item_id/qty_issued/order_line_id), gak nyimpen
  -- unit_price/line_amount yang justru dibutuhkan di sini.
  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    insert into pos_sale_lines (transaction_id, item_id, qty_sold, unit_price, line_amount)
    values (
      v_transaction_id,
      (v_line ->> 'item_id')::uuid,
      (v_line ->> 'qty_sold')::numeric,
      (v_line ->> 'unit_price')::numeric,
      (v_line ->> 'qty_sold')::numeric * (v_line ->> 'unit_price')::numeric
    );
  end loop;

  if p_extra_credit_lines is not null and jsonb_array_length(p_extra_credit_lines) > 0 then
    for v_line in select * from jsonb_array_elements(p_extra_credit_lines)
    loop
      insert into pos_sale_extra_credit_lines (transaction_id, account_id, amount, is_tax)
      values (v_transaction_id, (v_line ->> 'account_id')::uuid, (v_line ->> 'amount')::numeric, false);
    end loop;
  end if;

  -- Baris PPN gak dihitung ulang di sini (dihitung SEKALI di create_transaction, gak
  -- boleh ada 2 sumber kebenaran buat angka pajak) -- dibaca balik dari transaction_lines
  -- yang baru aja ditulis create_goods_issue/create_transaction.
  insert into pos_sale_extra_credit_lines (transaction_id, account_id, amount, is_tax)
  select v_transaction_id, tl.account_id, tl.amount, true
  from transaction_lines tl
  where tl.transaction_id = v_transaction_id and tl.is_tax = true;

  return v_transaction_id;
end;
$$;

-- ============================================================
-- 6. void_pos_transaction -- RPC BARU (bukan reuse cancel_ar_invoice, yang raise
--    exception kalau transaksi udah punya payment -- POS SELALU punya payment).
--    Mirror void_pos_sale lama, cuma sekarang reverse 3 jurnal (payment, goods_issue,
--    transaction) lewat pos_sales sebagai peta pointer-nya.
-- ============================================================

create function void_pos_transaction(
  p_transaction_id uuid,
  p_entry_date date,
  p_source_ref text
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_pos record;
  v_transaction_journal_entry_id uuid;
  v_goods_issue_journal_entry_id uuid;
  v_payment_journal_entry_id uuid;
  v_already_voided boolean;
  v_new_entry_id uuid;
begin
  select * into v_pos from pos_sales where transaction_id = p_transaction_id;
  if not found then
    raise exception 'Transaksi % bukan POS sale (gak ada penanda pos_sales) -- pakai cancel_ar_invoice', p_transaction_id;
  end if;

  select journal_entry_id into v_transaction_journal_entry_id from transactions where id = p_transaction_id;
  select journal_entry_id into v_goods_issue_journal_entry_id from goods_issues where id = v_pos.goods_issue_id;
  select journal_entry_id into v_payment_journal_entry_id from payments where id = v_pos.payment_id;

  select exists (
    select 1 from journal_entries je where je.reverses_entry_id = v_transaction_journal_entry_id
  ) into v_already_voided;

  if v_already_voided then
    raise exception 'POS sale % udah pernah dibatalkan', p_transaction_id;
  end if;

  -- Urutan: payment dulu (Kas<->Piutang), goods_issue (HPP<->Persediaan), baru
  -- transaction (Piutang<->Pendapatan) -- reverse_journal_entry gak peduli urutan
  -- (masing-masing independen), tapi urutan ini paling gampang dibaca di riwayat jurnal.
  perform reverse_journal_entry(v_payment_journal_entry_id, p_entry_date, p_source_ref);
  perform reverse_journal_entry(v_goods_issue_journal_entry_id, p_entry_date, p_source_ref);
  v_new_entry_id := reverse_journal_entry(v_transaction_journal_entry_id, p_entry_date, p_source_ref);

  update inventory_balances ib
    set qty_on_hand = ib.qty_on_hand + agg.qty_issued,
        updated_at = now()
    from (
      select item_id, sum(qty_issued) as qty_issued
      from goods_issue_lines
      where goods_issue_id = v_pos.goods_issue_id
      group by item_id
    ) agg
    where ib.item_id = agg.item_id;

  return v_new_entry_id;
end;
$$;

-- ============================================================
-- 7. void_pos_sale (LAMA) -- TETAP ADA, disesuaikan nunjuk *_legacy -- riwayat POS
--    pra-cutover masih harus bisa dibatalkan lewat jalur asalnya.
-- ============================================================

create or replace function void_pos_sale(
  p_sale_id uuid,
  p_entry_date date,
  p_source_ref text
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_sale record;
  v_already_voided boolean;
  v_new_revenue_entry_id uuid;
begin
  select * into v_sale from pos_sales_legacy where id = p_sale_id;

  if not found then
    raise exception 'POS sale % gak ditemukan', p_sale_id;
  end if;

  select exists (
    select 1 from journal_entries je where je.reverses_entry_id = v_sale.revenue_journal_entry_id
  ) into v_already_voided;

  if v_already_voided then
    raise exception 'POS sale % udah pernah dibatalkan', p_sale_id;
  end if;

  v_new_revenue_entry_id := reverse_journal_entry(v_sale.revenue_journal_entry_id, p_entry_date, p_source_ref);
  perform reverse_journal_entry(v_sale.cogs_journal_entry_id, p_entry_date, p_source_ref);

  update inventory_balances ib
    set qty_on_hand = ib.qty_on_hand + agg.qty_sold,
        updated_at = now()
    from (
      select item_id, sum(qty_sold) as qty_sold
      from pos_sale_lines_legacy
      where pos_sale_id = p_sale_id
      group by item_id
    ) agg
    where ib.item_id = agg.item_id;

  return v_new_revenue_entry_id;
end;
$$;

-- ============================================================
-- 8. pos_sales_with_status -- UNION legacy + baru, gantiin definisi lama (yang setelah
--    rename bagian 1 diam-diam cuma nunjuk pos_sales_legacy lewat OID, tanpa data baru).
--
--    Kolom FLAT (customer_name/cash_account_code/cash_account_name), BUKAN relasi
--    PostgREST embed (`counterparties(name)` dst) -- view ini UNION dari 2 tabel fisik
--    beda (pos_sales_legacy vs pos_sales+transactions), dan PostgREST gak reliable
--    ngedeteksi FK buat auto-embed lewat view hasil UNION (beda dari ar_invoices_with_status
--    dkk yang aman karena single-source). LEFT JOIN ditulis eksplisit di sini, tetap 0
--    correlated-subquery-per-row (pola 0053).
--
--    apps/erp/src/lib/pos-sales/{schema,queries}.ts + page.tsx DISESUAIKAN bareng migration
--    ini (drop nested counterparties(...)/cash_account:accounts(...), pakai kolom flat).
--
--    WAJIB "drop + create", BUKAN "create or replace" -- ketauan review schema-reviewer
--    ronde 2: definisi lama (masih hidup, nunjuk ke pos_sales_legacy via OID pasca-rename)
--    punya urutan/nama kolom beda (customer_id di posisi ke-2, ada created_at) dari
--    definisi baru (kolom flat, urutan beda, created_at gak ada). Postgres nolak
--    CREATE OR REPLACE VIEW yang ubah nama/urutan kolom existing atau ngapus kolom --
--    kalau dipaksa "or replace", migration ini ERROR total pas di-apply.
-- ============================================================

drop view if exists pos_sales_with_status;

create view pos_sales_with_status
  with (security_invoker = true) as
select
  id, sale_date, source_ref, revenue_journal_entry_id, total, status,
  customer_id, customer_name, cash_account_id, cash_account_code, cash_account_name
from (
  select
    psl.id,
    psl.sale_date,
    psl.source_ref,
    psl.revenue_journal_entry_id,
    psl.total,
    psl.status,
    psl.customer_id,
    c.name as customer_name,
    psl.cash_account_id,
    ca.code as cash_account_code,
    ca.name as cash_account_name
  from pos_sales_legacy psl
  left join counterparties c on c.id = psl.customer_id
  left join accounts ca on ca.id = psl.cash_account_id

  union all

  select
    t.id,
    t.date as sale_date,
    t.source_ref,
    t.journal_entry_id as revenue_journal_entry_id,
    t.amount as total,
    case when t.status = 'lunas' then 'normal' else t.status end as status,
    t.counterparty_id as customer_id,
    c.name as customer_name,
    ps.cash_account_id,
    ca.code as cash_account_code,
    ca.name as cash_account_name
  from pos_sales ps
  join transactions t on t.id = ps.transaction_id
  left join counterparties c on c.id = t.counterparty_id
  left join accounts ca on ca.id = ps.cash_account_id
) combined;

grant select on pos_sales_with_status to authenticated;
