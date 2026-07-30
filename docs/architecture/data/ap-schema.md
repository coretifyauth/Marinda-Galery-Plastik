# Accounts Payable — Schema (Finalized)

Fase 4 roadmap. Ref konsep bisnis: `docs/domain/human/accounts-payable.md` + `docs/domain/ai/accounts-payable.md`. Ref seed/skenario: `docs/story/accounts-payable.md`. Ref schema yang di-reuse: `docs/architecture/data/journal-entry-schema.md` (RPC `create_journal_entry`+`reverse_journal_entry`, fungsi `set_updated_at()`+`block_edit_delete()`). Ref pola yang di-mirror: `docs/architecture/data/ar-schema.md` — struktur DDL identik, cuma arah kebalik (kita berutang, bukan piutang).

## Keputusan

- **Struktur DDL mirror persis AR** — `suppliers` ganti `customers`, `ap_bills` ganti `ar_invoices`, `ap_payments` ganti `ar_payments`, `ap_payment_allocations` ganti `ar_payment_allocations`. Alasan yang sama semua berlaku (immutability, due_date snapshot, status derived, anti over-allocation) — gak diulang detail di sini, cuma bagian yang beda yang dijelasin.
- **`payment_term_days` di `suppliers` maknanya kebalik dari `customers`** — di AR itu syarat yang KITA tetapkan; di AP itu syarat yang KITA TERIMA dari supplier. Kolom & mekanisme snapshot `due_date`-nya identik, cuma konteks bisnisnya beda (ref `docs/domain/human/accounts-payable.md`).
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

## Belum termasuk (dependency / di luar scope fase ini)

Detail lengkap tiap item: `docs/scope-debt/`.

- **Retur barang ke supplier** — `docs/scope-debt/ap-retur-barang.md`.
- **Diskon bayar cepat** — `docs/scope-debt/ap-diskon-bayar-cepat.md`.
- **Uang muka/DP ke supplier** — `docs/scope-debt/ap-uang-muka-dp.md`.
- **Bill kepisah kategori (compound debit)** — `docs/scope-debt/ap-bill-compound.md`.
