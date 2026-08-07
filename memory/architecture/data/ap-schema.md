# Accounts Payable — Schema (Finalized)

Fase 4 roadmap. Ref konsep bisnis: `docs/domain/accounts-payable.md` + `memory/domain/accounts-payable.md`. Ref seed/skenario: `docs/story/accounts-payable.md`. Ref schema yang di-reuse: `memory/architecture/data/journal-entry-schema.md` (RPC `create_journal_entry`+`reverse_journal_entry`, fungsi `set_updated_at()`+`block_edit_delete()`). Ref pola yang di-mirror: `memory/architecture/data/ar-schema.md` — struktur DDL identik, cuma arah kebalik (kita berutang, bukan piutang).

## Keputusan

- **Struktur DDL mirror persis AR** — `suppliers` ganti `customers`, `ap_bills` ganti `ar_invoices`, `ap_payments` ganti `ar_payments`, `ap_payment_allocations` ganti `ar_payment_allocations`. Alasan yang sama semua berlaku (immutability, due_date snapshot, status derived, anti over-allocation) — gak diulang detail di sini, cuma bagian yang beda yang dijelasin.
- **`payment_term_days` di `suppliers` maknanya kebalik dari `customers`** — di AR itu syarat yang KITA tetapkan; di AP itu syarat yang KITA TERIMA dari supplier. Kolom & mekanisme snapshot `due_date`-nya identik, cuma konteks bisnisnya beda (ref `docs/domain/accounts-payable.md`).
- **`create_ap_bill` terima akun debit sebagai parameter, gak di-hardcode ke 1 kategori** — beda dari AR yang debit-nya selalu ke akun Piutang Usaha (fixed secara konsep), bill di AP bisa debit ke Persediaan (beli bahan baku) ATAU Beban (beli jasa/sewa/utility) tergantung jenis pembelian. Parameter `p_debit_account_id` generik, sama pola `create_journal_entry`.
- **Cancellation guard (`cancel_ap_bill`) diterapkan dari awal**, bukan ditambah belakangan — beda dari AR yang nambahnya belakangan setelah kebukti perlu lewat diskusi. Di AP langsung include karena polanya udah teruji.
- Money pakai `numeric(14,2)`, bukan float (invariant `AGENT.md`).

## DDL

### `suppliers` — master data pihak yang CV Barokah berutang

Struktur identik `customers` (`ar-schema.md`), cuma beda makna `payment_term_days` (lihat "Keputusan" di atas — syarat yang diterima, bukan ditetapkan).

```sql
create table suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact text,
  payment_term_days int not null default 14 check (payment_term_days > 0),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger suppliers_set_updated_at
  before update on suppliers
  for each row execute function set_updated_at();
```

`set_updated_at()` di-reuse dari `coa-schema.md`.

### `ap_bills` — utang timbul

Struktur identik `ar_invoices`, satu bedanya: **gak ada kolom akun tetap yang di-hardcode di DDL** (itu keputusan RPC-level, bukan kolom tabel — lihat RPC `create_ap_bill` di bawah, akun debit ditentuin pas insert lewat `journal_entry_id` yang udah dibuat, bukan disimpan ulang di `ap_bills`).

```sql
create table ap_bills (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references suppliers(id),
  bill_date date not null,
  due_date date not null,
  description text,
  source_ref text not null,
  amount numeric(14,2) not null check (amount > 0),
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index ap_bills_supplier_id_idx on ap_bills(supplier_id);
create index ap_bills_journal_entry_id_idx on ap_bills(journal_entry_id);
```

### `ap_payments` — utang berkurang

Identik `ar_payments`, arah kebalik (Debit Utang Usaha, Kredit Kas/Bank alih-alih Debit Kas, Kredit Piutang).

```sql
create table ap_payments (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references suppliers(id),
  payment_date date not null,
  amount numeric(14,2) not null check (amount > 0),
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index ap_payments_supplier_id_idx on ap_payments(supplier_id);
```

### `ap_payment_allocations` — jembatan payment ↔ bill

Identik `ar_payment_allocations`.

```sql
create table ap_payment_allocations (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references ap_payments(id) on delete cascade,
  bill_id uuid not null references ap_bills(id),
  amount numeric(14,2) not null check (amount > 0),
  created_at timestamptz not null default now()
);

create index ap_payment_allocations_payment_id_idx on ap_payment_allocations(payment_id);
create index ap_payment_allocations_bill_id_idx on ap_payment_allocations(bill_id);
```

## Trigger

### `ap_payment_allocations_no_over_allocation` — cegah alokasi ngelebihin

Identik `ar_payment_allocations_no_over_allocation`, ganti nama tabel/kolom.

```sql
create function ap_payment_allocations_no_over_allocation() returns trigger as $$
declare
  v_bill_amount numeric;
  v_bill_allocated numeric;
  v_payment_amount numeric;
  v_payment_allocated numeric;
begin
  select amount into v_bill_amount from ap_bills where id = new.bill_id;
  select coalesce(sum(amount), 0) into v_bill_allocated
    from ap_payment_allocations where bill_id = new.bill_id;

  if v_bill_allocated + new.amount > v_bill_amount then
    raise exception 'Alokasi ke bill % melebihi sisa utang (sisa %, coba alokasi %)',
      new.bill_id, v_bill_amount - v_bill_allocated, new.amount;
  end if;

  select amount into v_payment_amount from ap_payments where id = new.payment_id;
  select coalesce(sum(amount), 0) into v_payment_allocated
    from ap_payment_allocations where payment_id = new.payment_id;

  if v_payment_allocated + new.amount > v_payment_amount then
    raise exception 'Alokasi dari payment % melebihi sisa yang belum teralokasi (sisa %, coba alokasi %)',
      new.payment_id, v_payment_amount - v_payment_allocated, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger ap_payment_allocations_no_over_allocation_trigger
  before insert on ap_payment_allocations
  for each row execute function ap_payment_allocations_no_over_allocation();
```

### Immutability — reuse `block_edit_delete()`

```sql
create trigger ap_bills_block_edit_delete
  before update or delete on ap_bills
  for each row execute function block_edit_delete();

create trigger ap_payments_block_edit_delete
  before update or delete on ap_payments
  for each row execute function block_edit_delete();

create trigger ap_payment_allocations_block_edit_delete
  before update or delete on ap_payment_allocations
  for each row execute function block_edit_delete();
```

## RPC (financial write — atomik, reuse `create_journal_entry`/`reverse_journal_entry`)

### `create_ap_bill` — bikin bill + journal entry-nya sekaligus

Beda dari `create_ar_invoice`: nerima `p_debit_account_id` generik (bisa Persediaan atau Beban, tergantung jenis pembelian — lihat "Keputusan"), bukan 2 akun fixed per konsep (receivable+revenue). Akun kredit selalu Utang Usaha (`p_payable_account_id`), sama pola dengan `p_receivable_account_id` di AR.

```sql
create function create_ap_bill(
  p_supplier_id uuid,
  p_bill_date date,
  p_description text,
  p_source_ref text,
  p_amount numeric,
  p_debit_account_id uuid,
  p_payable_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_term_days int;
  v_due_date date;
  v_entry_id uuid;
  v_bill_id uuid;
begin
  select payment_term_days into v_term_days from suppliers where id = p_supplier_id;
  v_due_date := p_bill_date + v_term_days;

  v_entry_id := create_journal_entry(
    p_bill_date, p_description, p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_debit_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_payable_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into ap_bills (supplier_id, bill_date, due_date, description, source_ref, amount, journal_entry_id, created_by)
  values (p_supplier_id, p_bill_date, v_due_date, p_description, p_source_ref, p_amount, v_entry_id, auth.uid())
  returning id into v_bill_id;

  return v_bill_id;
end;
$$;
```

### `record_ap_payment` — bikin payment + journal entry + alokasi ke bill sekaligus

Identik `record_ar_payment`, arah kebalik (Debit Utang Usaha, Kredit Kas/Bank).

```sql
create function record_ap_payment(
  p_supplier_id uuid,
  p_payment_date date,
  p_amount numeric,
  p_source_ref text,
  p_payable_account_id uuid,
  p_cash_account_id uuid,
  p_allocations jsonb -- array of {"bill_id": uuid, "amount": numeric}
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_entry_id uuid;
  v_payment_id uuid;
  v_alloc jsonb;
begin
  v_entry_id := create_journal_entry(
    p_payment_date, 'Pelunasan utang', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_payable_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_cash_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into ap_payments (supplier_id, payment_date, amount, source_ref, journal_entry_id, created_by)
  values (p_supplier_id, p_payment_date, p_amount, p_source_ref, v_entry_id, auth.uid())
  returning id into v_payment_id;

  for v_alloc in select * from jsonb_array_elements(p_allocations)
  loop
    insert into ap_payment_allocations (payment_id, bill_id, amount)
    values (v_payment_id, (v_alloc->>'bill_id')::uuid, (v_alloc->>'amount')::numeric);
  end loop;

  return v_payment_id;
end;
$$;
```

### `cancel_ap_bill` — batalkan bill salah input (reversing entry, dengan guard)

Identik `cancel_ar_invoice`. Diterapkan dari awal (bukan ditambah belakangan kayak AR), karena guard-nya udah kebukti perlu.

```sql
create function cancel_ap_bill(
  p_bill_id uuid,
  p_entry_date date,
  p_source_ref text
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_allocated_count int;
  v_original_entry_id uuid;
  v_new_entry_id uuid;
begin
  select count(*) into v_allocated_count
  from ap_payment_allocations where bill_id = p_bill_id;

  if v_allocated_count > 0 then
    raise exception 'Bill % udah punya % alokasi payment — gak bisa dibatalkan lewat jalur ini', p_bill_id, v_allocated_count;
  end if;

  select journal_entry_id into v_original_entry_id from ap_bills where id = p_bill_id;

  v_new_entry_id := reverse_journal_entry(v_original_entry_id, p_entry_date, p_source_ref);

  return v_new_entry_id;
end;
$$;
```

## RLS Policy

Pola identik AR — `select` terbuka buat semua `authenticated`, `insert` cuma `admin`/`accountant`, gak ada `update`/`delete` di 3 tabel transaksional (immutability), `suppliers` boleh `update` (master data) tapi gak ada `delete`.

```sql
alter table suppliers enable row level security;

create policy suppliers_select on suppliers
  for select using (auth.role() = 'authenticated');

create policy suppliers_insert on suppliers
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

create policy suppliers_update on suppliers
  for update using (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );
-- sengaja gak ada policy DELETE -> arsip lewat archived_at, hard delete tertutup total

alter table ap_bills enable row level security;

create policy ap_bills_select on ap_bills
  for select using (auth.role() = 'authenticated');

create policy ap_bills_insert on ap_bills
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table ap_payments enable row level security;

create policy ap_payments_select on ap_payments
  for select using (auth.role() = 'authenticated');

create policy ap_payments_insert on ap_payments
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table ap_payment_allocations enable row level security;

create policy ap_payment_allocations_select on ap_payment_allocations
  for select using (auth.role() = 'authenticated');

create policy ap_payment_allocations_insert on ap_payment_allocations
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );
-- sengaja gak ada policy UPDATE/DELETE di 3 tabel AP transaksional -> RLS default deny
```

## Grant

```sql
grant select, insert, update on suppliers to authenticated;
grant select, insert on ap_bills to authenticated;
grant select, insert on ap_payments to authenticated;
grant select, insert on ap_payment_allocations to authenticated;
```

## AP Credit Note (Retur Barang ke Supplier, migration `0035_ap_credit_notes_schema.sql`)

Ref bisnis: `docs/domain/accounts-payable.md` bagian "Retur Barang ke Supplier". Ref DDL yang di-reuse: `journal-entry-schema.md` (`create_journal_entry`, `block_edit_delete`), `inventory-schema.md` (`consume_weighted_average`, `goods_receipt_notes`/`goods_receipt_lines`). 0 perubahan struktur ke `ap_bills`/`ap_payments`/`suppliers` (gak ada kolom baru) — tapi 2 fungsi existing dari `0010` diperluas (`create or replace`): `ap_payment_allocations_no_over_allocation` dan `cancel_ap_bill`, lihat bagian `ap_bill_remaining` di bawah.

**Beda mendasar dari AR Credit Note (`ar-schema.md`)**: 2 resolusi retur yang **saling eksklusif**, dipilih manual, bukan additive kayak AR. Ketauan lewat proses ngajarin fitur ini bahwa `warranty_replacement` di AR justru punya cacat desain (kompensasi ganda) — sudah diperbaiki lewat migration `0037_ar_warranty_replacement_discount_reversal.sql` (`warranty_replacement` sekarang wajib membalikkan diskon retur proporsional, bukan jadi saling eksklusif seperti AP), lihat `ar-schema.md`.

Akun baru: `1350` **Piutang Retur Supplier** (asset) — di-insert di migration **seed** (`0036_seed_demo_ap_credit_notes.sql`), bukan di migration schema, pola sama semua akun baru lain (`2400`/`2500` dst) — bukan bagian dari `0035_ap_credit_notes_schema.sql` itu sendiri. Sengaja terpisah dari rencana akun `Uang Muka Pembelian` (`ap-uang-muka-dp.md`, belum dibangun), beda asal jurnal.

**Ketahuan lewat `schema-reviewer` sebelum diapply** (2 blocker + 1 warning, sudah diperbaiki di file final): (1) `ap_bill_remaining()` awalnya cuma 2 reducer, kelewat `ap_return_credit_applications` — bisa bikin over-allocation nyata (bill yang udah "dibayar" pakai saldo kredit retur masih bisa dialokasikan payment lagi ngelebihin sisa riil); (2) `cancel_ap_bill` (0010) awalnya gak diperbarui sama sekali buat 2 reducer baru — sekarang diperluas; (3) `create_ap_credit_note` jalur full awalnya nerima `p_amount` independen dari cost fisik yang dihitung `consume_weighted_average` — bisa divergen tanpa ketauan. Detail perbaikan di masing-masing bagian di bawah.

Cuma nanganin item Weighted Average — bukan lagi "sementara": FIFO sudah dihapus total dari sistem (migration `0038_remove_fifo_costing.sql`), jadi Weighted Average sekarang satu-satunya jalur yang ada, 0 dampak balik ke fitur ini. Batas waktu retur sengaja gak termasuk dan gak akan digarap (bukan scope-debt, keputusan final).

### `ap_credit_notes` — Opsi A, selalu dibuat kalau resolusinya "kurangi utang"

Struktur identik `ar_credit_notes`, field `invoice_id` diganti `bill_id`.

```sql
create table ap_credit_notes (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references ap_bills(id),
  credit_note_date date not null,
  source_ref text not null,
  amount numeric(14,2) not null check (amount > 0),
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
```

Guard `ap_credit_notes_no_over_return` — cap ke `ap_bills.amount` (bukan sisa outstanding, karena retur independen dari status bayar), pola identik `ar_credit_notes_no_over_return`.

### `purchase_return_lines` — rincian item Opsi A (cuma jalur full, ada `goods_receipt_notes`)

Beda dari `inventory_returns`/`inventory_return_lines` di AR: **gak butuh tabel header terpisah** — `inventory_returns` di AR eksis karena `warranty_replacement` butuh nunjuk balik ke situ (bukti fisik). Opsi B di AP berdiri sendiri, gak pernah nunjuk ke sini, jadi `purchase_return_lines` cukup FK langsung ke `ap_credit_notes`.

```sql
create table purchase_return_lines (
  id uuid primary key default gen_random_uuid(),
  credit_note_id uuid not null references ap_credit_notes(id) on delete cascade,
  item_id uuid not null references items(id),
  qty_returned numeric(14,3) not null check (qty_returned > 0),
  total_cost numeric(14,2) not null check (total_cost > 0)
);
```

### `purchase_replacements` + `purchase_replacement_lines` — Opsi B, berdiri sendiri

**Gak pernah nunjuk ke `ap_credit_notes`** — berbeda dari `warranty_replacements` AR yang wajib punya `credit_note_id`. Jurnalnya Debit Persediaan (barang baru) / Kredit Persediaan (barang rusak) — **akun yang sama di 2 baris**, net nol, dokumentasi/audit trail doang.

```sql
create table purchase_replacements (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references ap_bills(id),
  replacement_date date not null,
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table purchase_replacement_lines (
  id uuid primary key default gen_random_uuid(),
  purchase_replacement_id uuid not null references purchase_replacements(id) on delete cascade,
  item_id uuid not null references items(id),
  qty_replaced numeric(14,3) not null check (qty_replaced > 0),
  total_cost numeric(14,2) not null check (total_cost > 0)
);
```

### `purchase_returned_qty(bill_id, item_id)` — guard qty gabungan Opsi A + B

Item Weighted Average gak punya proteksi otomatis per-lot (beda dari zaman FIFO masih ada — dulu ada `inventory_lot_consumptions_no_over_consumption`, sudah dihapus bareng FIFO di migration `0038`) — stoknya udah nyampur begitu diterima. Guard ini jumlahin klaim dari **2 tabel sekaligus** (`purchase_return_lines` via `ap_credit_notes.bill_id`, `purchase_replacement_lines` via `purchase_replacements.bill_id`) dan dibandingin ke `goods_receipt_lines.qty_received` — fisiknya cuma ada 1 pool qty yang bisa diklaim, mau lewat jalur mana pun.

```sql
create function purchase_returned_qty(p_bill_id uuid, p_item_id uuid) returns numeric as $$
  select
    coalesce((
      select sum(prl.qty_returned) from purchase_return_lines prl
      join ap_credit_notes acn on acn.id = prl.credit_note_id
      where acn.bill_id = p_bill_id and prl.item_id = p_item_id
    ), 0)
    +
    coalesce((
      select sum(prpl.qty_replaced) from purchase_replacement_lines prpl
      join purchase_replacements prp on prp.id = prpl.purchase_replacement_id
      where prp.bill_id = p_bill_id and prpl.item_id = p_item_id
    ), 0);
$$ language sql stable;
```

Dipakai 2 trigger insert (`purchase_return_lines_no_over_return_trigger`, `purchase_replacement_lines_no_over_return_trigger`) yang keduanya juga nge-lookup `goods_receipt_lines.qty_received` lewat `goods_receipt_notes.bill_id`.

### `ap_return_credits` + `ap_return_credit_applications` + `ap_return_credit_refunds`

Mirror `ar_return_credits` (0031) persis, arah asset kebalik (di AR liability kita ke customer, di sini asset kita ke supplier).

```sql
create table ap_return_credits (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references suppliers(id),
  credit_note_id uuid not null references ap_credit_notes(id),
  amount numeric(14,2) not null check (amount > 0),
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table ap_return_credit_applications (
  id uuid primary key default gen_random_uuid(),
  credit_id uuid not null references ap_return_credits(id),
  bill_id uuid not null references ap_bills(id),
  amount numeric(14,2) not null check (amount > 0),
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table ap_return_credit_refunds (
  id uuid primary key default gen_random_uuid(),
  credit_id uuid not null references ap_return_credits(id),
  amount numeric(14,2) not null check (amount > 0),
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
```

Guard `ap_return_credit_applications_guard` cek: supplier match, bill belum dibatalkan, amount ≤ `ap_bill_remaining(bill_id)`. Guard `ap_return_credit_refunds_guard` cek amount ≤ `ap_return_credit_remaining(credit_id)`. Pola identik `ar_return_credit_applications_guard`/`ar_return_credit_refunds_guard`.

### `ap_bill_remaining(bill_id)` — disentralisasi dari AWAL, 3 reducer

Beda dari AR yang baru disentralisasi belakangan (0031, setelah bug over-allocation berulang kebukti) — di AP langsung dibangun dari awal karena polanya udah kenal. **3 reducer**: `ap_payment_allocations` + `ap_credit_notes` + `ap_return_credit_applications` **aktif** (belum di-reverse). Reducer ke-3 ini awalnya kelewat (ketauan `schema-reviewer`) — tanpa dia, bill yang udah "dibayar" pakai saldo kredit retur masih bisa dialokasikan payment tunai lagi ngelebihin sisa riil, exploit konkret: bill 100, `apply_ap_return_credit` 100 (guard lolos karena `ap_bill_remaining` belum ngitung applications), lalu `record_ap_payment` 100 lagi ke bill yang sama juga lolos (guard yang sama, cek yang sama) → total "pelunasan" 200 buat bill 100.

```sql
create function ap_bill_remaining(p_bill_id uuid) returns numeric as $$
  select ab.amount
    - coalesce((select sum(amount) from ap_payment_allocations where bill_id = p_bill_id), 0)
    - coalesce((select sum(amount) from ap_credit_notes where bill_id = p_bill_id), 0)
    - coalesce((
        select sum(arca.amount) from ap_return_credit_applications arca
        where arca.bill_id = p_bill_id
          and not exists (
            select 1 from journal_entries je where je.reverses_entry_id = arca.journal_entry_id
          )
      ), 0)
  from ap_bills ab
  where ab.id = p_bill_id;
$$ language sql stable;
```

**`ap_payment_allocations_no_over_allocation` (0010) diperbarui** pakai fungsi ini alih-alih ngecek langsung ke `ap_bills.amount`. **`cancel_ap_bill` (0010) juga diperbarui** — hard-block tambahan kalau bill udah punya `ap_credit_notes` (pola sama guard payment-allocation: bill udah "kesentuh" transaksi lain), plus auto-reverse loop buat `ap_return_credit_applications` aktif yang nunjuk ke bill itu (reklasifikasi sederhana, aman dibalik — mirror perluasan `cancel_ar_invoice` di 0031 pas `ar_return_credit_applications` ditambahkan). Awalnya `cancel_ap_bill` gak disentuh sama sekali di migration ini (ketauan `schema-reviewer` sebagai blocker) — pelajarannya: migration yang nambah reducer baru wajib langsung revisit RPC cancel yang berkaitan, jangan ditunda.

### RPC `create_ap_credit_note` (Opsi A)

`p_lines` null/kosong → financial-only (1 jurnal, gak nyentuh inventory, `p_amount` dipakai apa adanya). `p_lines` terisi → full, bill wajib punya `goods_receipt_notes`, **`p_amount` DIABAIKAN dan DIGANTI** hasil penjumlahan cost fisik tiap baris (`consume_weighted_average`, dikumpulin ke `v_total_cost_returned` lewat loop yang jalan DULUAN sebelum jurnal dibikin). **Gak ada akun kontra** — beda dari `create_ar_credit_note`, karena Persediaan itu akun neraca.

Kenapa `p_amount` diabaikan di jalur full (beda dari desain awal yang nerima 2 angka independen, ketauan `schema-reviewer` sebagai warning): `create_ar_credit_note` sengaja punya 2 jurnal beda angka (kontra-revenue di harga jual, reversal HPP di cost) karena emang beda konsep. `create_ap_credit_note` cuma punya **1 jurnal** yang langsung ngeKredit Persediaan — nominalnya HARUS sama persis nilai barang yang beneran keluar dari stok, kalau dibiarkan independen Persediaan di GL bisa menyimpang dari `inventory_balances` tanpa ketauan trigger mana pun. Konsekuensi urutan kerja: konsumsi stok jalan duluan (buat tau total cost), baru jurnal + insert `ap_credit_notes` + insert `purchase_return_lines`, baru terakhir hitung excess.

Excess handling: `v_remaining_before` dihitung dari `ap_bill_remaining()` SEBELUM proses apa pun, `v_excess := greatest(0, v_effective_amount - greatest(0, v_remaining_before))`, kalau > 0 wajib isi `p_return_credit_asset_account_id` atau `raise exception`.

Full body: `supabase/migrations/0035_ap_credit_notes_schema.sql`.

### RPC `create_purchase_replacement` (Opsi B)

Konsumsi barang rusak pakai `consume_weighted_average` (fungsi yang sama dipakai jalur full Opsi A), lalu "terima" barang baru pakai `avg_cost` yang identik (`v_line_cost / v_qty`) — karena unit cost-nya sama persis, hitung ulang rata-rata otomatis balik ke `avg_cost` semula (murni aljabar: `((qty_before - qty)*avg + qty*avg) / qty_before = avg`), konsisten sama klaim "net nol" di dokumentasi bisnis.

Full body: `supabase/migrations/0035_ap_credit_notes_schema.sql`.

### RPC `apply_ap_return_credit` / `refund_ap_return_credit`

Mirror `apply_ar_return_credit`/`refund_ar_return_credit` (0031) persis, arah jurnal kebalik (Debit Utang Usaha bukan Kredit Piutang Usaha; Debit Kas bukan konsisten — lihat body lengkap).

Full body: `supabase/migrations/0035_ap_credit_notes_schema.sql`.

### RLS Policy

Pola identik semua tabel transaksional AP/AR lain: `select` terbuka semua `authenticated`, `insert` cuma `admin`/`accountant`, gak ada `update`/`delete` di 7 tabel baru (RLS default-deny + `block_edit_delete` jaring kedua).

### Seed demo

`supabase/migrations/0036_seed_demo_ap_credit_notes.sql` — skenario 6-10 di `docs/story/accounts-payable.md`, lanjutan cross-modul dari `docs/story/inventory.md` (bill Toko Gula Sejahtera Tahap 3 `GRN-GULA-001` & Tahap 5 `GRN-GULA-002`).

## Belum termasuk (dependency / di luar scope fase ini)

Detail lengkap tiap item: `memory/scope-debt/`.

- **Diskon bayar cepat** — `memory/scope-debt/ap-diskon-bayar-cepat.md`.
- **Uang muka/DP ke supplier** — `memory/scope-debt/ap-uang-muka-dp.md`.
- **Bill kepisah kategori (compound debit)** — `memory/scope-debt/ap-bill-compound.md`.
- **Barang rusak tanpa kompensasi supplier sama sekali** — `memory/scope-debt/kerugian-barang-rusak.md` (lintas modul AR & AP).
