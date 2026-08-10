# Accounts Receivable — Schema (Finalized)

Fase 3 roadmap. Ref konsep bisnis: `docs/domain/accounts-receivable.md` + `memory/domain/accounts-receivable.md`. Ref seed/skenario: `docs/story/accounts-receivable.md`. Ref schema yang di-reuse: `memory/architecture/data/journal-entry-schema.md` (RPC `create_journal_entry`, fungsi `set_updated_at()` & `block_edit_delete()`).

Struktur module → submodule di file ini SAMA urutannya dengan `docs/architecture/ar-schema.md` dan `memory/domain/accounts-receivable.md` (lihat `AGENTS.md` > "Format Baku: Struktur Module → Submodule"). Submodule yang lahir sebagai konsekuensi langsung dari submodule lain (AR Return Credit dari Retur Barang, Cicil Dibalikin & sentralisasi `ar_invoice_remaining` dari Konsep Inti) digabung ke submodule induknya, bukan section historis terpisah kayak sebelumnya.

## Konsep Inti

### Keputusan

- **Gak ada tabel/tahap "draft"** — invoice & payment final begitu dibuat & lolos validasi, sama prinsip kayak Journal Entry (`tech-stack-decisions.md`).
- **AR gak bikin jalur pencatatan GL baru** — RPC AR (`create_ar_invoice`, `record_ar_payment`) manggil RPC `create_journal_entry` yang udah ada, bukan insert manual ke `journal_entries`/`journal_lines`. Ini mastiin AR gak pernah "kelewat" nyatet ke GL atau nyatet dengan cara beda.
- **Immutability sama persis pola Journal Entry** — RLS gak ada policy `UPDATE`/`DELETE` (default deny) + trigger `block_edit_delete` (di-reuse dari `journal-entry-schema.md`, gak bikin fungsi baru) sebagai jaring kedua.
- **`due_date` snapshot, bukan generated column** — dihitung sekali di RPC `create_ar_invoice` dari `customers.payment_term_days` **pas invoice dibuat**, disimpan sebagai kolom biasa. Beda dari `accounts.normal_balance` yang generated dan dihitung ulang tiap baca — di sini sengaja snapshot biar perubahan termin customer nanti gak retroaktif ngubah invoice lama (lihat `accounts-receivable.md` domain doc).
- **Status invoice (lunas/belum/dibatalkan) gak disimpan** — derived query dari ada-tidaknya baris `ar_payments` (unique per invoice) dibanding `ar_invoices.amount`, DITAMBAH cek apakah `journal_entry_id`-nya punya reversal (`exists (select 1 from journal_entries where reverses_entry_id = ar_invoices.journal_entry_id)`) buat status "dibatalkan". Konsisten sama keputusan "no `is_active`" di `coa-schema.md`.
- **Pembatalan invoice cuma boleh kalau belum ada payment** — RPC `cancel_ar_invoice` nolak keras (`raise exception`) kalau `ar_payments` invoice itu udah punya baris. Ref alasan bisnis: `docs/domain/accounts-receivable.md` constraint #5.
- **Payment exact-match ditegakkan RPC**, bukan cuma app-level — `record_ar_payment` `raise exception` kalau amount gak persis sama sisa outstanding invoice (migration `0040`, regresi disengaja dari desain alokasi many-to-many yang sempat ada; dikoreksi lagi khusus sisi cicil oleh `0010`, lihat "AR Payment — Cicil Dibalikin" di bawah).
- **`customers` satu-satunya tabel AR yang mutable** — master data, `payment_term_days`/`name`/`contact` boleh di-`UPDATE` kapan pun (gak ada published-lock kayak `accounts`, karena gak ada resiko retroaktif — lihat domain doc).
- Money pakai `numeric(14,2)`, bukan float (invariant `AGENT.md`).

### DDL

#### `customers` — master data pihak yang berutang

Tiap baris = 1 customer (warung langganan). Yang perlu diperhatiin:
- `payment_term_days` — default termin (hari) dipakai buat ngitung `due_date` invoice baru. Bukan kolom terkunci — boleh diubah kapan pun, cuma ngaruh ke invoice baru ke depan (`due_date` invoice lama udah ke-snapshot, gak ikut berubah).
- `credit_limit` — nullable, batas nominal total piutang open (belum lunas) yang boleh nyangkut bersamaan buat customer ini. `NULL` = gak ada batas (unlimited), dipilih biar customer existing gak otomatis kena hold begitu migration ini di-apply. Dicek di `create_ar_invoice` (lihat submodule "Credit Hold" di bawah), bukan constraint DB — perlu bandingin sama data dari tabel lain (`ar_invoices`/`ar_payments`), gak bisa jadi `CHECK` di level kolom.
- `overdue_threshold_days` — nullable, toleransi hari keterlambatan sebelum kena hold. `NULL` = gak ada batas waktu buat customer ini. UI prefill nilainya = `payment_term_days` pas customer baru dibuat (keputusan produk, bukan default DB), tapi keduanya kolom independen — bisa diubah manual per customer sesuai profil risiko (lihat submodule "Credit Hold").
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

`credit_limit`/`overdue_threshold_days` ditambah belakangan lewat `0020_ar_credit_hold.sql` (`alter table`) — ditulis di sini langsung di `create table` biar schema doc selalu nunjukin bentuk final tabel, bukan riwayat migration per migration (lihat migration file buat riwayat perubahannya). Sempat ada `return_window_days` (ditambah `0033`), dicabut total lewat `0039_ar_remove_return_window.sql` — lihat submodule "Retur Barang" bagian batas waktu retur.

`set_updated_at()` udah ada dari `coa-schema.md`, gak perlu bikin ulang.

#### `ar_invoices` — piutang timbul

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

#### `ar_payments` — piutang berkurang

Satu baris = satu kejadian bayar nyata dari customer (bukan jadwal), **selalu nutup 1 invoice spesifik** (gak ada gabung ke invoice lain) — tapi sejak `0010_ar_allow_partial_payment.sql` boleh **cicil** (kurang dari sisa outstanding), 1 invoice bisa punya banyak baris payment dari waktu ke waktu. Riwayat: `0040_ar_payment_strict_invoice_match.sql` (pra-squash) sempat mewajibkan EXACT match (gak boleh cicil ATAUpun overpay) — ternyata itu kelewat ketat, larangan yang dimaksud aslinya cuma soal overpay yang jadi saldo ngambang (`ar_customer_credits`, TETAP dicabut, gak dibalikin), bukan cicil. `0010` melonggarkan itu — lihat "AR Payment — Cicil Dibalikin" di bawah buat detail lengkap. Yang perlu diperhatiin:
- `invoice_id` — **bukan unique lagi** sejak `0010` — langsung nunjuk ke 1 invoice (bukan lewat tabel jembatan), tapi 1 invoice boleh punya banyak baris payment.
- `amount` — gak boleh **melebihi** `ar_invoice_remaining(invoice_id)` pas `record_ar_payment` dipanggil (boleh kurang = cicil, gak boleh lebih = overpay tetap ditolak), ditegakkan RPC (`raise exception`), bukan constraint DB.
- `journal_entry_id` — wajib, pola sama `ar_invoices`.
- **Gak ada `updated_at`/`archived_at`** — sama alasan `ar_invoices`.

```sql
create table ar_payments (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  invoice_id uuid not null references ar_invoices(id),
  payment_date date not null,
  amount numeric(14,2) not null check (amount > 0),
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index ar_payments_customer_id_idx on ar_payments(customer_id);
create index ar_payments_invoice_id_idx on ar_payments(invoice_id);
```

`invoice_id` ditambah belakangan lewat `0040` (`alter table`, backfill dari `ar_payment_allocations` yang lama sebelum tabel itu di-drop) — ditulis di sini langsung di `create table` biar schema doc selalu nunjukin bentuk final tabel. Constraint `unique (invoice_id)` yang sempat ditambah `0040` **dicabut lagi `0010`**.

### Trigger — Immutability, reuse `block_edit_delete()` dari Journal Entry

Fungsi ini udah ada di `journal-entry-schema.md`, tinggal dipasang ke 2 tabel AR yang gak boleh diedit/dihapus.

```sql
create trigger ar_invoices_block_edit_delete
  before update or delete on ar_invoices
  for each row execute function block_edit_delete();

create trigger ar_payments_block_edit_delete
  before update or delete on ar_payments
  for each row execute function block_edit_delete();
```

### RPC (financial write — atomik, reuse `create_journal_entry`)

Dua-duanya `security invoker`, pola sama `journal-entry-schema.md`. Kunci desainnya: **gak insert manual ke `journal_entries`/`journal_lines`** — manggil RPC `create_journal_entry` yang udah ada, biar validasi (leaf-only, balance-check) dan atomicity-nya otomatis kewarisin, gak perlu ditulis ulang.

#### `create_ar_invoice` — bikin invoice + journal entry-nya sekaligus (terakhir didefinisi `0025`)

**Credit Hold** (`0020_ar_credit_hold.sql`, dasarnya dipertahankan tiap revisi, detail rationale bisnis & guard lengkap di submodule "Credit Hold" di bawah) — sebelum bikin apa pun, RPC ini cek 2 kondisi independen (OR, salah satu kepenuhi udah cukup nolak) terhadap `customers.credit_limit`/`overdue_threshold_days`, pakai outstanding dari `ar_invoice_remaining(invoice_id)` (fungsi terpusat, lihat bawah). Kalau salah satu kepenuhi, RPC `raise exception` sebelum sempat manggil `create_journal_entry` — invoice gak jadi dibuat, gak ada jejak apa pun di GL (gagal bersih, bukan partial write). Kredit Hold dicek terhadap **`v_total_amount`** (SUM baris kredit + PPN kalau `p_apply_tax`), bukan lagi `p_amount` mentah — lihat submodule "Compounding & PPN" di bawah.

```sql
create or replace function create_ar_invoice(
  p_customer_id uuid,
  p_invoice_date date,
  p_description text,
  p_source_ref text,
  p_credit_lines jsonb, -- array of {"account_id":uuid,"amount":numeric} -- kategori pendapatan, BUKAN termasuk PPN
  p_receivable_account_id uuid,
  p_apply_tax boolean default false
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
  v_line jsonb;
  v_line_amount numeric;
  v_subtotal numeric := 0;
  v_tax_amount numeric := 0;
  v_total_amount numeric;
  v_tax_active boolean;
  v_tax_rate numeric;
  v_tax_account_id uuid;
  v_journal_lines jsonb;
begin
  -- jumlahin p_credit_lines -> v_subtotal, tambah PPN kalau p_apply_tax (lihat
  -- submodule "Compounding & PPN"), v_total_amount = v_subtotal + v_tax_amount
  select payment_term_days, credit_limit, overdue_threshold_days
    into v_term_days, v_credit_limit, v_overdue_threshold_days
    from customers where id = p_customer_id;
  v_due_date := p_invoice_date + v_term_days;

  select coalesce(sum(greatest(r.remaining, 0)), 0),
         coalesce(max(p_invoice_date - ai.due_date), 0)
    into v_outstanding, v_max_overdue_days
    from ar_invoices ai
    cross join lateral (select ar_invoice_remaining(ai.id) as remaining) r
    where ai.customer_id = p_customer_id
      and not exists (
        select 1 from journal_entries je where je.reverses_entry_id = ai.journal_entry_id
      )
      and r.remaining > 0;

  if v_credit_limit is not null and (v_outstanding + v_total_amount) > v_credit_limit then
    raise exception 'Customer kena credit hold: piutang outstanding % + invoice baru % ngelewatin credit_limit %',
      v_outstanding, v_total_amount, v_credit_limit;
  end if;

  if v_overdue_threshold_days is not null and v_max_overdue_days > v_overdue_threshold_days then
    raise exception 'Customer kena credit hold: ada piutang telat % hari (toleransi % hari)',
      v_max_overdue_days, v_overdue_threshold_days;
  end if;

  v_journal_lines := jsonb_build_array(
    jsonb_build_object('account_id', p_receivable_account_id, 'debit', v_total_amount, 'credit', 0)
  );
  -- + 1 baris kredit per elemen p_credit_lines, + 1 baris PPN kalau p_apply_tax

  v_entry_id := create_journal_entry(p_invoice_date, p_description, p_source_ref, v_journal_lines);

  insert into ar_invoices (customer_id, invoice_date, due_date, description, source_ref, amount, journal_entry_id, created_by)
  values (p_customer_id, p_invoice_date, v_due_date, p_description, p_source_ref, v_total_amount, v_entry_id, auth.uid())
  returning id into v_invoice_id;

  -- insert 1 baris ar_invoice_credit_lines per elemen p_credit_lines (is_tax=false)
  -- + 1 baris is_tax=true kalau p_apply_tax -- lihat submodule "Compounding & PPN"

  return v_invoice_id;
end;
$$;
```

Full body (loop lengkap `p_credit_lines`/PPN/insert `ar_invoice_credit_lines`): `supabase/migrations/0005_ar_schema.sql` (migration history 0001-0025 disquash jadi 9 file per modul 2026-08-10 — riwayat evolusi lengkap tetap ada di git log).

### Compounding & PPN — migration `0025_compound_transactional_entries_schema.sql`

Menutup `memory/scope-debt/compound-transactional-entries.md` (sudah dihapus, lihat "Aturan siklus hidup dokumen" `memory/brief.md`) — `create_ar_invoice` sebelumnya cuma nerima **1 akun kredit tetap** (`p_revenue_account_id`) + `p_amount` mentah. Sekarang nerima `p_credit_lines jsonb` (array `{account_id, amount}`) — bisa dipecah beberapa kategori pendapatan (mis. Pendapatan Roti + Pendapatan Jasa Antar) dalam **1 invoice yang sama**. Sisi debit (Piutang Usaha, `p_receivable_account_id`) TETAP 1 baris, gak berubah — cuma sisi kredit yang jadi array.

- **`ar_invoice_credit_lines`** — tabel baru, 1 baris per elemen `p_credit_lines` + 1 baris tambahan kalau `p_apply_tax` (`is_tax=true`). Immutable (`block_edit_delete`), FK `ar_invoice_id` ke `ar_invoices` (index `ar_invoice_credit_lines_ar_invoice_id_idx`). Ini yang bikin PPN & kategori tambahan **traceable ke 1 invoice**, gak lagi jurnal manual lepas kayak sebelumnya (lihat catatan PPN di bawah).
- **`ar_invoice_charge_types`** — katalog master data (bukan tabel transaksional): `id`, `name`, `account_id` (FK `accounts`), `archived_at` (soft-delete, `state-naming-convention.md`). Murni buat UI (dropdown "pilih kategori" di form AR Invoice) — **gak ada FK dari sini ke `ar_invoice_credit_lines`**, sama kayak `item_units` yang juga cuma resolve pilihan di UI sebelum manggil RPC (trust boundary gak berubah: RPC tetap cuma terima `account_id` mentah, sama kayak `p_receivable_account_id` yang udah lama gitu). Cuma admin yang bisa insert/update (RLS `ar_invoice_charge_types_insert`/`_update`).
- **PPN (`p_apply_tax boolean default false`)** — beda perlakuan dari kategori bebas: PPN **dihitung server-side**, gak pernah dari input klien (`is_tax` di `ar_invoice_credit_lines` gak pernah diisi dari JSON klien, cuma RPC yang set `true` pas insert baris PPN-nya sendiri). Kalau `p_apply_tax=true`, RPC baca `tax_settings` (singleton, lihat bawah) — `raise exception` kalau `is_active=false` atau akun PPN Keluaran belum diset. `v_tax_amount := round(v_subtotal * v_tax_rate / 100, 2)`. Alasan gak dipercaya dari klien: sebelumnya (interim, migration `0022`) PPN dicatat manual lewat `create_journal_entry` di luar `create_ar_invoice` — gak traceable ke invoice manapun (lihat `memory/scope-debt/tax-handling.md`, sudah dihapus, riwayat resolusinya diringkas di sini).
- **`tax_settings`** — tabel singleton (`id boolean primary key default true` + `check (id)`, cuma bisa ada 1 baris selamanya). Kolom: `is_active` (apakah bisnis ini sekarang wajib pungut PPN — beda dari `archived_at` katalog, ini flag konfigurasi bukan lifecycle per-baris), `ppn_rate numeric(5,2)`, `ppn_keluaran_account_id`/`ppn_masukan_account_id` (FK `accounts`, dipetakan ke akun `2400`/`1500` yang diseed di file yang sama). Tarif PPN itu aturan pemerintah (nasional) — disimpan di DB bukan di-hardcode di kode, biar ganti tarif cukup 1 `UPDATE`, gak perlu deploy ulang. RLS: select semua authenticated, update admin doang, **gak ada insert/delete** (baris tunggalnya cuma diseed migration, constraint singleton nolak baris kedua). Dipakai bareng oleh `create_ap_bill` (PPN Masukan) dan `create_pos_sale` (PPN Keluaran) — didefinisikan sekali di sini, referensi silang dari `ap-schema.md`/`pos-schema.md`.
- **`create_goods_issue`** (`memory/architecture/data/inventory-schema.md`) manggil `create_ar_invoice` di dalamnya — ikut disesuaikan (`p_amount`+`p_revenue_account_id` jadi `p_credit_lines`, `p_apply_tax` diteruskan apa adanya) di migration yang sama, breaking change yang sudah diantisipasi sejak submodule "Sales Order" (`inventory-schema.md`).

#### `record_ar_payment` — bikin payment + journal entry sekaligus, langsung ke 1 invoice (terakhir didefinisi `0010`)

Signature 7 param, `p_invoice_id` tunggal — bukan `p_allocations` jsonb array (riwayat: `0007` versi awal 7 param beda bentuk, `0027` diperluas jadi 8 param `p_allocations`+`p_customer_credit_account_id`, `0040` balik ke 7 param + wajib exact-match, `0010` signature TETAP SAMA cuma guard-nya dilonggarkan — detail lengkap di "AR Payment — Cicil Dibalikin" di bawah). `p_amount` gak boleh **melebihi** `ar_invoice_remaining(p_invoice_id)` — boleh kurang (cicil), gak boleh lebih (overpay) — `raise exception` sebelum jurnal apa pun dibuat kalau overpay.

```sql
create or replace function record_ar_payment(
  p_customer_id uuid,
  p_payment_date date,
  p_amount numeric,
  p_source_ref text,
  p_cash_account_id uuid,
  p_receivable_account_id uuid,
  p_invoice_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_remaining numeric;
  v_entry_id uuid;
  v_payment_id uuid;
begin
  select ar_invoice_remaining(p_invoice_id) into v_remaining;

  if p_amount > v_remaining then
    raise exception 'Payment % melebihi sisa piutang invoice % (sisa %, coba bayar %) — gak boleh overpay',
      p_source_ref, p_invoice_id, v_remaining, p_amount;
  end if;

  v_entry_id := create_journal_entry(
    p_payment_date, 'Pelunasan piutang', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_cash_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_receivable_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into ar_payments (customer_id, invoice_id, payment_date, amount, source_ref, journal_entry_id, created_by)
  values (p_customer_id, p_invoice_id, p_payment_date, p_amount, p_source_ref, v_entry_id, auth.uid())
  returning id into v_payment_id;

  return v_payment_id;
end;
$$;
```

#### `cancel_ar_invoice` — batalkan invoice salah input (reversing entry, dengan guard) (terakhir didefinisi `0041`)

Manggil `reverse_journal_entry` yang udah ada (fase 2) — pakai **akun yang sama persis** dengan invoice asli, debit/kredit ketuker, gak butuh akun baru (ini koreksi "salah input", bukan kejadian bisnis baru kayak retur barang). Bedanya dari reversing entry biasa: ada validasi awal yang nolak kalau invoice udah kesentuh payment atau write-off (guard write-off ditambah submodule "Piutang Tak Tertagih"), dan auto-unwind jurnal `ar_deposit_applications` aktif (reklasifikasi sederhana, aman dibalik — beda dari payment/write-off yang hard-reject, detail lengkap di submodule "Uang Muka / DP"). Loop unwind `ar_return_credit_applications` yang sempat ada (`0031`) **dihapus di `0041`** bareng tabelnya — gak ada lagi apa pun buat di-unwind di sisi return credit (lihat submodule "Retur Barang").

```sql
create or replace function cancel_ar_invoice(
  p_invoice_id uuid,
  p_entry_date date,
  p_source_ref text
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_paid_count int;
  v_written_off_count int;
  v_original_entry_id uuid;
  v_new_entry_id uuid;
  v_application record;
begin
  select count(*) into v_paid_count
  from ar_payments where invoice_id = p_invoice_id;

  if v_paid_count > 0 then
    raise exception 'Invoice % udah punya payment — gak bisa dibatalkan lewat jalur ini', p_invoice_id;
  end if;

  select count(*) into v_written_off_count
  from ar_bad_debt_writeoffs where invoice_id = p_invoice_id;

  if v_written_off_count > 0 then
    raise exception 'Invoice % udah punya % write-off piutang tak tertagih — gak bisa dibatalkan lewat jalur ini', p_invoice_id, v_written_off_count;
  end if;

  select journal_entry_id into v_original_entry_id from ar_invoices where id = p_invoice_id;

  v_new_entry_id := reverse_journal_entry(v_original_entry_id, p_entry_date, p_source_ref);

  for v_application in
    select ada.journal_entry_id
    from ar_deposit_applications ada
    where ada.invoice_id = p_invoice_id
      and not exists (
        select 1 from journal_entries je where je.reverses_entry_id = ada.journal_entry_id
      )
  loop
    perform reverse_journal_entry(v_application.journal_entry_id, p_entry_date, p_source_ref);
  end loop;

  return v_new_entry_id;
end;
$$;
```

Gak insert/update apa pun ke `ar_invoices` — baris invoice asli tetap ada persis kayak semula (immutability tetap utuh). Status "dibatalkan" murni kebaca dari keberadaan reversal di `journal_entries`, sama pola derived kayak status lunas/belum.

### RLS Policy

**`customers_select`, `ar_invoices_select`, `ar_payments_select`** — semua yang `authenticated` boleh liat, pola sama modul lain: data AR itu referensi bareng buat kerja/lapor, gak dibatesin per role.

**`customers_insert`/`customers_update`, `ar_invoices_insert`, `ar_payments_insert`** — cuma `admin`/`accountant` (subquery ke `user_roles`, pola identik `accounts_insert`).

**Sengaja gak ada policy `UPDATE`/`DELETE` di 2 tabel AR transaksional** (`ar_invoices`, `ar_payments`) — RLS default deny + trigger `block_edit_delete` = 2 lapis immutability, sama persis `journal_entries`/`journal_lines`. `customers` beda, boleh `UPDATE` (master data, bukan transaksional) tapi tetap gak ada `DELETE` (arsip lewat `archived_at`, bukan hard-delete).

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
-- sengaja gak ada policy UPDATE/DELETE di 2 tabel AR transaksional -> RLS default deny
```

### Grant

"Automatically expose new tables" dimatikan di project settings (`coa-schema.md`) — tabel baru butuh grant eksplisit biar PostgREST gak nolak duluan sebelum RLS sempat dicek.

```sql
grant select, insert, update on customers to authenticated;
grant select, insert on ar_invoices to authenticated;
grant select, insert on ar_payments to authenticated;
```

RPC (`create_ar_invoice`, `record_ar_payment`) otomatis kepakai `authenticated` selama grant `execute` default Postgres gak dicabut — konsisten sama perlakuan `create_journal_entry`/`reverse_journal_entry` di `journal-entry-schema.md` (grant RPC eksplisit ditambahin di migration terpisah kalau ternyata perlu, ref migration `0006_journal_entry_rpc_grants.sql`).

### AR Payment — Cicil Dibalikin (migration `0010_ar_allow_partial_payment.sql`)

Diskusi bisnis (2026-08-08) mengoreksi `0040`: larangan yang dimaksud aslinya cuma soal **overpay yang jadi saldo ngambang** (mekanisme `ar_customer_credits` — customer bisa bayar berapa aja, kelebihannya "nyantol" bisa dipakai kapan aja ke invoice mana aja, itu yang dianggap "seenaknya", lihat "AR Customer Credit — dicabut" di bawah), **bukan** cicilan/pembayaran sebagian terhadap 1 invoice yang sama. `0040` kelewat ketat karena menghapus dua-duanya sekaligus (exact-match wajib, gak boleh kurang ATAU lebih).

`0010` melonggarkan tepat sebagian: `record_ar_payment` sekarang cuma nolak kalau `p_amount > ar_invoice_remaining(invoice_id)` (overpay) — kurang dari sisa (cicil) sekarang lolos. **Bukan** restore penuh ke desain pra-`0040`:
- **Tetap 1 payment = 1 invoice** — gak ada tabel jembatan `ar_payment_allocations` many-to-many lagi, jadi "bayar gabungan lintas invoice" (1 payment nutup beberapa invoice sekaligus) TETAP gak didukung. Bedanya dari `0040`: sekarang 1 invoice boleh punya **banyak baris payment** dari waktu ke waktu (`ar_payments.invoice_id` gak unique lagi), bukan 1 payment nutup banyak invoice.
- **`ar_customer_credits` TETAP dicabut** — overpay tetap hard-reject, gak ada saldo ngambang yang dibalikin.

Perubahan konkret ke `0005_ar_schema.sql` (`create or replace`, signature semua fungsi gak berubah):
- `alter table ar_payments drop constraint ar_payments_invoice_id_key;` + `create index ar_payments_invoice_id_idx on ar_payments(invoice_id);` (index eksplisit pengganti — sebelumnya numpang di unique constraint yang sekarang dihapus, ketauan `schema-reviewer` sebagai warning sebelum apply, index-nya jadi hilang kalau gak ditambah manual).
- `ar_invoice_remaining()` reducer #1: dari `select amount from ar_payments where invoice_id = ...` (asumsi 1 baris) jadi `select sum(amount) from ar_payments where invoice_id = ...` — karena disentralisasi (`0031`), semua konsumen lain (`create_ar_invoice` credit-hold, `ar_deposit_applications_guard`, `ar_bad_debt_writeoffs_no_over_writeoff`, `create_ar_credit_note`) otomatis benar tanpa disentuh.
- `record_ar_payment`: guard `!=` (exact) jadi `>` (cuma tolak overpay).

`cancel_ar_invoice` gak berubah (masih `count(*) from ar_payments where invoice_id = ...` — invoice yang udah kesentuh payment SEBAGIAN pun tetap gak bisa dibatalkan lewat jalur ini, konsisten sama guard yang udah ada).

Sisi UI: `/ar-payments` (form create) dan `/ar-invoices/[id]` (tabel "Pembayaran", sebelumnya `.maybeSingle()` diasumsikan maks 1 baris) diperbarui bareng — bukan cuma migration DB, per aturan "schema -> API -> UI" gak boleh timpang jalan sendiri-sendiri (lihat pelajaran dari migration `0009` AP yang awalnya kelewat langkah ini).

### `ar_invoice_remaining(invoice_id)` — Sentralisasi "Sisa Outstanding Riil" (migration `0031_ar_return_credits_and_remaining_refactor.sql`)

Sebelum migration ini, 5 fungsi beda (`ar_payment_allocations_no_over_allocation`, `ar_deposit_applications_guard`, `ar_customer_credit_applications_guard`, `ar_bad_debt_writeoffs_no_over_writeoff`, `create_ar_invoice`) masing-masing **menghitung ulang sendiri** jumlah reducer invoice (payment allocation + retur + DP application + customer credit application + write-off) buat nentuin "berapa sisa yang boleh dipakai". Duplikasi ini terbukti jadi sumber bug **2x** (0024 lupa extend 1 fungsi buat DP, 0027 lupa extend `cancel_ar_invoice` buat customer credit) — tiap kali reducer baru ditambah, N tempat harus diinget diperluas bareng.

**Fix**: 1 fungsi SQL `stable` — `ar_invoice_remaining(p_invoice_id uuid) returns numeric` — jadi satu-satunya sumber kebenaran, menjumlahkan SEMUA 6 reducer (5 lama + `ar_return_credit_applications` yang baru ditambah migration ini) dengan exclude-reversed filter yang konsisten (`ar_payment_allocations`/`ar_credit_notes` gak pernah punya reversal, 4 lainnya exclude `not exists (... reverses_entry_id ...)`). Ke-5 fungsi existing di atas di-`create or replace` buat manggil ini alih-alih ngitung ulang — badan fungsinya jauh lebih pendek sekarang (`create_ar_invoice` khususnya: query union 4-cabang lama diganti `cross join lateral (select ar_invoice_remaining(ai.id) as remaining) r`).

**Reducer baru ke depan** cuma perlu ubah 1 tempat (`ar_invoice_remaining`), otomatis kepakai semua guard yang manggilnya — gak perlu nyisir N fungsi satu-satu lagi. Terbukti 2x: migration `0040_ar_payment_strict_invoice_match.sql` — reducer #1 (`ar_payment_allocations`) diganti jadi cek langsung `ar_payments.invoice_id` (unique), reducer #4 (`ar_customer_credit_applications`) dihapus total (fitur dicabut). Migration `0041_ar_return_credit_resolution.sql` — reducer #5 (`ar_return_credit_applications`) ikut dihapus total (jalur "titip ke invoice lain" dicabut, lihat submodule "Retur Barang"). **Kedua kali cuma 1 fungsi yang perlu diubah**, semua guard/RPC yang manggil `ar_invoice_remaining()` otomatis ikut kebenerin tanpa disentuh — TAPI perlu diinget eksplisit tiap kali nge-drop tabel sumber reducer, karena `create or replace function` gak otomatis ke-trigger cuma karena tabelnya ilang (ketauan pas nulis `0041`, sempat lupa sebelum keburu diperbaiki di migration yang sama). Sekarang tinggal **4 reducer**: payment (langsung, bukan SUM lagi), retur, DP application aktif, write-off aktif.

### AR Customer Credit (Kelebihan Bayar) — dicabut total (migration `0040_ar_payment_strict_invoice_match.sql`)

Sempat ada mekanisme "customer transfer lebih dari total invoice yang dilunasin, excess-nya jadi saldo kredit" — tabel `ar_customer_credits`/`ar_customer_credit_applications`/`ar_customer_credit_refunds` (migration `0027`), RPC `apply_ar_customer_credit`/`refund_ar_customer_credit`, akun liability `Saldo Kredit Customer` (`2400`). Semuanya dicabut total (tabel di-drop, RPC di-drop) begitu keputusan bisnis "payment gak boleh overpay" jalan — gak ada lagi jalur buat kelebihan bayar "nyantol", `record_ar_payment` `raise exception` kalau amount ngelebihin sisa. Rationale: `docs/domain/accounts-receivable.md` bagian "Kenapa cicil boleh tapi overpay gak boleh". **Tetap dicabut permanen** — cicil dibalikin (`0010`, lihat di atas) tapi overpay-jadi-saldo-ngambang ini TIDAK dibalikin.

## Credit Hold

Gak ada tabel baru — kolom `customers.credit_limit`/`overdue_threshold_days` (DDL lengkap di submodule "Konsep Inti") dan logic pengecekannya nempel langsung di RPC `create_ar_invoice` (SQL lengkap juga di submodule "Konsep Inti") — bukan RPC/tabel terpisah.

**Detail cek 2 kondisi independen** (`0020_ar_credit_hold.sql`, dasarnya dipertahankan tiap revisi):
- **Nominal prospektif**: `(outstanding sekarang + amount invoice baru) > credit_limit` — sengaja prospektif (nambahin amount invoice yang mau dibuat), bukan cuma cek "udah lewat limit apa belum", karena tujuan limit itu nyegah exposure nambah lewat batas, bukan cuma ngasih tau udah lewat.
- **Waktu**: ada invoice open (belum lunas & belum dibatalkan) yang `p_invoice_date - due_date` (hari overdue-nya) > `overdue_threshold_days`.

Outstanding dihitung dari `ar_invoice_remaining(invoice_id)` (fungsi terpusat, submodule "Konsep Inti") per invoice open milik customer itu, exclude invoice yang punya reversal (`journal_entries.reverses_entry_id`). `NULL` di `credit_limit`/`overdue_threshold_days` bikin kondisi itu di-skip (gak pernah nolak dari sisi itu).

Kalau salah satu kepenuhi, `create_ar_invoice` `raise exception` sebelum sempat manggil `create_journal_entry` — invoice gak jadi dibuat, gak ada jejak apa pun di GL (gagal bersih, bukan partial write).

### RLS & Grant

Gak ada RLS/grant tambahan — hold cuma logic di dalam `create_ar_invoice`, tunduk ke RLS/grant `ar_invoices_insert` yang sudah ada (submodule "Konsep Inti").

## Retur Barang (Credit Note)

Barang yang udah diinvoice beneran dibalikin customer (rusak/gak laku/salah kirim) — beda dari `cancel_ar_invoice` (invoice salah dari awal). Detail rationale bisnis: `docs/domain/accounts-receivable.md` bagian "Retur Barang (Credit Note)". Migration: `0021_ar_credit_notes_schema.sql` + `0022_fix_ar_credit_note_lot_source_ref.sql` + `0023_seed_demo_ar_credit_notes.sql` (retur itu sendiri), `0031_ar_return_credits_and_remaining_refactor.sql` + `0032_seed_demo_ar_return_credits.sql` + `0041_ar_return_credit_resolution.sql` (saldo kredit dari retur, digabung di submodule ini karena lahir langsung dari retur), `0039_ar_remove_return_window.sql` (batas waktu retur, dicabut), `0015_ar_credit_note_damaged_condition.sql` (klasifikasi kondisi barang per baris, lihat sub-bagian di bawah).

`0022` adalah bugfix (`create or replace function`) ke RPC `create_ar_credit_note` dari `0021` — insert ke `inventory_lots.source_ref` (kolom uuid, nunjuk id baris dokumen sumber, pola sama `create_goods_receipt`/`create_production_order`; tabel `inventory_lots` sendiri sudah dihapus total di migration `0038`, lihat catatan di bawah) salah pasang `p_source_ref` (parameter text) di `0021`, ketauan pas jalur FIFO retur dieksekusi (waktu itu FIFO masih ada di sistem). Fix pakai `v_credit_note_id`. Nomor migration `0022`/`0023` sengaja ditukar dari draft awal (`0022` seed / `0023` fix) supaya fix ke-apply sebelum seed yang butuh RPC-nya udah bener.

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

Total `SUM(amount)` credit note per invoice gak boleh ngelebihin `ar_invoices.amount` — gak peduli status bayar invoice (bisa aja retur bikin outstanding jadi negatif kalau invoice-nya udah lunas — itu skenario sah, lihat domain doc).

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
  total_cost numeric(14,2) not null check (total_cost > 0),
  condition text not null default 'RESALABLE' check (condition in ('RESALABLE', 'DAMAGED'))  -- 0015
);
```

Barang yang balik masuk blend ke `inventory_balances.avg_cost` (formula sama persis weighted-average-receive di `create_goods_receipt`) — **cuma buat baris `condition = 'RESALABLE'`**. Sebelum migration `0038`, item FIFO malah masuk sebagai lot baru terpisah (`inventory_lots.source_type = 'SALES_RETURN'`) — sengaja gak dicampur ke lot fresh, supaya barang retur (berpotensi cacat) gak ketuker dipakai lagi buat penukaran garansi. Sejak FIFO dihapus, semua retur (apa pun metode costing-nya dulu) sempat masuk ke pool `inventory_balances` tunggal tanpa segregasi sama sekali. **Ditutup migration `0015`**: kolom `condition` (default `RESALABLE`, opsional di `p_lines` — backward compatible) balikin segregasinya secara logis (bukan lewat lot lagi) — baris `DAMAGED` gak pernah nyentuh `inventory_balances` sama sekali, cost-nya direklasifikasi ke akun `Beban Kerugian Barang Rusak` (`5900`, param baru `p_loss_expense_account_id`) alih-alih `Persediaan Barang Jadi`. `inventory_return_lines` tetap diisi buat SEMUA baris terlepas `condition` (audit trail retur fisik + basis `warranty_replacement`, lihat submodule "Penukaran Barang Pasca-Retur") — cuma `inventory_balances` yang beda perlakuan.

### Trigger `inventory_return_lines_guard`

`before insert on inventory_return_lines` — **cuma 1 pengecekan**: no-over-return (qty). Akumulasi `qty_returned` per item per goods_issue gak boleh ngelebihin `goods_issue_lines.qty_issued`-nya. Pola sama trigger anti-over-consumption `inventory_lot_consumptions_no_over_consumption` yang dulu ada (sudah dihapus bareng `inventory_lot_consumptions`, migration `0038`).

Sempat gabung 2 pengecekan (qty + batas waktu retur per item, `items.return_window_days`) sampai migration `0039_ar_remove_return_window.sql` nyabut bagian window-nya total — lihat bagian "Batas Waktu Retur" di bawah buat alasan bisnisnya.

Full body trigger: lihat migration file.

### RPC `create_ar_credit_note`

`security invoker`, pola sama RPC AR lain — reuse `create_journal_entry` (2x kalau jalur full, 1x kalau financial-only), gak pernah insert manual ke `journal_entries`/`journal_lines`.

- `p_lines` (nullable/kosong) menentukan jalur: kosong = financial-only (1 jurnal, invoice yang gak lewat `create_goods_issue`). Terisi = full (2 jurnal + stok balik) — RPC `raise exception` kalau invoice yang dimaksud ternyata gak punya `goods_issues`.
- Nominal jurnal kontra-revenue (`p_amount`) tetap **input eksplisit dari caller**, bukan dihitung RPC — konsisten sama `create_ar_invoice`/`record_ar_payment` yang juga gak pernah nebak nominal uang dari data lain (skema gak nyimpen harga per-unit di level invoice, cuma total).
- Nominal reversal HPP **dihitung RPC dari snapshot** (`goods_issue_lines.total_cost / qty_issued × qty_returned`), bukan input caller — beda dari nominal revenue di atas, ini sengaja dikunci server-side biar gak ada celah caller masukin cost yang gak sesuai catatan asli.
- Guard "item gak ketemu di goods_issue" dicek eksplisit di RPC (bukan cuma ngandelin trigger yang jalan belakangan pas insert `inventory_return_lines`) — biar gagalnya cepat & jelas, bukan nyusul jadi NULL yang baru ketauan pas constraint lain nolak.
- Sempat ada fail-fast check batas waktu retur per customer di awal fungsi (`ar_invoices.return_window_days`, `0033`) — dicabut migration `0039_ar_remove_return_window.sql` (lihat bagian "Batas Waktu Retur" di bawah).
- **Diperluas `0031`** — deteksi & cairkan excess retur jadi Saldo Kredit Retur Customer, lihat sub-bagian "`ar_credit_notes` diperluas — deteksi & cairkan excess" di bawah.
- **Diperluas `0015`** — tiap elemen `p_lines` sekarang boleh isi `condition` (`'RESALABLE'` default atau `'DAMAGED'`, dibaca via `coalesce(v_line->>'condition', 'RESALABLE')`). Loop per baris akumulasi ke 2 total terpisah (`v_total_cost_resalable`/`v_total_cost_damaged`) — cuma baris `RESALABLE` yang update `inventory_balances`. Jurnal HPP dibangun **dinamis** (`v_hpp_journal_lines`, mulai `'[]'::jsonb`, di-`||` kondisional) alih-alih 2 baris `jsonb_build_array` statis: debit `Persediaan Barang Jadi` cuma muncul kalau ada baris `RESALABLE`, debit param baru `p_loss_expense_account_id` cuma muncul kalau ada baris `DAMAGED`, kredit `HPP` selalu 1 baris gabungan (`v_total_cost_returned`) — tetap 1 journal entry atomik (bisa 2 atau 3 baris), bukan 2 entry terpisah. `raise exception` kalau ada baris `DAMAGED` tapi `p_loss_expense_account_id` gak diisi. `inventory_return_lines` insert nambah kolom `condition` per baris.

Full body (bentuk final): `supabase/migrations/0015_ar_credit_note_damaged_condition.sql` — riwayat sebelumnya: `0021_ar_credit_notes_schema.sql` (versi awal), `0022_fix_ar_credit_note_lot_source_ref.sql` (bugfix), `0039_ar_remove_return_window.sql` (batas waktu dicabut), `0038_remove_fifo_costing.sql` (costing disederhanakan).

### RLS & Grant (AR Credit Note)

Pola identik AR/Inventory lain — `select` semua `authenticated`, `insert` cuma `admin`/`accountant`, **gak ada** policy `update`/`delete` (default deny + `block_edit_delete`, 3 tabel ini transaksional). Detail: migration file.

### AR Return Credit (Saldo Kredit dari Retur) — migration `0031_ar_return_credits_and_remaining_refactor.sql` + `0032_seed_demo_ar_return_credits.sql`, resolusi disederhanakan `0041_ar_return_credit_resolution.sql`

Retur yang kejadian **setelah** invoice lunas bikin outstanding negatif (`ar_credit_notes_no_over_return` sengaja independen, cuma cek terhadap `amount` invoice, gak peduli status bayar). Excess-nya sekarang otomatis "dicairkan" jadi saldo resmi, dicatat ke akun liability `Saldo Kredit Retur Customer` (kode `2500`). Detail rationale bisnis: `docs/domain/accounts-receivable.md` bagian "Retur Barang (Credit Note)" > "Saldo Kredit dari Retur".

#### `ar_return_credits` — saldo kredit lahir (selalu dari `ar_credit_notes` yang bikin invoice minus)

Satu baris = satu kejadian excess dari 1 credit note. `credit_note_id` nunjuk `ar_credit_notes` sumbernya, `journal_entry_id` nunjuk entry reklasifikasi **terpisah** dari jurnal kontra-revenue credit note-nya sendiri (2 jurnal independen — pola sama retur jalur full yang juga bikin 2 jurnal).

```sql
create table ar_return_credits (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  credit_note_id uuid not null references ar_credit_notes(id),
  amount numeric(14,2) not null check (amount > 0),
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
```

#### `ar_return_credit_refunds` — 1 dari 2 disposisi (refund tunai)

**(`0041`, disederhanakan)** Sempat ada juga `ar_return_credit_applications` (2 disposisi, pola identik `ar_customer_credit_applications`/`ar_customer_credit_refunds` 0027) — dicabut total. Sekarang cuma 1 tabel disposisi: `ar_return_credit_refunds`, ditambah settlement via barang yang disimpan di `warranty_replacements.return_credit_settled_amount` (bukan tabel terpisah, lihat submodule "Penukaran Barang Pasca-Retur" — Opsi C dari 3 opsi yang dipertimbangkan, dipilih karena niru pola `discount_reversed_amount` yang udah ada di tabel yang sama).

`ar_return_credit_remaining(credit_id)` (fungsi `stable`, terakhir didefinisi `0041`) ngitung sisa: `amount - SUM(warranty_replacements.return_credit_settled_amount via credit_note_id) - SUM(refunds)`.

#### `ar_credit_notes` diperluas — deteksi & cairkan excess (bugfix `0022` jadi baseline, `0031`)

Ini keputusan desain paling penting di submodule ini. Sebelum insert baris `ar_credit_notes`, RPC `create_ar_credit_note` nangkep `v_remaining_before := ar_invoice_remaining(p_invoice_id)` (state SEBELUM retur ini masuk). Setelah insert, hitung `v_excess := greatest(0, p_amount - greatest(0, v_remaining_before))` — cuma bagian retur yang beneran "kelebihan" dari sisa yang ada (bukan seluruh nominal retur), dan kalau invoice udah negatif dari retur sebelumnya (`v_remaining_before < 0`), seluruh retur baru ini jadi excess. Kalau `v_excess > 0`, bikin jurnal reklasifikasi (`Debit Piutang Usaha / Kredit Saldo Kredit Retur Customer`) + insert `ar_return_credits`.

Parameter `p_return_credit_liability_account_id` ditaro **paling akhir dengan default `null`** (wajib diisi caller cuma kalau beneran ada excess, `raise exception` kalau NULL pas dibutuhkan) — signature call existing (0023 seed) yang gak isi param ini tetep jalan. `drop function if exists create_ar_credit_note(<signature 9-param lama>)` ditambahin duluan — pelajaran dari bug `record_ar_payment` di 0027 (nambah parameter lewat `create or replace` bikin overload baru kalau gak di-drop eksplisit signature lama). Signature ini gak berubah lagi di `0041` (settlement-nya ada di `create_warranty_replacement`, bukan di sini).

#### RPC `refund_ar_return_credit`

Jurnal Debit Saldo Kredit Retur Customer / Kredit Kas/Bank; insert `ar_return_credit_refunds`. Guard: `amount > ar_return_credit_remaining(credit_id)` → tolak. **Gak berubah** sejak awal — tetap satu-satunya cara refund tunai.

#### RPC `apply_ar_return_credit` — dicabut total (`0041`)

Dulu pola identik `apply_ar_customer_credit` (0027) — Debit Saldo Kredit Retur Customer / Kredit Piutang Usaha ke invoice lain, insert `ar_return_credit_applications`. Dihapus bareng tabelnya — gak ada lagi jalur manual "pakai saldo kredit retur ke invoice lain".

#### `cancel_ar_invoice` — loop ketiga dihapus (`0041`)

Sempat ada loop ketiga (setelah unwind `ar_deposit_applications`, sebelum `ar_customer_credit_applications` juga dihapus di `0040`) yang reverse jurnal `ar_return_credit_applications` aktif buat invoice yang dibatalin. Dihapus total bareng tabelnya — gak ada lagi apa pun buat di-unwind di sisi ini (settlement via barang & refund tunai berdiri independen dari status invoice manapun, gak pernah "diterapkan ke" invoice tertentu yang bisa dibatalkan).

#### Backfill data lama — migration `0032`

Retur Warung Kang Ade (`0023_seed_demo_ar_credit_notes.sql`, sebelum fitur ini ada) udah lebih dulu bikin invoice-nya minus tanpa lewat jalur otomatis di atas — migration seed `0032` manual insert jurnal reklasifikasi + baris `ar_return_credits` yang SEHARUSNYA otomatis kebentuk kalau fitur ini udah ada waktu itu, lalu demo `refund_ar_return_credit` buat nunjukin disposisinya. Kompatibel apa adanya sama `0041` (gak pernah insert ke `ar_return_credit_applications`, gak perlu diedit). Detail skenario: `docs/story/accounts-receivable.md` Skenario 11.

#### Catatan terbuka — belum ada cap gabungan lintas invoice/waktu

Per invoice udah ada batas alami (`ar_credit_notes_no_over_return` caps retur ≤ `amount` invoice), tapi belum ada cap akumulasi saldo kredit retur lintas invoice/waktu buat 1 customer. Gak dirancang sekarang karena belum ada bukti kebutuhan di cerita.

### RLS & Grant (AR Return Credit)

Pola identik AR lain — `select` semua `authenticated`, `insert` cuma `admin`/`accountant`, **gak ada** policy `update`/`delete` (default deny + `block_edit_delete`). Detail: migration file.

### Batas Waktu Retur — dicabut total (migration `0039_ar_remove_return_window.sql`)

Sempat ada 2 lapis (window per item `items.return_window_days` dari `0021`, window per customer `customers.return_window_days`/`ar_invoices.return_window_days` dari `0033`+seed `0034`) — keduanya dicabut total, kolom di-drop, cek di trigger `inventory_return_lines_guard` dan RPC `create_ar_credit_note` dihapus. Retur diterima/ditolak sekarang murni keputusan manual owner/staff di luar sistem. Rationale: `docs/domain/accounts-receivable.md` bagian "Retur Barang (Credit Note)", `memory/domain/accounts-receivable.md`.

## Penukaran Barang Pasca-Retur (Garansi)

Customer retur barang rusak (AR Credit Note jalur full, sudah ada `inventory_returns`) DAN minta barang pengganti — BUKAN gratis/cuma-cuma, TANPA invoice baru tapi piutang kami ke customer gak berkurang gara-gara penukaran ini (lihat pembalikan diskon di bawah). Detail rationale bisnis: `docs/domain/accounts-receivable.md` bagian "Penukaran Barang Pasca-Retur (Garansi)". Migration: `0026_ar_warranty_replacements.sql` + `0037_ar_warranty_replacement_discount_reversal.sql` + `0041_ar_return_credit_resolution.sql` (penyelesaian saldo kredit retur).

### `warranty_replacements` + `warranty_replacement_lines`

Satu baris header = satu kejadian penggantian (bisa lebih dari 1 kali per credit note, retur bertahap). `journal_entry_id` nunjuk jurnal Debit HPP / Kredit Persediaan Barang Jadi (`create_journal_entry`, reuse). `discount_reversal_journal_entry_id` (**fix `0037`**, nullable) nunjuk jurnal kedua yang membalikkan diskon retur — Debit Piutang Usaha / Kredit Retur & Potongan Penjualan, cuma dibuat kalau `discount_reversed_amount > 0`. `return_credit_settlement_journal_entry_id` (**`0041`**, nullable) nunjuk jurnal ketiga yang menyelesaikan saldo kredit retur — Debit Saldo Kredit Retur Customer / Kredit Piutang Usaha, cuma dibuat kalau `return_credit_settled_amount > 0` (lihat submodule "Retur Barang" bagian AR Return Credit). Immutable, pola sama `ar_credit_notes`/`inventory_returns`.

```sql
create table warranty_replacements (
  id uuid primary key default gen_random_uuid(),
  credit_note_id uuid not null references ar_credit_notes(id),
  replacement_date date not null,
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  discount_reversed_amount numeric(14,2) not null default 0 check (discount_reversed_amount >= 0),
  discount_reversal_journal_entry_id uuid references journal_entries(id),
  return_credit_settled_amount numeric(14,2) not null default 0 check (return_credit_settled_amount >= 0),
  return_credit_settlement_journal_entry_id uuid references journal_entries(id),
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

### Trigger `warranty_replacements_no_over_reverse` (fix `0037`)

Total `discount_reversed_amount` (akumulasi lintas semua `warranty_replacements` per `credit_note_id`) gak boleh ngelebihin `ar_credit_notes.amount` credit note itu. Pola sama no-over-replace tapi di level header, bukan line — karena reversal dihitung per pemanggilan RPC (1 angka), bukan per baris item.

### Trigger `warranty_replacements_no_over_settle_return_credit` (`0041`)

Pola sama `no_over_reverse` di atas, tapi buat kolom `return_credit_settled_amount`: kalau `new.return_credit_settled_amount = 0`, langsung lolos (`return new`, gak perlu lookup apa pun — kasus paling umum, credit note tanpa `ar_return_credits`). Kalau > 0, cari `ar_return_credits` yang `credit_note_id`-nya match — `raise exception` kalau gak ketemu (gak masuk akal isi kolom ini kalau gak ada saldo buat disettle), lalu `raise exception` juga kalau `new.return_credit_settled_amount > ar_return_credit_remaining(credit_id)` (dipanggil saat itu, sebelum row baru ini masuk — jadi "sisa SEBELUM settlement ini").

### RPC `create_warranty_replacement`

`security invoker`, reuse `create_journal_entry` + `consume_weighted_average` (fungsi generik konsumsi stok dari `0012`, sama yang dipakai `create_goods_issue`/`create_production_order`; `consume_fifo` yang dulu jadi pasangannya sudah di-drop total di migration `0038`) — 0 fungsi baru buat logic konsumsi stok.

- Guard "credit note jalur full" dicek eksplisit di awal RPC (`exists (select 1 from inventory_returns where credit_note_id = ...)`), bukan cuma ngandelin trigger belakangan — kalau credit note-nya financial-only, `raise exception` duluan sebelum sempat konsumsi stok.
- Guard `p_lines` kosong/null juga dicek eksplisit — tanpa ini RPC bisa "sukses" bikin jurnal 0/0 dan header tanpa baris sama sekali (ketauan pas review).
- Konsumsi stok ambil dari pool `inventory_balances` (Weighted Average) via `consume_weighted_average`. Sebelum migration `0038`: konsumsi pakai `consumption_type = 'WARRANTY_REPLACEMENT'` (value baru, `inventory_lot_consumptions.consumption_type` check constraint diperluas — pola sama 0021 extend `inventory_lots.source_type` nambah `SALES_RETURN`) — **selalu** ambil dari lot aktif (FIFO urut tanggal), bukan dari lot `SALES_RETURN` yang baru masuk dari retur (barang rusak gak dipakai ganti lagi). Sekarang tabel lot sudah gak ada, tapi segregasi logisnya tetap terjaga sejak `0015`: baris `inventory_return_lines.condition = 'DAMAGED'` gak pernah nambah `inventory_balances` sama sekali, jadi pool ini murni stok fresh + retur `RESALABLE` yang beneran gak cacat — gak ada resiko barang cacat ikut kepakai jadi pengganti.
- **Pembalikan diskon (fix `0037`, param `p_contra_revenue_account_id`/`p_receivable_account_id`)**: sebelum fix ini, jurnal HPP/Persediaan di atas adalah SATU-SATUNYA efek RPC — additive di atas diskon `create_ar_credit_note` yang udah jalan duluan, bikin kompensasi ganda (`memory/scope-debt/ar-warranty-replacement-kompensasi-ganda.md`, sekarang dihapus karena sudah diperbaiki). Sekarang RPC hitung `v_reversal_share_cost` = jumlah (qty diganti × unit cost asli dari `inventory_return_lines`) tiap baris, lalu `v_reversal_amount = round(ar_credit_notes.amount * v_reversal_share_cost / total_cost_retur_credit_note, 2)` — proxy proporsi nilai pakai rasio cost, karena `ar_credit_notes` cuma nyimpen 1 `amount` total, gak per baris item. Kalau `v_reversal_amount > 0`, bikin jurnal kedua (Debit Piutang Usaha / Kredit Retur & Potongan Penjualan — kebalikan `create_ar_credit_note`) lewat `create_journal_entry` lagi, disimpan ke `discount_reversed_amount`+`discount_reversal_journal_entry_id`.
- **Penyelesaian saldo kredit retur (`0041`, param baru `p_return_credit_liability_account_id` default `null`)**: cuma jalan kalau `v_reversal_amount > 0` DAN credit note-nya punya baris `ar_return_credits` (lookup by `credit_note_id`). Kalau ketemu: (1) `raise exception` **SEBELUM bikin jurnal apa pun** kalau `v_reversal_amount > ar_return_credit_remaining(id)` — lihat catatan bug di bawah; (2) `raise exception` juga kalau `p_return_credit_liability_account_id is null` (pola sama `create_ar_credit_note` buat parameter serupa); (3) baru kalau lolos dua cek itu, `v_settlement_amount := v_reversal_amount` (persis sama, gak perlu `least()` lagi karena udah divalidasi duluan), bikin jurnal ketiga (Debit Saldo Kredit Retur Customer / Kredit Piutang Usaha) lewat `create_journal_entry`, disimpan ke `return_credit_settled_amount`+`return_credit_settlement_journal_entry_id`. **Kenapa kredit Piutang Usaha (bukan Persediaan/HPP lagi)**: jurnal ini sengaja pasangan kebalikan dari pembalikan diskon di poin sebelumnya (yang men-debit Piutang Usaha) — net efek ke Piutang Usaha invoice jadi 0 (invoice tetap "lunas"), sementara liability-nya beneran berkurang. Fisik barangnya sendiri udah kejurnal di HPP/Persediaan di awal RPC, gak perlu disentuh lagi di sini.
- **Bug ketauan schema-reviewer, bukan disengaja dari awal**: draft pertama nge-`least(v_reversal_amount, ar_return_credit_remaining())` cuma di sisi settlement, sementara jurnal reversal-nya (poin sebelumnya) tetap jalan penuh gak ke-cap. Kalau sebagian saldo `ar_return_credits` udah kadung direfund tunai duluan (`refund_ar_return_credit`) sebelum penukaran barang ini, selisih antara reversal penuh dan settlement yang ke-cap jadi debit Piutang Usaha yang nambah TANPA invoice manapun yang nyerap — gak ada baris `ar_invoices` baru, gak ada `ar_invoice_remaining()` manapun yang ngitung ini, dan (gara-gara `0040`) bahkan gak bisa dilunasin lewat `record_ar_payment` biasa karena itu sekarang wajib exact-match ke 1 invoice. Fix: cek dulu `v_reversal_amount > remaining` SEBELUM bikin jurnal reversal maupun settlement, `raise exception` kalau iya — bukan lolosin dengan angka yang dipotong diam-diam.
- **Diketahui, gak diperbaiki (konsisten sama trigger guard lain di modul ini)**: `warranty_replacements_no_over_reverse`/`no_over_settle_return_credit` gak pakai `pg_advisory_xact_lock` (beda dari `close_period` di `0016`) — 2 pemanggilan konkuren ke credit note yang sama secara teori bisa race lolos guard individual. Rounding `round(...,2)` per pemanggilan independen (gak liat sisa) bisa juga bikin retur bertahap terakhir kena reject padahal proporsinya sah. Bukan blocker (bukan kompensasi ganda beneran, cuma false-rejection edge case) — sama level risiko kayak `inventory_return_lines_guard`/`warranty_replacement_lines_no_over_replace` yang juga gak pakai lock.

Full body (bentuk final): `supabase/migrations/0041_ar_return_credit_resolution.sql` — riwayat sebelumnya: `0026_ar_warranty_replacements.sql` (versi awal), `0037_ar_warranty_replacement_discount_reversal.sql` (pembalikan diskon), `0038_remove_fifo_costing.sql` (costing disederhanakan).

### RLS & Grant (Penukaran Barang)

Pola identik AR/Inventory lain — `select` semua `authenticated`, `insert` cuma `admin`/`accountant`, **gak ada** policy `update`/`delete` (default deny + `block_edit_delete`).

## Uang Muka / DP (Deposit)

Customer bayar duluan sebelum invoice ada (misal DP pesanan custom). **Bukan** `ar_payment` — jurnalnya gak nyentuh Piutang Usaha sama sekali pas diterima (piutangnya belum ada), dicatat ke akun liability baru `Uang Muka Penjualan` (`2300`, insert di migration seed 0025, pola sama `4900 Retur & Potongan Penjualan`). Detail rationale bisnis: `docs/domain/accounts-receivable.md` bagian "Uang Muka / DP (Deposit)". Migration: `0024_ar_deposits_schema.sql` + `0025_seed_demo_ar_deposits.sql` (versi awal), `0012_ar_deposit_refund_and_partial.sql` (partial-capable + refund).

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

Satu baris = satu kejadian DP hangus, **partial-capable sejak migration `0012_ar_deposit_refund_and_partial.sql`** (order dibatalin **sebelum** invoice ada — beda dari `ar_credit_note` yang buat barang yang udah diinvoice). Jurnal: Debit Uang Muka Penjualan / Kredit `Pendapatan Lain-lain` (`4300`, **bukan** `Pendapatan Penjualan`, karena bukan hasil jualan, biar Laba Rugi gak nyampur).

```sql
create table ar_deposit_forfeitures (
  id uuid primary key default gen_random_uuid(),
  deposit_id uuid not null references ar_deposits(id),
  amount numeric(14,2) not null check (amount > 0),
  forfeiture_date date not null,
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
```

`amount` ditambah `0012` (`alter table`) — sebelumnya kolom ini gak ada, nominal selalu diambil langsung dari `ar_deposits.amount` (hangus selalu penuh sekali jalan, gak ada forfeiture parsial). Ditulis di sini langsung di `create table` biar schema doc selalu nunjukin bentuk final tabel.

### `ar_deposit_refunds` — DP direfund tunai (baru, migration `0012`)

Satu baris = satu kejadian refund tunai sebagian/seluruh sisa deposit ke customer — kasus khusus (kebijakan default DP tetap non-refundable, forfeiture yang jadi jalur utama), tapi didukung buat kejadian di mana perusahaan sendiri yang memutuskan balikin uangnya. Jurnal: Debit Uang Muka Penjualan / Kredit Kas/Bank — **gak ada dampak Laba Rugi**, beda dari forfeiture yang jadi Pendapatan Lain-lain.

```sql
create table ar_deposit_refunds (
  id uuid primary key default gen_random_uuid(),
  deposit_id uuid not null references ar_deposits(id),
  amount numeric(14,2) not null check (amount > 0),
  refund_date date not null,
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
```

### `ar_deposit_remaining(deposit_id)` — sumber kebenaran tunggal sisa DP (baru, migration `0012`)

Sebelum `0012`, status 1 deposit itu boolean-based: "1 disposisi aktif" (diterapkan ATAU hangus, gak dua-duanya — dijaga 2 guard yang saling cek keberadaan lawan). Migration `0012` menghapus aturan itu — sekarang partial-capable, 1 deposit boleh dicampur kombinasi ketiga jalur (applications + refunds + forfeitures), dijaga 1 fungsi terpusat:

```sql
create function ar_deposit_remaining(p_deposit_id uuid) returns numeric as $$
  select ad.amount
    - coalesce((
        select sum(ada.amount) from ar_deposit_applications ada
        where ada.deposit_id = p_deposit_id
          and not exists (
            select 1 from journal_entries je where je.reverses_entry_id = ada.journal_entry_id
          )
      ), 0)
    - coalesce((select sum(amount) from ar_deposit_refunds where deposit_id = p_deposit_id), 0)
    - coalesce((select sum(amount) from ar_deposit_forfeitures where deposit_id = p_deposit_id), 0)
  from ar_deposits ad
  where ad.id = p_deposit_id;
$$ language sql stable;
```

`ar_deposit_applications_guard` dan `ar_deposit_forfeitures_guard` (`create or replace` di `0012`, signature trigger-function gak berubah jadi trigger existing otomatis kepakai versi baru) sekarang cuma cek `new.amount > ar_deposit_remaining(new.deposit_id)`, ganti 2 cek boolean lama. `ar_deposit_refunds_guard` (baru) pola sama persis.

Status 1 deposit (belum dipakai / sebagian / selesai) **derived** dari `ar_deposit_remaining()` vs `amount`, bukan kolom — konsisten sama pola status invoice/status "dibatalkan" (cek reversal).

### RPC: `create_ar_deposit`, `apply_ar_deposit`, `refund_ar_deposit`, `forfeit_ar_deposit`

`security invoker`, pola sama RPC AR lain — semua reuse `create_journal_entry`, gak pernah insert manual ke `journal_entries`/`journal_lines`. `create_ar_deposit` insert `ar_deposits`. `apply_ar_deposit` insert `ar_deposit_applications` (nominal diinput eksplisit dari caller). `refund_ar_deposit` (**baru `0012`**) insert `ar_deposit_refunds`. `forfeit_ar_deposit` (**signature baru `0012`**, nambah `p_amount` — sebelumnya gak nerima nominal, `drop function` dulu buat signature lama karena beda jumlah param) insert `ar_deposit_forfeitures` pakai nominal eksplisit, bukan `ar_deposits.amount` langsung lagi.

Full body (definisi terkini): `supabase/migrations/0005_ar_schema.sql`.

### `cancel_ar_invoice` diperluas — auto-unwind `ar_deposit_applications`

**Keputusan desain paling penting di submodule ini.** Sebelum ini, `cancel_ar_invoice` (`0009_ar_invoice_cancellation.sql`) cuma reverse jurnal invoice-nya sendiri. Kalau invoice itu udah punya `ar_deposit_applications`, itu bakal bikin Piutang Usaha nyasar minus (jurnal application gak ikut ke-reverse) dan DP-nya nyangkut gak jelas statusnya — dianalisa lewat contoh angka konkret bareng user, lihat `docs/story/accounts-receivable.md` Skenario 9.

Fix-nya **`create or replace function`** di `0024_ar_deposits_schema.sql` (bukan edit `0009`, migration lama tetep gak disentuh, SQL lengkap ada di submodule "Konsep Inti") — RPC ini sekarang, setelah reverse jurnal invoice, loop semua `ar_deposit_applications` invoice itu yang masih aktif (belum di-reverse) dan ikut manggil `reverse_journal_entry` buat tiap satu. Signature (nama param, urutan, return type) identik persis versi 0009 — caller existing (`src/app/(app)/ar-invoices/[id]/view.tsx`, manggil pakai named-parameter object) gak perlu berubah.

**Kenapa auto-unwind, bukan cuma nolak** (beda dari guard `ar_payment_allocations` di RPC yang sama, yang tetep nolak keras, gak diubah): nolak doang gak nyelesain masalah duitnya — deposit yang udah "kepake" ke invoice yang ternyata salah input butuh jalan keluar, bukan jalan buntu. Guard `ar_payment_allocations` sengaja tetep beda perlakuan karena itu duit customer yang beneran udah "nyantol" ke pelunasan (nasibnya lebih kompleks, `docs/domain/accounts-receivable.md` udah nandain "keputusan bisnis terpisah, belum di-scope") — sementara DP-application gampang di-unwind bersih karena cuma 1 jurnal reklasifikasi sederhana.

### RLS & Grant (Uang Muka / DP)

Pola identik AR lain — `select` semua `authenticated`, `insert` cuma `admin`/`accountant`, **gak ada** policy `update`/`delete` (default deny + `block_edit_delete`). Detail: migration file.

## Piutang Tak Tertagih (Bad Debt Write-off)

Piutang yang beneran gak akan pernah tertagih (customer menghilang/tutup usaha), dihapusbukukan lewat metode **direct write-off** (bukan allowance/provisi — gak ada data historis buat estimasi kredibel, gak diakui fiskus buat badan usaha umum di Indonesia, gak konsisten sama pola RPC AR lain yang reaktif per-kejadian). Detail rationale bisnis: `docs/domain/accounts-receivable.md` bagian "Piutang Tak Tertagih (Bad Debt Write-off)". Migration: `0029_ar_bad_debt_writeoffs.sql` + `0030_seed_demo_ar_bad_debt_writeoffs.sql`.

**Recovery** (piutang yang udah di-write-off ternyata akhirnya kebayar juga) **di luar scope submodule ini** — direct write-off gak punya akun "cadangan" penyangga buat nampung kasus ini dengan mulus (beda dari allowance method), belum didesain.

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

Beda dari `ar_credit_notes_no_over_return` (sengaja independen, boleh bikin outstanding negatif) — write-off gak boleh ngelebihin **sisa outstanding riil** invoice, dihitung lewat `ar_invoice_remaining()` (payment, retur, DP aktif, write-off lain yang udah ada) — gak masuk akal "menghapus" uang yang udah lunas/diretur duluan lewat jalur lain. Juga nolak kalau invoice-nya udah dibatalkan (exists reversal), pola sama `ar_deposit_applications_guard`.

### RPC `write_off_ar_invoice`

`security invoker`, reuse `create_journal_entry`. 1 kejadian = 1 jurnal, gak ada tahap estimasi/cadangan terpisah. Nominal (`p_amount`) input eksplisit dari caller, konsisten pola RPC AR lain.

Full body: `supabase/migrations/0029_ar_bad_debt_writeoffs.sql`.

### 5 fungsi existing yang ikut diperluas (`create or replace` di `0029`, bukan tabel baru)

Sekarang ada **5 reducer independen** terhadap outstanding 1 invoice — `ar_payment_allocations`, `ar_credit_notes`, `ar_deposit_applications`, `ar_customer_credit_applications`, `ar_bad_debt_writeoffs` — jadi guard yang udah ada semua di-extend biar konsisten jumlahin write-off juga (exclude yang udah di-reverse, pola sama 3 perluasan sebelumnya):
- **`ar_payment_allocations_no_over_allocation`** (0007, di-extend 0024/0027) — tambah `v_invoice_written_off` ke perhitungan.
- **`ar_deposit_applications_guard`** (0024, di-extend 0027) — tambah `v_already_written_off_to_invoice`.
- **`ar_customer_credit_applications_guard`** (0027) — tambah `v_already_written_off`.
- **`create_ar_invoice`** (0007, di-extend 0020/0024/0027) — outstanding calc buat credit hold ikut ngurangin `ar_bad_debt_writeoffs` aktif (union ke-4 di subquery `combined`) — piutang yang udah dihapusbukukan gak boleh masih keitung exposure customer itu.

**`cancel_ar_invoice`** (0009, di-extend 0024/0027) ikut di-extend lagi: guard baru di awal fungsi, nolak keras kalau invoice udah punya `ar_bad_debt_writeoffs` — beda dari `ar_deposit_applications`/`ar_customer_credit_applications` (auto-unwind), write-off itu keputusan bisnis yang udah dijurnal sebagai kerugian nyata, sama kelasnya kayak guard `ar_payment_allocations` (ditolak keras, bukan di-unwind). SQL final guard ini ada di RPC `cancel_ar_invoice`, submodule "Konsep Inti".

Direview `schema-reviewer` sebelum apply — gak ada temuan blocker/warning, termasuk dicek eksplisit soal function-overload hazard (nama fungsi yang di-`create or replace` semua signature-nya identik ke versi sebelumnya, gak butuh `drop function if exists`).

### RLS & Grant (Piutang Tak Tertagih)

Pola identik AR lain — `select` semua `authenticated`, `insert` cuma `admin`/`accountant`, **gak ada** policy `update`/`delete` (default deny + `block_edit_delete`). Detail: migration file.
