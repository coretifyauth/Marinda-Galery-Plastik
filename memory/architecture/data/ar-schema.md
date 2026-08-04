# Accounts Receivable — Schema (Finalized)

Fase 3 roadmap. Ref konsep bisnis: `docs/domain/accounts-receivable.md` + `memory/domain/accounts-receivable.md`. Ref seed/skenario: `docs/story/accounts-receivable.md`. Ref schema yang di-reuse: `memory/architecture/data/journal-entry-schema.md` (RPC `create_journal_entry`, fungsi `set_updated_at()` & `block_edit_delete()`).

## Keputusan

- **Gak ada tabel/tahap "draft"** — invoice & payment final begitu dibuat & lolos validasi, sama prinsip kayak Journal Entry (`tech-stack-decisions.md`).
- **AR gak bikin jalur pencatatan GL baru** — RPC AR (`create_ar_invoice`, `record_ar_payment`) manggil RPC `create_journal_entry` yang udah ada, bukan insert manual ke `journal_entries`/`journal_lines`. Ini mastiin AR gak pernah "kelewat" nyatet ke GL atau nyatet dengan cara beda.
- **Immutability sama persis pola Journal Entry** — RLS gak ada policy `UPDATE`/`DELETE` (default deny) + trigger `block_edit_delete` (di-reuse dari `journal-entry-schema.md`, gak bikin fungsi baru) sebagai jaring kedua.
- **`due_date` snapshot, bukan generated column** — dihitung sekali di RPC `create_ar_invoice` dari `customers.payment_term_days` **pas invoice dibuat**, disimpan sebagai kolom biasa. Beda dari `accounts.normal_balance` yang generated dan dihitung ulang tiap baca — di sini sengaja snapshot biar perubahan termin customer nanti gak retroaktif ngubah invoice lama (lihat `accounts-receivable.md` domain doc).
- **Status invoice (lunas/sebagian/belum/dibatalkan) gak disimpan** — derived query dari `SUM(ar_payment_allocations.amount)` per invoice dibanding `ar_invoices.amount`, DITAMBAH cek apakah `journal_entry_id`-nya punya reversal (`exists (select 1 from journal_entries where reverses_entry_id = ar_invoices.journal_entry_id)`) buat status "dibatalkan". Konsisten sama keputusan "no `is_active`" di `coa-schema.md`.
- **Pembatalan invoice cuma boleh kalau belum ada alokasi payment** — RPC `cancel_ar_invoice` nolak keras (`raise exception`) kalau `ar_payment_allocations` invoice itu udah punya ≥1 baris. Ref alasan bisnis: `docs/domain/accounts-receivable.md` constraint #5.
- **Anti over-allocation ditegakkan trigger**, bukan cuma app-level — nolak insert alokasi yang bikin total alokasi ngelebihin amount invoice atau amount payment.
- **`customers` satu-satunya tabel AR yang mutable** — master data, `payment_term_days`/`name`/`contact` boleh di-`UPDATE` kapan pun (gak ada published-lock kayak `accounts`, karena gak ada resiko retroaktif — lihat domain doc).
- Money pakai `numeric(14,2)`, bukan float (invariant `AGENT.md`).

## DDL

### `customers` — master data pihak yang berutang

Tiap baris = 1 customer (warung langganan). Yang perlu diperhatiin:
- `payment_term_days` — default termin (hari) dipakai buat ngitung `due_date` invoice baru. Bukan kolom terkunci — boleh diubah kapan pun, cuma ngaruh ke invoice baru ke depan (`due_date` invoice lama udah ke-snapshot, gak ikut berubah).
- `credit_limit` — nullable, batas nominal total piutang open (belum lunas) yang boleh nyangkut bersamaan buat customer ini. `NULL` = gak ada batas (unlimited), dipilih biar customer existing gak otomatis kena hold begitu migration ini di-apply. Dicek di `create_ar_invoice` (lihat "Credit Hold" di bawah), bukan constraint DB — perlu bandingin sama data dari tabel lain (`ar_invoices`/`ar_payment_allocations`), gak bisa jadi `CHECK` di level kolom.
- `overdue_threshold_days` — nullable, toleransi hari keterlambatan sebelum kena hold. `NULL` = gak ada batas waktu buat customer ini. UI prefill nilainya = `payment_term_days` pas customer baru dibuat (keputusan produk, bukan default DB), tapi keduanya kolom independen — bisa diubah manual per customer sesuai profil risiko (lihat `docs/domain/accounts-receivable.md` bagian "Credit Hold").
- `archived_at` — pola sama kayak `accounts` (`memory/preferences/system/state-naming-convention.md`): satu-satunya penanda lifecycle, gak ada `is_active` terpisah.

```sql
create table customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact text,
  payment_term_days int not null default 7 check (payment_term_days > 0),
  credit_limit numeric(14,2) check (credit_limit is null or credit_limit > 0),
  overdue_threshold_days int check (overdue_threshold_days is null or overdue_threshold_days > 0),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger customers_set_updated_at
  before update on customers
  for each row execute function set_updated_at();
```

`credit_limit`/`overdue_threshold_days` ditambah belakangan lewat `0020_ar_credit_hold.sql` (`alter table`) — ditulis di sini langsung di `create table` biar schema doc selalu nunjukin bentuk final tabel, bukan riwayat migration per migration (lihat migration file buat riwayat perubahannya).

`set_updated_at()` udah ada dari `coa-schema.md`, gak perlu bikin ulang.

### `ar_invoices` — piutang timbul

Satu baris = satu kejadian "kirim barang/jasa, belum dibayar". Yang perlu diperhatiin:
- `due_date` — **disimpan**, dihitung `invoice_date + customers.payment_term_days` di RPC pas insert, bukan generated column (lihat "Keputusan" di atas).
- `journal_entry_id` — **wajib** (`not null`), nunjuk ke entry yang dibikin RPC `create_journal_entry` (Debit Piutang Usaha, Kredit Pendapatan). Invoice AR tanpa journal entry gak boleh ada — dijamin karena satu-satunya jalur insert yang diizinin RLS (lewat RPC `security invoker`) selalu bikin entry-nya duluan.
- `source_ref` — wajib, pola sama `journal_entries` (traceability ke bukti fisik/surat jalan).
- **Gak ada `updated_at`/`archived_at`** — invoice gak pernah diedit, sekali ada permanen (koreksi = reversing entry lewat `journal_entries`, invoice asli tetap kelihatan di histori).

```sql
create table ar_invoices (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  invoice_date date not null,
  due_date date not null,
  description text,
  source_ref text not null,
  amount numeric(14,2) not null check (amount > 0),
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index ar_invoices_customer_id_idx on ar_invoices(customer_id);
create index ar_invoices_journal_entry_id_idx on ar_invoices(journal_entry_id);
```

Index di `customer_id` buat query "semua invoice 1 customer" (histori piutang per warung, dipakai aging report). Index di `journal_entry_id` jaga-jaga lookup balik dari sisi GL.

### `ar_payments` — piutang berkurang

Satu baris = satu kejadian bayar nyata dari customer (bukan jadwal). Yang perlu diperhatiin:
- `amount` — **total** yang dibayar, gak peduli itu nanti dialokasikan ke berapa banyak invoice. Journal entry (Debit Kas/Bank, Kredit Piutang Usaha) dibikin sejumlah ini, satu entry per payment.
- `journal_entry_id` — wajib, pola sama `ar_invoices`.
- **Gak ada `updated_at`/`archived_at`** — sama alasan `ar_invoices`.

```sql
create table ar_payments (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  payment_date date not null,
  amount numeric(14,2) not null check (amount > 0),
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index ar_payments_customer_id_idx on ar_payments(customer_id);
```

### `ar_payment_allocations` — jembatan payment ↔ invoice

Satu baris = "payment X nutup invoice Y sejumlah Z". Kenapa tabel terpisah, bukan `invoice_id` langsung di `ar_payments`: 1 payment bisa nutup banyak invoice sekaligus (bayar gabungan), 1 invoice bisa dilunasi lewat beberapa payment (cicilan) — hubungannya many-to-many, bukan many-to-one. Detail skenario: `docs/domain/accounts-receivable.md`.

```sql
create table ar_payment_allocations (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references ar_payments(id) on delete cascade,
  invoice_id uuid not null references ar_invoices(id),
  amount numeric(14,2) not null check (amount > 0),
  created_at timestamptz not null default now()
);

create index ar_payment_allocations_payment_id_idx on ar_payment_allocations(payment_id);
create index ar_payment_allocations_invoice_id_idx on ar_payment_allocations(invoice_id);
```

`on delete cascade` ke `ar_payments` cuma jaga-jaga integritas referensial (pola sama `journal_lines` ke `journal_entries`) — di praktiknya gak pernah kepakai karena `ar_payments` gak pernah bisa di-`DELETE` (trigger `block_edit_delete` nolak). Index di `invoice_id` yang paling sering dipakai: hitung `SUM(amount)` per invoice buat nentuin status lunas/sebagian/belum.

## Trigger

### `ar_payment_allocations_no_over_allocation` — cegah alokasi ngelebihin

Ditegakkan sebelum insert baris alokasi: total alokasi yang udah ada + alokasi baru gak boleh ngelebihin `amount` invoice-nya, atau `amount` payment-nya. Beda dari balance-check Journal Entry (yang deferred, nunggu semua baris entry masuk) — di sini gak perlu deferred, karena tiap baris alokasi adalah fakta independen yang bisa langsung divalidasi begitu masuk (gak ada baris "pasangan" yang belum tentu masuk dalam transaksi yang sama).

```sql
create function ar_payment_allocations_no_over_allocation() returns trigger as $$
declare
  v_invoice_amount numeric;
  v_invoice_allocated numeric;
  v_payment_amount numeric;
  v_payment_allocated numeric;
begin
  select amount into v_invoice_amount from ar_invoices where id = new.invoice_id;
  select coalesce(sum(amount), 0) into v_invoice_allocated
    from ar_payment_allocations where invoice_id = new.invoice_id;

  if v_invoice_allocated + new.amount > v_invoice_amount then
    raise exception 'Alokasi ke invoice % melebihi sisa piutang (sisa %, coba alokasi %)',
      new.invoice_id, v_invoice_amount - v_invoice_allocated, new.amount;
  end if;

  select amount into v_payment_amount from ar_payments where id = new.payment_id;
  select coalesce(sum(amount), 0) into v_payment_allocated
    from ar_payment_allocations where payment_id = new.payment_id;

  if v_payment_allocated + new.amount > v_payment_amount then
    raise exception 'Alokasi dari payment % melebihi sisa yang belum teralokasi (sisa %, coba alokasi %)',
      new.payment_id, v_payment_amount - v_payment_allocated, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger ar_payment_allocations_no_over_allocation_trigger
  before insert on ar_payment_allocations
  for each row execute function ar_payment_allocations_no_over_allocation();
```

### Immutability — reuse `block_edit_delete()` dari Journal Entry

Fungsi ini udah ada di `journal-entry-schema.md`, tinggal dipasang ke 3 tabel AR yang gak boleh diedit/dihapus.

```sql
create trigger ar_invoices_block_edit_delete
  before update or delete on ar_invoices
  for each row execute function block_edit_delete();

create trigger ar_payments_block_edit_delete
  before update or delete on ar_payments
  for each row execute function block_edit_delete();

create trigger ar_payment_allocations_block_edit_delete
  before update or delete on ar_payment_allocations
  for each row execute function block_edit_delete();
```

## RPC (financial write — atomik, reuse `create_journal_entry`)

Dua-duanya `security invoker`, pola sama `journal-entry-schema.md`. Kunci desainnya: **gak insert manual ke `journal_entries`/`journal_lines`** — manggil RPC `create_journal_entry` yang udah ada, biar validasi (leaf-only, balance-check) dan atomicity-nya otomatis kewarisin, gak perlu ditulis ulang.

### `create_ar_invoice` — bikin invoice + journal entry-nya sekaligus

**Credit Hold** (`0020_ar_credit_hold.sql`) — sebelum bikin apa pun, RPC ini cek 2 kondisi independen (OR, salah satu kepenuhi udah cukup nolak):
- **Nominal prospektif**: `(outstanding sekarang + amount invoice baru) > credit_limit` — sengaja prospektif (nambahin amount invoice yang mau dibuat), bukan cuma cek "udah lewat limit apa belum", karena tujuan limit itu nyegah exposure nambah lewat batas, bukan cuma ngasih tau udah lewat.
- **Waktu**: ada invoice open (belum lunas & belum dibatalkan) yang `p_invoice_date - due_date` (hari overdue-nya) > `overdue_threshold_days`.

Outstanding dihitung inline (bukan manggil fungsi terpisah) — `sum(amount - alokasi)` per invoice customer itu, exclude invoice yang punya reversal (`journal_entries.reverses_entry_id`), sama pola derived status lunas/sebagian/belum yang udah dipakai di tempat lain. `NULL` di `credit_limit`/`overdue_threshold_days` bikin kondisi itu di-skip (gak pernah nolak dari sisi itu).

Kalau salah satu kepenuhi, RPC `raise exception` sebelum sempat manggil `create_journal_entry` — invoice gak jadi dibuat, gak ada jejak apa pun di GL (gagal bersih, bukan partial write).

```sql
create or replace function create_ar_invoice(
  p_customer_id uuid,
  p_invoice_date date,
  p_description text,
  p_source_ref text,
  p_amount numeric,
  p_receivable_account_id uuid,
  p_revenue_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_term_days int;
  v_due_date date;
  v_entry_id uuid;
  v_invoice_id uuid;
  v_credit_limit numeric;
  v_overdue_threshold_days int;
  v_outstanding numeric;
  v_max_overdue_days int;
begin
  select payment_term_days, credit_limit, overdue_threshold_days
    into v_term_days, v_credit_limit, v_overdue_threshold_days
    from customers where id = p_customer_id;
  v_due_date := p_invoice_date + v_term_days;

  select coalesce(sum(ai.amount - coalesce(alloc.paid, 0)), 0),
         coalesce(max(p_invoice_date - ai.due_date), 0)
    into v_outstanding, v_max_overdue_days
    from ar_invoices ai
    left join (
      select invoice_id, sum(amount) as paid
      from ar_payment_allocations
      group by invoice_id
    ) alloc on alloc.invoice_id = ai.id
    where ai.customer_id = p_customer_id
      and not exists (
        select 1 from journal_entries je where je.reverses_entry_id = ai.journal_entry_id
      )
      and ai.amount - coalesce(alloc.paid, 0) > 0;

  if v_credit_limit is not null and (v_outstanding + p_amount) > v_credit_limit then
    raise exception 'Customer kena credit hold: piutang outstanding % + invoice baru % ngelewatin credit_limit %',
      v_outstanding, p_amount, v_credit_limit;
  end if;

  if v_overdue_threshold_days is not null and v_max_overdue_days > v_overdue_threshold_days then
    raise exception 'Customer kena credit hold: ada piutang telat % hari (toleransi % hari)',
      v_max_overdue_days, v_overdue_threshold_days;
  end if;

  v_entry_id := create_journal_entry(
    p_invoice_date, p_description, p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_receivable_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_revenue_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into ar_invoices (customer_id, invoice_date, due_date, description, source_ref, amount, journal_entry_id, created_by)
  values (p_customer_id, p_invoice_date, v_due_date, p_description, p_source_ref, p_amount, v_entry_id, auth.uid())
  returning id into v_invoice_id;

  return v_invoice_id;
end;
$$;
```

### `record_ar_payment` — bikin payment + journal entry + alokasi ke invoice sekaligus

`p_allocations` array `{"invoice_id": uuid, "amount": numeric}` — boleh 1 baris (nutup 1 invoice) atau banyak baris (nutup beberapa invoice sekaligus). Trigger `ar_payment_allocations_no_over_allocation` yang nolak kalau totalnya gak masuk akal.

```sql
create function record_ar_payment(
  p_customer_id uuid,
  p_payment_date date,
  p_amount numeric,
  p_source_ref text,
  p_cash_account_id uuid,
  p_receivable_account_id uuid,
  p_allocations jsonb
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
    p_payment_date, 'Pelunasan piutang', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_cash_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_receivable_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into ar_payments (customer_id, payment_date, amount, source_ref, journal_entry_id, created_by)
  values (p_customer_id, p_payment_date, p_amount, p_source_ref, v_entry_id, auth.uid())
  returning id into v_payment_id;

  for v_alloc in select * from jsonb_array_elements(p_allocations)
  loop
    insert into ar_payment_allocations (payment_id, invoice_id, amount)
    values (v_payment_id, (v_alloc->>'invoice_id')::uuid, (v_alloc->>'amount')::numeric);
  end loop;

  return v_payment_id;
end;
$$;
```

### `cancel_ar_invoice` — batalkan invoice salah input (reversing entry, dengan guard)

Manggil `reverse_journal_entry` yang udah ada (fase 2) — pakai **akun yang sama persis** dengan invoice asli, debit/kredit ketuker, gak butuh akun baru (ini koreksi "salah input", bukan kejadian bisnis baru kayak retur barang). Bedanya dari reversing entry biasa: ada validasi awal yang nolak kalau invoice udah kesentuh payment.

```sql
create function cancel_ar_invoice(
  p_invoice_id uuid,
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
  from ar_payment_allocations where invoice_id = p_invoice_id;

  if v_allocated_count > 0 then
    raise exception 'Invoice % udah punya % alokasi payment — gak bisa dibatalkan lewat jalur ini', p_invoice_id, v_allocated_count;
  end if;

  select journal_entry_id into v_original_entry_id from ar_invoices where id = p_invoice_id;

  v_new_entry_id := reverse_journal_entry(v_original_entry_id, p_entry_date, p_source_ref);

  return v_new_entry_id;
end;
$$;
```

Gak insert/update apa pun ke `ar_invoices` — baris invoice asli tetap ada persis kayak semula (immutability tetap utuh). Status "dibatalkan" murni kebaca dari keberadaan reversal di `journal_entries`, sama pola derived kayak status lunas/sebagian/belum.

## RLS Policy

**`customers_select`, `ar_invoices_select`, `ar_payments_select`, `ar_payment_allocations_select`** — semua yang `authenticated` boleh liat, pola sama modul lain: data AR itu referensi bareng buat kerja/lapor, gak dibatesin per role.

**`customers_insert`/`customers_update`, `ar_invoices_insert`, `ar_payments_insert`, `ar_payment_allocations_insert`** — cuma `admin`/`accountant` (subquery ke `user_roles`, pola identik `accounts_insert`).

**Sengaja gak ada policy `UPDATE`/`DELETE` di 3 tabel AR transaksional** (`ar_invoices`, `ar_payments`, `ar_payment_allocations`) — RLS default deny + trigger `block_edit_delete` = 2 lapis immutability, sama persis `journal_entries`/`journal_lines`. `customers` beda, boleh `UPDATE` (master data, bukan transaksional) tapi tetap gak ada `DELETE` (arsip lewat `archived_at`, bukan hard-delete).

```sql
alter table customers enable row level security;

create policy customers_select on customers
  for select using (auth.role() = 'authenticated');

create policy customers_insert on customers
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

create policy customers_update on customers
  for update using (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );
-- sengaja gak ada policy DELETE -> arsip lewat archived_at, hard delete tertutup total

alter table ar_invoices enable row level security;

create policy ar_invoices_select on ar_invoices
  for select using (auth.role() = 'authenticated');

create policy ar_invoices_insert on ar_invoices
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table ar_payments enable row level security;

create policy ar_payments_select on ar_payments
  for select using (auth.role() = 'authenticated');

create policy ar_payments_insert on ar_payments
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table ar_payment_allocations enable row level security;

create policy ar_payment_allocations_select on ar_payment_allocations
  for select using (auth.role() = 'authenticated');

create policy ar_payment_allocations_insert on ar_payment_allocations
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );
-- sengaja gak ada policy UPDATE/DELETE di 3 tabel AR transaksional -> RLS default deny
```

## Grant

"Automatically expose new tables" dimatikan di project settings (`coa-schema.md`) — tabel baru butuh grant eksplisit biar PostgREST gak nolak duluan sebelum RLS sempat dicek.

```sql
grant select, insert, update on customers to authenticated;
grant select, insert on ar_invoices to authenticated;
grant select, insert on ar_payments to authenticated;
grant select, insert on ar_payment_allocations to authenticated;
```

RPC (`create_ar_invoice`, `record_ar_payment`) otomatis kepakai `authenticated` selama grant `execute` default Postgres gak dicabut — konsisten sama perlakuan `create_journal_entry`/`reverse_journal_entry` di `journal-entry-schema.md` (grant RPC eksplisit ditambahin di migration terpisah kalau ternyata perlu, ref migration `0006_journal_entry_rpc_grants.sql`).

## Belum termasuk (dependency / di luar scope fase ini)

- **Retur barang (credit note)** — invoice perlu dikurangi/dibatalkan sebagian karena barang dikembalikan. Butuh desain entitas baru, ditunda.
- **Uang muka/DP sebelum invoice ada** — asumsi sekarang: `record_ar_payment` selalu butuh minimal 1 alokasi ke invoice yang udah ada (gak ada payment "nganggur"). Kalau nanti perlu DP di depan, butuh keputusan desain terpisah (payment boleh 0 alokasi dulu).
- **Overpayment jadi saldo kredit customer** — trigger sekarang nolak keras alokasi yang ngelebihin. Kasus "kelebihan bayar dianggap kredit buat invoice berikutnya" belum di-scope.
- **Aging report / dashboard piutang jatuh tempo** — query read-side (`due_date` vs `now()`, join alokasi buat status), digarap pas UI dibangun, gak butuh kolom/tabel tambahan.
