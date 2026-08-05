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

## AR Credit Note (Retur Barang) — migration `0021_ar_credit_notes_schema.sql` + `0022_fix_ar_credit_note_lot_source_ref.sql` + `0023_seed_demo_ar_credit_notes.sql`

`0022` adalah bugfix (`create or replace function`) ke RPC `create_ar_credit_note` dari `0021` — insert ke `inventory_lots.source_ref` (kolom uuid, nunjuk id baris dokumen sumber, pola sama `create_goods_receipt`/`create_production_order`) salah pasang `p_source_ref` (parameter text) di `0021`, ketauan pas jalur FIFO retur dieksekusi. Fix pakai `v_credit_note_id`. Nomor migration `0022`/`0023` sengaja ditukar dari draft awal (`0022` seed / `0023` fix) supaya fix ke-apply sebelum seed yang butuh RPC-nya udah bener.

Barang yang udah diinvoice beneran dibalikin customer (rusak/gak laku/salah kirim) — beda dari `cancel_ar_invoice` (invoice salah dari awal). Detail rationale bisnis: `docs/domain/accounts-receivable.md` bagian "Retur Barang".

### `ar_credit_notes` — retur, sisi AR (selalu dibuat)

Satu baris = satu kejadian retur terhadap 1 invoice. Yang perlu diperhatiin:
- `invoice_id` — bukan unique, 1 invoice bisa punya banyak credit note (retur bertahap).
- `journal_entry_id` — nunjuk jurnal kontra-revenue (Debit `Retur & Potongan Penjualan` / Kredit Piutang Usaha), dibuat via `create_journal_entry` (reuse, 0 perubahan).
- **Gak ada `updated_at`/`archived_at`** — immutable, pola sama `ar_invoices`/`ar_payments`.
- Invoice asli (`ar_invoices.amount`) **gak diedit** — retur murni nambah baris baru, sama filosofi immutability journal entry.

```sql
create table ar_credit_notes (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references ar_invoices(id),
  credit_note_date date not null,
  source_ref text not null,
  amount numeric(14,2) not null check (amount > 0),
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
```

### Trigger `ar_credit_notes_no_over_return`

Pola sama `ar_payment_allocations_no_over_allocation` — total `SUM(amount)` credit note per invoice gak boleh ngelebihin `ar_invoices.amount`. Beda dari over-allocation: di sini gak peduli status bayar invoice (bisa aja retur bikin outstanding jadi negatif kalau invoice-nya udah lunas — itu skenario sah, lihat domain doc).

Full body trigger: lihat migration file.

### `inventory_returns` + `inventory_return_lines` — retur, sisi Inventory (cuma jalur full)

Dibuat **cuma kalau** invoice-nya lahir dari `create_goods_issue` (ada baris `goods_issues.invoice_id` yang match). Kebalikan `goods_issues`/`goods_issue_lines` — barang **masuk lagi** (bukan keluar), stok dan HPP di-reverse proporsional.
- `credit_note_id` — 1:1 ke `ar_credit_notes` yang jadi pasangannya (tiap `inventory_returns` pasti punya 1 credit note, tapi gak sebaliknya — credit note financial-only gak punya `inventory_returns` sama sekali).
- `goods_issue_id` — many:1, 1 goods_issue bisa diretur beberapa kali (retur bertahap dari 1 pengiriman).
- `journal_entry_id` — jurnal reversal HPP (Debit Persediaan Barang Jadi / Kredit HPP), **terpisah** dari jurnal kontra-revenue di `ar_credit_notes` (2 jurnal independen, sama pola `create_goods_issue` yang juga bikin 2 jurnal).
- `inventory_return_lines.total_cost` — dihitung dari **snapshot** `goods_issue_lines.total_cost` asli (unit cost pas barang itu keluar), bukan harga sekarang — biar konsisten sama biaya yang beneran diakui waktu itu.

```sql
create table inventory_returns (
  id uuid primary key default gen_random_uuid(),
  credit_note_id uuid not null references ar_credit_notes(id),
  goods_issue_id uuid not null references goods_issues(id),
  journal_entry_id uuid not null references journal_entries(id),
  return_date date not null,
  source_ref text not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table inventory_return_lines (
  id uuid primary key default gen_random_uuid(),
  inventory_return_id uuid not null references inventory_returns(id) on delete cascade,
  item_id uuid not null references items(id),
  qty_returned numeric(14,3) not null check (qty_returned > 0),
  total_cost numeric(14,2) not null check (total_cost > 0)
);
```

Barang yang balik masuk sebagai lot baru (`inventory_lots.source_type = 'SALES_RETURN'`, nilai baru ditambah ke check constraint yang tadinya cuma `PURCHASE_RECEIPT`/`PRODUCTION_OUTPUT`) buat item FIFO, atau blend ke `inventory_balances.avg_cost` (formula sama persis weighted-average-receive di `create_goods_receipt`) buat item Weighted Average.

### Trigger `inventory_return_lines_guard`

Gabung 2 pengecekan dalam 1 trigger (dipasang `before insert on inventory_return_lines`):
1. **No over-return (qty)** — akumulasi `qty_returned` per item per goods_issue gak boleh ngelebihin `goods_issue_lines.qty_issued`-nya. Pola sama `inventory_lot_consumptions_no_over_consumption`.
2. **Batas waktu retur** — kalau `items.return_window_days` (kolom baru, nullable) gak NULL, `return_date - invoice_date` (invoice diambil lewat join `goods_issues` -> `ar_invoices`) gak boleh ngelewatin itu. Ditaro per item (bukan per customer/global) karena soal umur simpan fisik barang — lihat `memory/domain/inventory.md`. `NULL` = gak dibatasi (default, biar item existing gak ke-block retroaktif).

Full body trigger: lihat migration file.

### RPC `create_ar_credit_note`

`security invoker`, pola sama RPC AR lain — reuse `create_journal_entry` (2x kalau jalur full, 1x kalau financial-only), gak pernah insert manual ke `journal_entries`/`journal_lines`.

- `p_lines` (nullable/kosong) menentukan jalur: kosong = financial-only (1 jurnal, invoice yang gak lewat `create_goods_issue`). Terisi = full (2 jurnal + stok balik) — RPC `raise exception` kalau invoice yang dimaksud ternyata gak punya `goods_issues`.
- Nominal jurnal kontra-revenue (`p_amount`) tetap **input eksplisit dari caller**, bukan dihitung RPC — konsisten sama `create_ar_invoice`/`record_ar_payment` yang juga gak pernah nebak nominal uang dari data lain (skema gak nyimpen harga per-unit di level invoice, cuma total).
- Nominal reversal HPP **dihitung RPC dari snapshot** (`goods_issue_lines.total_cost / qty_issued × qty_returned`), bukan input caller — beda dari nominal revenue di atas, ini sengaja dikunci server-side biar gak ada celah caller masukin cost yang gak sesuai catatan asli.
- Guard "item gak ketemu di goods_issue" dicek eksplisit di RPC (bukan cuma ngandelin trigger yang jalan belakangan pas insert `inventory_return_lines`) — biar gagalnya cepat & jelas, bukan nyusul jadi NULL yang baru ketauan pas constraint lain nolak.

Full body (bentuk final, setelah bugfix): `supabase/migrations/0022_fix_ar_credit_note_lot_source_ref.sql` — versi awal ada di `0021_ar_credit_notes_schema.sql`.

### RLS & Grant

Pola identik AR/Inventory lain — `select` semua `authenticated`, `insert` cuma `admin`/`accountant`, **gak ada** policy `update`/`delete` (default deny + `block_edit_delete`, 3 tabel ini transaksional). Detail: migration file.

## AR Deposit (Uang Muka/DP) — migration `0024_ar_deposits_schema.sql` + `0025_seed_demo_ar_deposits.sql`

Customer bayar duluan sebelum invoice ada (misal DP pesanan custom). **Bukan** `ar_payment` — jurnalnya gak nyentuh Piutang Usaha sama sekali pas diterima (piutangnya belum ada), dicatat ke akun liability baru `Uang Muka Penjualan` (`2300`, insert di migration seed 0025, pola sama `4900 Retur & Potongan Penjualan`). Detail rationale bisnis: `docs/domain/accounts-receivable.md` bagian "Uang Muka / DP".

### `ar_deposits` — DP diterima (selalu dibuat)

Satu baris = satu kejadian terima uang muka. `journal_entry_id` nunjuk jurnal Debit Kas/Bank / Kredit Uang Muka Penjualan (`create_journal_entry`, reuse). Immutable, pola sama `ar_invoices`/`ar_payments`.

```sql
create table ar_deposits (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  deposit_date date not null,
  source_ref text not null,
  amount numeric(14,2) not null check (amount > 0),
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
```

### `ar_deposit_applications` — DP diterapkan ke invoice

Satu baris = satu kejadian "deposit X dipakai nutup invoice Y sejumlah Z". Jurnal: Debit Uang Muka Penjualan / Kredit Piutang Usaha (reklasifikasi, bukan pembayaran baru). Punya `source_ref` sendiri (bukan cuma lewat join `journal_entries`) — konsisten sama `ar_credit_notes`/`inventory_returns` yang juga nyimpen `source_ref` langsung walau punya `journal_entry_id`.

Trigger `ar_deposit_applications_guard` (before insert, 5 pengecekan berurutan):
1. Deposit belum pernah dihanguskan.
2. Gak over-apply terhadap sisa deposit — exclude application yang udah di-reverse (`not exists (select 1 from journal_entries je where je.reverses_entry_id = ada.journal_entry_id)`), biar deposit yang application-nya kena unwind lewat `cancel_ar_invoice` beneran keitung "belum dipakai" lagi.
3. Deposit & invoice harus customer yang sama — cegah salah pencet nyampur saldo antar-customer (ketauan pas review, gak ada FK yang natural nyegah ini karena `ar_deposits.customer_id` dan `ar_invoices.customer_id` independen).
4. Invoice targetnya belum dibatalkan (gak punya reversal) — pola exclude yang sama kayak dipakai `create_ar_invoice` (0020) buat outstanding calc. Tanpa ini, DP bisa diterapkan ke invoice yang udah dibatalkan, piutang nyasar minus tanpa sebab bisnis.
5. Gak over-apply terhadap nilai invoice, **digabung** sama `ar_payment_allocations` yang udah ada — bukan dicek sendiri-sendiri. Ketauan pas review: sebelum ini, `ar_payment_allocations_no_over_allocation` (0007) dan guard ini masing-masing cuma liat tabelnya sendiri, jadi 2 jalur independen ke piutang yang sama bisa over-collect gabungan (invoice 2jt bisa "abis" 500rb DP + 2jt payment = 2.5jt, gak ada yang nolak). Fix-nya dua arah — poin ini DAN `ar_payment_allocations_no_over_allocation` sama-sama diperluas jumlahin kedua tabel (lihat di bawah).

```sql
create table ar_deposit_applications (
  id uuid primary key default gen_random_uuid(),
  deposit_id uuid not null references ar_deposits(id),
  invoice_id uuid not null references ar_invoices(id),
  amount numeric(14,2) not null check (amount > 0),
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
```

### 2 fungsi existing yang ikut diperluas (`create or replace` di `0024`, bukan tabel baru)

- **`ar_payment_allocations_no_over_allocation`** (aslinya 0007) — sisi cek "over-apply ke invoice" sekarang jumlahin `ar_payment_allocations` + `ar_deposit_applications` aktif, bukan cuma `ar_payment_allocations` doang. Simetris sama poin 5 di atas.
- **`create_ar_invoice`** (aslinya 0007, di-extend 0020 buat credit hold) — outstanding calc buat credit hold sekarang ikut ngurangin `ar_deposit_applications` aktif per invoice (union sama `ar_payment_allocations` di subquery `alloc`), gak cuma payment doang. Tanpa ini, customer yang udah nitip DP tetep keitung "outstanding penuh" dan bisa kena credit hold yang gak seharusnya (overly conservative, ketauan pas review — bukan celah duit, tapi tetap salah).

### `ar_deposit_forfeitures` — DP hangus

Satu baris = satu kejadian DP hangus (order dibatalin **sebelum** invoice ada — beda dari `ar_credit_note` yang buat barang yang udah diinvoice). Jurnal: Debit Uang Muka Penjualan / Kredit `Pendapatan Lain-lain` (`4300`, akun baru — **bukan** `Pendapatan Penjualan`, karena bukan hasil jualan, biar Laba Rugi gak nyampur). Trigger `ar_deposit_forfeitures_guard` (before insert): deposit belum pernah dihanguskan DAN gak lagi punya application aktif (belum di-reverse) — 1 deposit cuma boleh 1 disposisi aktif (diterapkan ATAU hangus).

```sql
create table ar_deposit_forfeitures (
  id uuid primary key default gen_random_uuid(),
  deposit_id uuid not null references ar_deposits(id),
  forfeiture_date date not null,
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
```

Status 1 deposit (belum dipakai / diterapkan / hangus) **derived** dari 2 tabel anak di atas, bukan kolom — konsisten sama pola status invoice/status "dibatalkan" (cek reversal).

### RPC: `create_ar_deposit`, `apply_ar_deposit`, `forfeit_ar_deposit`

`security invoker`, pola sama RPC AR lain — semua reuse `create_journal_entry`, gak pernah insert manual ke `journal_entries`/`journal_lines`. `create_ar_deposit` insert `ar_deposits`. `apply_ar_deposit` insert `ar_deposit_applications` (nominal diinput eksplisit dari caller, bukan dihitung RPC — konsisten sama pola RPC AR lain). `forfeit_ar_deposit` ngambil `amount` dari `ar_deposits.amount` (deposit yang hangus selalu hangus **penuh**, gak ada forfeiture parsial), insert `ar_deposit_forfeitures`.

Full body: `supabase/migrations/0024_ar_deposits_schema.sql`.

### `cancel_ar_invoice` diperluas — auto-unwind `ar_deposit_applications`

**Keputusan desain paling penting di fitur ini.** Sebelum ini, `cancel_ar_invoice` (`0009_ar_invoice_cancellation.sql`) cuma reverse jurnal invoice-nya sendiri. Kalau invoice itu udah punya `ar_deposit_applications`, itu bakal bikin Piutang Usaha nyasar minus (jurnal application gak ikut ke-reverse) dan DP-nya nyangkut gak jelas statusnya — dianalisa lewat contoh angka konkret bareng user, lihat `docs/story/accounts-receivable.md` Skenario 9.

Fix-nya **`create or replace function`** di `0024_ar_deposits_schema.sql` (bukan edit `0009`, migration lama tetep gak disentuh) — RPC ini sekarang, setelah reverse jurnal invoice, loop semua `ar_deposit_applications` invoice itu yang masih aktif (belum di-reverse) dan ikut manggil `reverse_journal_entry` buat tiap satu. Signature (nama param, urutan, return type) identik persis versi 0009 — caller existing (`src/app/(app)/ar-invoices/[id]/view.tsx`, manggil pakai named-parameter object) gak perlu berubah.

**Kenapa auto-unwind, bukan cuma nolak** (beda dari guard `ar_payment_allocations` di RPC yang sama, yang tetep nolak keras, gak diubah): nolak doang gak nyelesain masalah duitnya — deposit yang udah "kepake" ke invoice yang ternyata salah input butuh jalan keluar, bukan jalan buntu. Guard `ar_payment_allocations` sengaja tetep beda perlakuan karena itu duit customer yang beneran udah "nyantol" ke pelunasan (nasibnya lebih kompleks, `docs/domain/accounts-receivable.md` udah nandain "keputusan bisnis terpisah, belum di-scope") — sementara DP-application gampang di-unwind bersih karena cuma 1 jurnal reklasifikasi sederhana.

### RLS & Grant

Pola identik AR lain — `select` semua `authenticated`, `insert` cuma `admin`/`accountant`, **gak ada** policy `update`/`delete` (default deny + `block_edit_delete`). Detail: migration file.

## Warranty Replacement (Penggantian Barang Gratis Pasca-Retur) — migration `0026_ar_warranty_replacements.sql`

Customer retur barang rusak (AR Credit Note jalur full, sudah ada `inventory_returns`) DAN minta barang pengganti gratis — TANPA invoice/piutang baru. Detail rationale bisnis: `docs/domain/accounts-receivable.md` bagian "Penggantian Barang Gratis Pasca-Retur".

### `warranty_replacements` + `warranty_replacement_lines`

Satu baris header = satu kejadian penggantian (bisa lebih dari 1 kali per credit note, retur bertahap). `journal_entry_id` nunjuk jurnal Debit HPP / Kredit Persediaan Barang Jadi (`create_journal_entry`, reuse) — **gak ada** jurnal ke Piutang/Pendapatan. Immutable, pola sama `ar_credit_notes`/`inventory_returns`.

```sql
create table warranty_replacements (
  id uuid primary key default gen_random_uuid(),
  credit_note_id uuid not null references ar_credit_notes(id),
  replacement_date date not null,
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table warranty_replacement_lines (
  id uuid primary key default gen_random_uuid(),
  warranty_replacement_id uuid not null references warranty_replacements(id) on delete cascade,
  item_id uuid not null references items(id),
  qty_replaced numeric(14,3) not null check (qty_replaced > 0),
  total_cost numeric(14,2) not null check (total_cost > 0)
);
```

### Trigger `warranty_replacement_lines_no_over_replace`

Pola sama `inventory_return_lines_guard` (no-over-return) — total `qty_replaced` (akumulasi per item per credit note) gak boleh ngelebihin `SUM(qty_returned)` item itu di `inventory_return_lines` (join lewat `inventory_returns.credit_note_id`). Kalau item itu gak ketemu sama sekali di retur credit note itu, `raise exception` duluan (bukan lolos dengan batas 0).

### RPC `create_warranty_replacement`

`security invoker`, reuse `create_journal_entry` + `consume_fifo`/`consume_weighted_average` (fungsi generik konsumsi stok dari `0012`, sama yang dipakai `create_goods_issue`/`create_production_order`) — 0 fungsi baru buat logic FIFO/Weighted Average.

- Guard "credit note jalur full" dicek eksplisit di awal RPC (`exists (select 1 from inventory_returns where credit_note_id = ...)`), bukan cuma ngandelin trigger belakangan — kalau credit note-nya financial-only, `raise exception` duluan sebelum sempat konsumsi stok.
- Guard `p_lines` kosong/null juga dicek eksplisit — tanpa ini RPC bisa "sukses" bikin jurnal 0/0 dan header tanpa baris sama sekali (ketauan pas review).
- Konsumsi stok pakai `consumption_type = 'WARRANTY_REPLACEMENT'` (value baru, `inventory_lot_consumptions.consumption_type` check constraint diperluas — pola sama 0021 extend `inventory_lots.source_type` nambah `SALES_RETURN`) — **selalu** ambil dari lot aktif (FIFO urut tanggal), bukan dari lot `SALES_RETURN` yang baru masuk dari retur (barang rusak gak dipakai ganti lagi, tapi ini gak butuh guard eksplisit karena `consume_fifo` emang jalan lot demi lot dari yang paling lama — lot `SALES_RETURN` baru cuma "menang" urutan konsumsi kalau `lot_date`-nya emang lebih lama dari lot lain, yang secara bisnis gak akan kejadian karena retur selalu terjadi setelah barang asli keluar).

Full body: `supabase/migrations/0026_ar_warranty_replacements.sql`.

### RLS & Grant

Pola identik AR/Inventory lain — `select` semua `authenticated`, `insert` cuma `admin`/`accountant`, **gak ada** policy `update`/`delete` (default deny + `block_edit_delete`).

## AR Customer Credit (Kelebihan Bayar) — migration `0027_ar_customer_credits.sql` + `0028_seed_demo_ar_customer_credits.sql`

Customer transfer lebih dari total alokasi ke invoice dalam 1 payment event. **Bukan** `ar_deposit` — piutangnya udah ada dan udah kesentuh (invoice ternutup penuh via alokasi normal), excess-nya baru "jatuh" ke liability baru `Saldo Kredit Customer` (`2400`, insert di migration seed 0028, pola sama `2300 Uang Muka Penjualan`). Detail rationale bisnis: `docs/domain/accounts-receivable.md` bagian "Kelebihan Bayar (Overpayment) jadi Saldo Kredit Customer".

**Bugfix pas apply ke remote** (ketauan pas `supabase db push`, bukan dari review statis): `create or replace function record_ar_payment(...)` di `0027` nambah parameter ke-8 (`p_customer_credit_account_id default null`) — Postgres nge-ID fungsi dari nama+tipe parameter, bukan nama doang, jadi `create or replace` gak nge-replace versi 0007 (7 param), malah nambah **overload baru**. Remote yang tetep 2 overload bikin `record_ar_payment(...)` 7 argumen ambigu (`42725 function ... is not unique`). Fix: `drop function if exists record_ar_payment(uuid, date, numeric, text, uuid, uuid, jsonb)` ditambahin di **dua** tempat — di `0027` sendiri (buat instalasi baru yang belum pernah apply versi lama) DAN di awal `0028` (buat instance yang udah kadung apply `0027` sebelum drop itu ditambahin, kayak kasus yang kejadian). Pelajaran: nambah parameter ke fungsi existing lewat `create or replace` **selalu** butuh `drop function if exists <signature lama>` eksplisit duluan, gak otomatis ke-replace kalau signature-nya beda.

### `record_ar_payment` (aslinya 0007) diperluas — `create or replace`, bukan RPC baru

Sebelum ini, baris jurnal Kredit Piutang Usaha selalu = `p_amount` penuh, gak peduli `p_allocations` totalnya kurang dari itu — over-credit Piutang Usaha kalau ada excess. Sekarang:
- `v_allocated_total` = `SUM(p_allocations.amount)`, wajib ≤ `p_amount` (`raise exception` kalau lebih — gak masuk akal alokasi lebih dari yang dibayar).
- `v_excess` = `p_amount - v_allocated_total`. Kalau `v_excess > 0`, jurnal dapet baris ke-3 (Kredit `p_customer_credit_account_id`, wajib diisi caller kalau excess-nya ada — `raise exception` kalau NULL), dan 1 baris `ar_customer_credits` di-insert nunjuk ke payment yang sama.
- **1 payment event = 1 journal entry** (bukan 2 payment terpisah) — pola ini yang bikin traceable ke 1 bukti transfer bank (Core Invariant), dibahas bareng user pas teaching cycle.
- Parameter baru `p_customer_credit_account_id` ditaro **paling akhir dengan default `null`** — signature call existing (0008, 0025 seed) yang gak isi param ini tetep jalan tanpa perubahan.

### `ar_customer_credits` — saldo kredit lahir

Satu baris = satu kejadian excess dari 1 payment. `payment_id` nunjuk `ar_payments` sumbernya, `journal_entry_id` nunjuk entry **yang sama** dengan payment-nya (bukan entry baru terpisah — beda dari `ar_deposits` yang punya entry sendiri karena kejadiannya independen).

```sql
create table ar_customer_credits (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  payment_id uuid not null references ar_payments(id),
  amount numeric(14,2) not null check (amount > 0),
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
```

### `ar_customer_credit_applications` + `ar_customer_credit_refunds` — 2 disposisi, partial-capable & berulang

Beda dari `ar_deposit` (1 disposisi aktif doang, ditegakkan trigger): saldo kredit ini kayak "dompet" — bisa dipakai/direfund **sebagian-sebagian, berkali-kali**, gak ada guard "cuma 1 disposisi". Fungsi `ar_customer_credit_remaining(credit_id)` (SQL function, bukan view) ngitung sisa saldo: `amount - SUM(applications) - SUM(refunds)`, dipanggil kedua trigger guard di bawah dan bisa dipanggil langsung dari query read-side (misal nampilin "sisa saldo kredit" di UI).

```sql
create table ar_customer_credit_applications (
  id uuid primary key default gen_random_uuid(),
  credit_id uuid not null references ar_customer_credits(id),
  invoice_id uuid not null references ar_invoices(id),
  amount numeric(14,2) not null check (amount > 0),
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table ar_customer_credit_refunds (
  id uuid primary key default gen_random_uuid(),
  credit_id uuid not null references ar_customer_credits(id),
  amount numeric(14,2) not null check (amount > 0),
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
```

Trigger `ar_customer_credit_applications_guard` (before insert, 3 pengecekan): (1) `new.amount ≤ ar_customer_credit_remaining(credit_id)`; (2) credit & invoice customer harus sama (pola sama guard DP, gak ada FK natural yang nyegah ini); (3) digabung sama `ar_payment_allocations` + `ar_deposit_applications` yang udah ada buat cek over-collect ke invoice yang sama (3 jalur independen sekarang, semua harus keitung bareng).

Trigger `ar_customer_credit_refunds_guard` (before insert, 1 pengecekan): `new.amount ≤ ar_customer_credit_remaining(credit_id)` doang — refund gak nyentuh invoice, gak butuh cek sisi itu.

### RPC: `apply_ar_customer_credit`, `refund_ar_customer_credit`

`security invoker`, pola sama RPC AR lain — reuse `create_journal_entry`, gak insert manual ke `journal_entries`/`journal_lines`. `apply_ar_customer_credit` insert `ar_customer_credit_applications` (Debit Saldo Kredit Customer / Kredit Piutang Usaha). `refund_ar_customer_credit` insert `ar_customer_credit_refunds` (Debit Saldo Kredit Customer / Kredit Kas/Bank). Nominal keduanya input eksplisit dari caller (bukan dihitung RPC), konsisten sama pola RPC AR lain.

Full body: `supabase/migrations/0027_ar_customer_credits.sql`.

### 4 fungsi existing yang ikut diperluas (`create or replace` di `0027`, bukan tabel baru)

Sekarang ada 3 jalur independen yang sama-sama bisa ngurangin outstanding 1 invoice — `ar_payment_allocations`, `ar_deposit_applications`, `ar_customer_credit_applications` — jadi 3 fungsi guard-nya semua di-extend biar konsisten jumlahin ketiganya, SEMUA exclude application yang udah di-reverse (`not exists (... je.reverses_entry_id = ...)`):
- **`ar_payment_allocations_no_over_allocation`** (0007, di-extend 0024) — tambah `v_invoice_credited` (SUM `ar_customer_credit_applications` aktif per invoice) ke perhitungan.
- **`ar_deposit_applications_guard`** (0024) — tambah `v_already_credited_to_invoice` ke perhitungan poin 5-nya.
- **`ar_customer_credit_applications_guard`** (0027) — jumlahin ketiganya, PLUS cek invoice belum dibatalkan (poin yang kelewat di draft awal, ketauan `schema-reviewer` — lihat di bawah).

**`cancel_ar_invoice`** (0009, di-extend 0024 buat DP) ikut di-extend lagi di `0027`: setelah reverse jurnal invoice + jurnal `ar_deposit_applications` aktif (perilaku 0024, gak berubah), sekarang loop juga semua `ar_customer_credit_applications` aktif buat invoice itu dan ikut `reverse_journal_entry`-in. **Kenapa perlu, ketauan lewat `schema-reviewer` bukan dari awal**: draft pertama `0027` cuma nambah `ar_customer_credit_applications` ke perhitungan no-over-allocation, tapi lupa extend `cancel_ar_invoice` — akibatnya invoice yang udah dipotong saldo kredit terus dibatalkan bikin jurnal invoice ke-reverse tapi jurnal application-nya kagak, Piutang Usaha nyasar minus dan saldo kreditnya abis kepakai permanen tanpa invoice yang beneran nutup (kelas bug sama persis yang komentar 0024 udah jelasin buat DP, luput karena gak eksplisit diperiksa waktu nulis). `ar_customer_credit_remaining()` (dipanggil 2 trigger guard di atas) exclude application yang udah di-reverse dari perhitungan sisa saldo — konsisten sama fix ini, biar saldo yang application-nya di-unwind balik "belum dipakai" lagi (mirror behavior `ar_deposit`, bukan "hangus kepakai" permanen).

**`create_ar_invoice`** (0007, di-extend 0020 buat credit hold, 0024 buat DP) di-extend lagi: outstanding calc buat credit hold sekarang ikut ngurangin `ar_customer_credit_applications` aktif juga (union ke-3 di subquery `alloc`, sama pola `ar_deposit_applications`). Ini juga ketauan lewat `schema-reviewer` (re-review, bukan review pertama) — draft sebelumnya sengaja skip fungsi ini dengan alasan "saldo kredit bukan piutang yang belum ditagih", tapi itu salah: kalau saldo kredit udah dipakai motong invoice X, outstanding invoice X beneran berkurang, jadi credit hold yang ngitung outstanding tanpa itu jadi overly conservative (bukan celah duit, tapi tetap salah — kelas bug sama persis yang 0024 jelasin buat DP).

### RLS & Grant

Pola identik AR lain — `select` semua `authenticated`, `insert` cuma `admin`/`accountant`, **gak ada** policy `update`/`delete` (default deny + `block_edit_delete`). Detail: migration file.

## AR Bad Debt Write-off (Piutang Tak Tertagih) — migration `0029_ar_bad_debt_writeoffs.sql` + `0030_seed_demo_ar_bad_debt_writeoffs.sql`

Piutang yang beneran gak akan pernah tertagih (customer menghilang/tutup usaha), dihapusbukukan lewat metode **direct write-off** (bukan allowance/provisi — gak ada data historis buat estimasi kredibel, gak diakui fiskus buat badan usaha umum di Indonesia, gak konsisten sama pola RPC AR lain yang reaktif per-kejadian). Detail rationale bisnis: `docs/domain/accounts-receivable.md` bagian "Piutang Tak Tertagih (Bad Debt Write-off)".

### `ar_bad_debt_writeoffs` — write-off, selalu terhadap 1 invoice

Satu baris = satu kejadian write-off. `journal_entry_id` nunjuk jurnal Debit `Beban Piutang Tak Tertagih` (`5700`, expense biasa — **bukan** kontra, beda dari `Retur & Potongan Penjualan`/`Akumulasi Penyusutan`) / Kredit Piutang Usaha (`create_journal_entry`, reuse). Immutable, pola sama `ar_credit_notes`.

```sql
create table ar_bad_debt_writeoffs (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references ar_invoices(id),
  writeoff_date date not null,
  source_ref text not null,
  amount numeric(14,2) not null check (amount > 0),
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
```

### Trigger `ar_bad_debt_writeoffs_no_over_writeoff`

Beda dari `ar_credit_notes_no_over_return` (sengaja independen, boleh bikin outstanding negatif) — write-off gak boleh ngelebihin **sisa outstanding riil** invoice: `amount` dikurangi SEMUA reducer lain yang udah ada (`ar_payment_allocations`, `ar_credit_notes`, `ar_deposit_applications` aktif, `ar_customer_credit_applications` aktif, write-off lain yang udah ada) — gak masuk akal "menghapus" uang yang udah lunas/diretur/dikreditkan duluan lewat jalur lain. Juga nolak kalau invoice-nya udah dibatalkan (exists reversal), pola sama `ar_deposit_applications_guard`/`ar_customer_credit_applications_guard`.

### RPC `write_off_ar_invoice`

`security invoker`, reuse `create_journal_entry`. 1 kejadian = 1 jurnal, gak ada tahap estimasi/cadangan terpisah. Nominal (`p_amount`) input eksplisit dari caller, konsisten pola RPC AR lain.

Full body: `supabase/migrations/0029_ar_bad_debt_writeoffs.sql`.

### 5 fungsi existing yang ikut diperluas (`create or replace` di `0029`, bukan tabel baru)

Sekarang ada **5 reducer independen** terhadap outstanding 1 invoice — `ar_payment_allocations`, `ar_credit_notes`, `ar_deposit_applications`, `ar_customer_credit_applications`, `ar_bad_debt_writeoffs` — jadi guard yang udah ada semua di-extend biar konsisten jumlahin write-off juga (exclude yang udah di-reverse, pola sama 3 perluasan sebelumnya):
- **`ar_payment_allocations_no_over_allocation`** (0007, di-extend 0024/0027) — tambah `v_invoice_written_off` ke perhitungan.
- **`ar_deposit_applications_guard`** (0024, di-extend 0027) — tambah `v_already_written_off_to_invoice`.
- **`ar_customer_credit_applications_guard`** (0027) — tambah `v_already_written_off`.
- **`create_ar_invoice`** (0007, di-extend 0020/0024/0027) — outstanding calc buat credit hold ikut ngurangin `ar_bad_debt_writeoffs` aktif (union ke-4 di subquery `combined`) — piutang yang udah dihapusbukukan gak boleh masih keitung exposure customer itu.

**`cancel_ar_invoice`** (0009, di-extend 0024/0027) ikut di-extend lagi: guard baru di awal fungsi, nolak keras kalau invoice udah punya `ar_bad_debt_writeoffs` — beda dari `ar_deposit_applications`/`ar_customer_credit_applications` (auto-unwind), write-off itu keputusan bisnis yang udah dijurnal sebagai kerugian nyata, sama kelasnya kayak guard `ar_payment_allocations` (ditolak keras, bukan di-unwind).

Direview `schema-reviewer` sebelum apply — gak ada temuan blocker/warning, termasuk dicek eksplisit soal function-overload hazard (nama fungsi yang di-`create or replace` semua signature-nya identik ke versi sebelumnya, gak butuh `drop function if exists`).

### RLS & Grant

Pola identik AR lain — `select` semua `authenticated`, `insert` cuma `admin`/`accountant`, **gak ada** policy `update`/`delete` (default deny + `block_edit_delete`). Detail: migration file.

## Belum termasuk (dependency / di luar scope fase ini)

- **Retur yang bikin outstanding invoice negatif** (lihat "AR Credit Note" di atas) — beda mekanisme dari overpayment payment (yang di atas udah di-scope): retur ngurangin `ar_invoices.amount` via kontra-revenue, bukan lewat kelebihan kas payment. Penanganan saldo kreditnya masih belum didesain.
- **Aging report / dashboard piutang jatuh tempo** — query read-side (`due_date` vs `now()`, join alokasi buat status), digarap pas UI dibangun, gak butuh kolom/tabel tambahan.
- **Recovery piutang yang udah di-write-off** (lihat "AR Bad Debt Write-off" di atas) — direct write-off gak punya akun cadangan penyangga, penanganannya kalau ternyata kebayar lagi belum didesain.
