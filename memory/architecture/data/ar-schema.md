# Accounts Receivable — Schema (Finalized)

Fase 3 roadmap. Ref konsep bisnis: `docs/domain/accounts-receivable.md` + `memory/domain/accounts-receivable.md`. Ref schema yang di-reuse: `memory/architecture/data/journal-entry-schema.md` (RPC `create_journal_entry`, fungsi `set_updated_at()` & `block_edit_delete()`).

Struktur module → submodule di file ini SAMA urutannya dengan `docs/architecture/ar-schema.md` dan `memory/domain/accounts-receivable.md` (lihat `AGENTS.md` > "Format Baku: Struktur Module → Submodule"). Submodule yang lahir sebagai konsekuensi langsung dari submodule lain (AR Return Credit dari Retur Barang, Cicil Dibalikin & sentralisasi `ar_invoice_remaining` dari Konsep Inti) digabung ke submodule induknya, bukan section historis terpisah kayak sebelumnya.

## Konsep Inti

**`ar_invoices` DIGABUNG ke `transactions` (kolom `type='INBOUND'`), migration `0063`-`0066` (2026-09-05)** — DDL/RPC `create_ar_invoice`/RLS/Grant tabel invoice itu sendiri sekarang didokumentasikan di `memory/architecture/data/transactions-schema.md`, GAK DIULANG di sini (pola sama `counterparty-schema.md` buat gabungan `customers`+`suppliers`). Submodule di bawah ini (Retur Barang, Penukaran Barang, Uang Muka/DP, dan RPC `ar_payments`/`ar_credit_notes`/dst yang TETAP tabel terpisah) masih di sini apa adanya — cuma kolom `invoice_id`-nya sekarang FK ke `transactions(id)`, bukan `ar_invoices(id)` lagi. Submodule "Credit Hold" dan "Piutang Tak Tertagih" (Bad Debt Write-off) yang dulu ada di file ini **DICABUT TOTAL** (keputusan owner, dibundel jadi 1, lihat `transactions-schema.md` > "Keputusan") — udah dihapus dari dokumen ini, bukan sekadar dipindah.

### Keputusan (yang masih spesifik AR, di luar yang udah pindah ke `transactions-schema.md`)

- **Payment exact-match ditegakkan RPC**, bukan cuma app-level — `record_ar_payment` `raise exception` kalau amount gak persis sama sisa outstanding invoice (migration `0040`, regresi disengaja dari desain alokasi many-to-many yang sempat ada; dikoreksi lagi khusus sisi cicil oleh `0010`, lihat "AR Payment — Cicil Dibalikin" di bawah).
- **`customers` dulu satu-satunya tabel AR yang mutable** — sejak migration `0059`, digantikan `counterparties` (gabung dengan `suppliers`, lihat `memory/architecture/data/counterparty-schema.md`) — tetap mutable dengan pola yang sama (`payment_term_days`/`name`/`contact` boleh di-`UPDATE` kapan pun, gak ada published-lock kayak `accounts`).
- Money pakai `numeric(14,2)`, bukan float (invariant `AGENT.md`).

### DDL

#### `counterparties` (dulu `customers`) — master data pihak yang berutang

**Migration `0059_counterparty_schema.sql` (2026-09-03)**: `customers` digabung dengan `suppliers` (AP) jadi 1 tabel `counterparties` — detail lengkap DDL, trigger type-safety, dan dampak lintas modul ada di `memory/architecture/data/counterparty-schema.md`, gak diulang di sini. `ar_invoices.customer_id`/`ar_payments.customer_id`/dst FK-nya sekarang nunjuk `counterparties(id)` (bukan `customers(id)` lagi) — kolom & nama tetap `customer_id`, cuma target FK yang berubah.

Ringkasan (padanan `customers` lama, sekarang jadi bagian `counterparties`):
- `payment_term_days` — default termin (hari) dipakai buat ngitung `due_date` invoice baru. Bukan kolom terkunci — boleh diubah kapan pun, cuma ngaruh ke invoice baru ke depan (`due_date` invoice lama udah ke-snapshot, gak ikut berubah).
- `archived_at` — pola sama kayak `accounts` (`memory/preferences/system/state-naming-convention.md`): satu-satunya penanda lifecycle, gak ada `is_active` terpisah.

**`credit_limit`/`overdue_threshold_days` (dulu ditambah `0020_ar_credit_hold.sql`) SUDAH DIDROP total migration `0065`** — bagian dari pencabutan fitur Credit Hold, lihat `transactions-schema.md` > "Keputusan". Bukan lagi bagian tabel `counterparties`. Sempat ada juga `return_window_days` (ditambah `0033`), dicabut total lewat `0039_ar_remove_return_window.sql` — lihat submodule "Retur Barang" bagian batas waktu retur (item lama, gak ada hubungan sama Credit Hold).

`set_updated_at()` udah ada dari `coa-schema.md`, gak perlu bikin ulang. DDL final `counterparties` (bentuk sekarang, pasca `0065`): `memory/architecture/data/counterparty-schema.md`.

#### `ar_payments` — piutang berkurang

Satu baris = satu kejadian bayar nyata dari customer (bukan jadwal), **selalu nutup 1 invoice spesifik** (gak ada gabung ke invoice lain) — tapi sejak `0010_ar_allow_partial_payment.sql` boleh **cicil** (kurang dari sisa outstanding), 1 invoice bisa punya banyak baris payment dari waktu ke waktu. Riwayat: `0040_ar_payment_strict_invoice_match.sql` (pra-squash) sempat mewajibkan EXACT match (gak boleh cicil ATAUpun overpay) — ternyata itu kelewat ketat, larangan yang dimaksud aslinya cuma soal overpay yang jadi saldo ngambang (`ar_customer_credits`, TETAP dicabut, gak dibalikin), bukan cicil. `0010` melonggarkan itu — lihat "AR Payment — Cicil Dibalikin" di bawah buat detail lengkap. Yang perlu diperhatiin:
- `invoice_id` — **bukan unique lagi** sejak `0010` — langsung nunjuk ke 1 invoice (bukan lewat tabel jembatan), tapi 1 invoice boleh punya banyak baris payment.
- `amount` — gak boleh **melebihi** `ar_invoice_remaining(invoice_id)` pas `record_ar_payment` dipanggil (boleh kurang = cicil, gak boleh lebih = overpay tetap ditolak), ditegakkan RPC (`raise exception`), bukan constraint DB.
- `journal_entry_id` — wajib, pola sama `transactions`.
- **Gak ada `updated_at`/`archived_at`** — sama alasan `transactions`.

```sql
create table ar_payments (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references counterparties(id), -- dulu references customers(id), repoint migration 0059
  invoice_id uuid not null references transactions(id), -- dulu references ar_invoices(id), repoint migration 0064
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

Fungsi ini udah ada di `journal-entry-schema.md`, tinggal dipasang ke `ar_payments` (`ar_invoices` sendiri udah gabung ke `transactions`, immutability-nya didokumentasikan di `transactions-schema.md`).

```sql
create trigger ar_payments_block_edit_delete
  before update or delete on ar_payments
  for each row execute function block_edit_delete();
```

### RPC (financial write — atomik, reuse `create_journal_entry`)

`security invoker`, pola sama `journal-entry-schema.md`. Kunci desainnya: **gak insert manual ke `journal_entries`/`journal_lines`** — manggil RPC `create_journal_entry` yang udah ada, biar validasi (leaf-only, balance-check) dan atomicity-nya otomatis kewarisin, gak perlu ditulis ulang.

`create_ar_invoice` (dulu ada di sini) UDAH DIDROP total migration `0065`, gantinya `create_transaction('INBOUND', ...)` — signature & body baru didokumentasikan di `transactions-schema.md`, gak diulang di sini. Rincian PPN/kategori tambahan (`p_credit_lines`/`p_lines`, `tax_settings`, `ar_invoice_charge_types`) yang dulu dijelasin di submodule "Compounding & PPN" bawah ini TETAP RELEVAN (`ar_invoice_charge_types` masih ada, cuma tabel `ar_invoice_credit_lines` yang digantikan `transaction_lines` generic) — baca terus di bawah.

### Compounding & PPN — migration `0025_compound_transactional_entries_schema.sql` (histori), diserap `create_transaction` migration `0063`

Menutup `memory/scope-debt/compound-transactional-entries.md` (sudah dihapus, lihat "Aturan siklus hidup dokumen" `memory/brief.md`) — `create_ar_invoice` (dulu) sebelumnya cuma nerima **1 akun kredit tetap** (`p_revenue_account_id`) + `p_amount` mentah. Sekarang (`create_transaction`) nerima `p_lines jsonb` (array `{account_id, amount}`) — bisa dipecah beberapa kategori pendapatan (mis. Pendapatan Penjualan Barang + Pendapatan Jasa Antar) dalam **1 transaksi yang sama**. Sisi debit (Piutang Usaha, `p_control_account_id`) TETAP 1 baris, gak berubah — cuma sisi kredit yang jadi array.

- **`transaction_lines`** (dulu `ar_invoice_credit_lines`, digabung sisi AP juga sejak `0064`) — 1 baris per elemen `p_lines` + 1 baris tambahan kalau `p_apply_tax` (`is_tax=true`). Immutable (`block_edit_delete`), FK `transaction_id` ke `transactions`. Ini yang bikin PPN & kategori tambahan **traceable ke 1 transaksi**, gak lagi jurnal manual lepas kayak sebelumnya (lihat catatan PPN di bawah). DDL lengkap: `transactions-schema.md`.
- **`ar_invoice_charge_types`** — katalog master data (bukan tabel transaksional), TETAP ADA gak kesentuh migrasi ini: `id`, `name`, `account_id` (FK `accounts`), `archived_at` (soft-delete, `state-naming-convention.md`). Murni buat UI (dropdown "pilih kategori" di form AR Invoice) — **gak ada FK dari sini ke `transaction_lines`**, sama kayak `item_units` yang juga cuma resolve pilihan di UI sebelum manggil RPC (trust boundary gak berubah: RPC tetap cuma terima `account_id` mentah, sama kayak `p_control_account_id` yang udah lama gitu). Cuma admin yang bisa insert/update (RLS `ar_invoice_charge_types_insert`/`_update`).
- **PPN (`p_apply_tax boolean default false`)** — beda perlakuan dari kategori bebas: PPN **dihitung server-side**, gak pernah dari input klien (`is_tax` di `transaction_lines` gak pernah diisi dari JSON klien, cuma RPC yang set `true` pas insert baris PPN-nya sendiri). Kalau `p_apply_tax=true`, RPC baca `tax_settings` (singleton, lihat bawah) — `raise exception` kalau `is_active=false` atau akun PPN Keluaran belum diset. Alasan gak dipercaya dari klien: sebelumnya (interim, migration `0022`) PPN dicatat manual lewat `create_journal_entry` di luar `create_ar_invoice` — gak traceable ke invoice manapun (lihat `memory/scope-debt/tax-handling.md`, sudah dihapus, riwayat resolusinya diringkas di sini).
- **`tax_settings`** — tabel singleton (`id boolean primary key default true` + `check (id)`, cuma bisa ada 1 baris selamanya), TETAP ADA gak kesentuh migrasi ini. Kolom: `is_active` (apakah bisnis ini sekarang wajib pungut PPN — beda dari `archived_at` katalog, ini flag konfigurasi bukan lifecycle per-baris), `ppn_rate numeric(5,2)`, `ppn_keluaran_account_id`/`ppn_masukan_account_id` (FK `accounts`, dipetakan ke akun `2400`/`1500` yang diseed di file yang sama). Tarif PPN itu aturan pemerintah (nasional) — disimpan di DB bukan di-hardcode di kode, biar ganti tarif cukup 1 `UPDATE`, gak perlu deploy ulang. RLS: select semua authenticated, update admin doang, **gak ada insert/delete** (baris tunggalnya cuma diseed migration, constraint singleton nolak baris kedua). Dipakai bareng oleh `create_transaction` (sisi OUTBOUND, PPN Masukan) dan `create_pos_sale` (PPN Keluaran) — didefinisikan sekali di sini, referensi silang dari `ap-schema.md`/`pos-schema.md`.
- **`create_goods_issue`** (`memory/architecture/data/inventory-schema.md`) manggil `create_transaction('INBOUND', ...)` di dalamnya sejak `0064` (dulu `create_ar_invoice`) — signature eksternal `create_goods_issue` sendiri gak berubah.

#### `record_ar_payment` — bikin payment + journal entry sekaligus, langsung ke 1 invoice (terakhir didefinisi `0065`, target `transactions`)

Signature 7 param, `p_invoice_id` tunggal — bukan `p_allocations` jsonb array (riwayat: `0007` versi awal 7 param beda bentuk, `0027` diperluas jadi 8 param `p_allocations`+`p_customer_credit_account_id`, `0040` balik ke 7 param + wajib exact-match, `0010` signature TETAP SAMA cuma guard-nya dilonggarkan — detail lengkap di "AR Payment — Cicil Dibalikin" di bawah). `p_amount` gak boleh **melebihi** `ar_invoice_remaining(p_invoice_id)` — boleh kurang (cicil), gak boleh lebih (overpay) — `raise exception` sebelum jurnal apa pun dibuat kalau overpay. `p_invoice_id` sekarang nunjuk `transactions(id)` (bukan `ar_invoices(id)` lagi sejak `0064`).

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
  v_invoice_ref text;
begin
  select ar_invoice_remaining(p_invoice_id) into v_remaining;

  if p_amount > v_remaining then
    select source_ref into v_invoice_ref from transactions where id = p_invoice_id;
    raise exception 'Payment % melebihi sisa piutang invoice % (sisa %, coba bayar %) -- gak boleh overpay',
      p_source_ref, v_invoice_ref, v_remaining, p_amount;
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

#### `cancel_ar_invoice` — batalkan invoice salah input (reversing entry, dengan guard) (terakhir didefinisi `0065`, target `transactions`)

Manggil `reverse_journal_entry` yang udah ada (fase 2) — pakai **akun yang sama persis** dengan invoice asli, debit/kredit ketuker, gak butuh akun baru (ini koreksi "salah input", bukan kejadian bisnis baru kayak retur barang). Auto-unwind jurnal `ar_deposit_applications` aktif (reklasifikasi sederhana, aman dibalik — detail lengkap di submodule "Uang Muka / DP"). Guard write-off (dulu ngecek `ar_bad_debt_writeoffs`) **DIHAPUS `0065`** bareng tabelnya — fitur Piutang Tak Tertagih dicabut total, gak ada lagi apa pun buat di-guard di sisi itu. Loop unwind `ar_return_credit_applications` yang sempat ada (`0031`) juga **dihapus di `0041`** bareng tabelnya — gak ada lagi apa pun buat di-unwind di sisi return credit (lihat submodule "Retur Barang").

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
  v_original_entry_id uuid;
  v_new_entry_id uuid;
  v_application record;
  v_invoice_ref text;
begin
  select count(*) into v_paid_count
  from ar_payments where invoice_id = p_invoice_id;

  if v_paid_count > 0 then
    select source_ref into v_invoice_ref from transactions where id = p_invoice_id;
    raise exception 'Invoice % udah punya payment — gak bisa dibatalkan lewat jalur ini', v_invoice_ref;
  end if;

  select journal_entry_id into v_original_entry_id from transactions where id = p_invoice_id;

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

Gak insert/update apa pun ke `transactions` (baris `type='INBOUND'`) — baris invoice asli tetap ada persis kayak semula (immutability tetap utuh). Status "dibatalkan" murni kebaca dari keberadaan reversal di `journal_entries`, sama pola derived kayak status lunas/belum.

### RLS Policy & Grant

**`ar_payments_select`** — semua yang `authenticated` boleh liat, pola sama modul lain. **`ar_payments_insert`** — cuma `admin`/`accountant`. **Sengaja gak ada policy `UPDATE`/`DELETE`** — RLS default deny + trigger `block_edit_delete` = 2 lapis immutability. RLS/Grant `transactions` (dulu `ar_invoices`) sekarang di `transactions-schema.md`, RLS `counterparties`/`counterparty_type_mapping` (dulu `customers`) di `counterparty-schema.md` — gak diulang di sini.

```sql
alter table ar_payments enable row level security;

create policy ar_payments_select on ar_payments
  for select using (auth.role() = 'authenticated');

create policy ar_payments_insert on ar_payments
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );
-- sengaja gak ada policy UPDATE/DELETE -> RLS default deny

grant select, insert on ar_payments to authenticated;
```

RPC (`create_transaction`, `record_ar_payment`) otomatis kepakai `authenticated` selama grant `execute` default Postgres gak dicabut.

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

Ditutup 2026-08-13, migration `0020_ar_invoice_remaining_return_credit_fix.sql` — nambah reducer ke-5, add-back `+ coalesce(sum(ar_return_credits.amount) via join ar_credit_notes, 0)`, mirror persis `ap_bill_remaining()` (migration `0010_ap_bill_remaining_return_credit_fix.sql`, diverifikasi cocok dengan definisi live sebelum di-push). Tanpa add-back ini outstanding invoice bisa keliatan minus kalau ada retur dengan excess reclass pada invoice yang udah dibayar sebagian/lunas — padahal Piutang Usaha-nya sendiri sudah balik ke 0 lewat jurnal reklasifikasi terpisah (lihat "AR Return Credit" di bawah). `invoiceStatus()` frontend (`apps/erp/src/lib/ar-invoices/schema.ts`) + 3 call site query (`ar-invoices/page.tsx`, `ar-invoices/[id]/view.tsx`, `customers/[id]/view.tsx`) diupdate bareng, nambah nested select `ar_return_credits(amount)` di bawah `ar_credit_notes`.

### `ar_invoices_with_status` view — migration `0033_ar_invoice_status_view.sql` (nomor file current, bukan nomor pra-squash yang disebut di atas)

Nutup scope-debt filter status di list `/ar-invoices`. Reuse `ar_invoice_remaining()` di atas buat `outstanding`, tapi status butuh reducer `allocated`/`deposit_applied`/`written_off` kePisah (lateral subquery masing-masing) karena `invoiceStatus()` (`apps/erp/src/lib/ar-invoices/schema.ts`) sengaja bedakan retur doang (gak dianggap "sebagian") dari payment/DP/writeoff aktif — mirror `ap_bills_with_status` (0032). Cabang `dihapusbukukan` (`written_off > 0 and outstanding <= 0.005`) dicek sebelum `lunas` polos, sama urutan ternary di client.

**Kolom `origin` ditambah migration `0038_ap_bill_ar_invoice_origin_filter.sql`** (`CREATE OR REPLACE VIEW`, mirror perlakuan `ap_bills_with_status`) — nutup filter "Tipe" (`financial_only` kalau gak ada baris `goods_issues` buat invoice ini, `sales_order` kalau salah satu `goods_issue_lines.order_line_id`-nya keisi, else `goods_issue`), gantiin fungsi client `invoiceOrigin()` yang sebelumnya dihitung dari embed `goods_issues(id, goods_issue_lines(so_line_id))` nested (sekarang dihapus dari select list). Kolom `goods_issue_lines.so_line_id` di-rename jadi `order_line_id` migration `0060_orders_schema.sql` (Fase 3 order-generalization, `purchase_orders`/`sales_orders` gabung jadi `orders` — lihat `inventory-schema.md`), origin CASE di bawah diupdate ikut nama kolom baru.

**Denormalisasi ke kolom asli — migration `0053_denormalize_transactional_status.sql`** (2026-08-17, sudah di-push & diverifikasi user lewat testing UI): view di atas (dan padanannya di 6 modul lain — lihat `ap-schema.md`, `inventory-schema.md`, `pos-schema.md`) tadinya ngitung ulang `outstanding`/`returned`/`status`/`origin` LEWAT lateral subquery per baris, tiap kali di-query — termasuk pas list `/ar-invoices` dibuka tanpa filter tanggal (default), yang berarti ngitung ulang status SELURUH `ar_invoices` tiap load. Karena tabel ini append-only, biaya ini naik tak terbatas seiring waktu. Fix: `outstanding`/`returned`/`status`/`origin` sekarang KOLOM ASLI di `ar_invoices`, dijaga fungsi `recompute_ar_invoice_status()` (`security definer`, reuse `ar_invoice_remaining()` di atas apa adanya) yang dipanggil trigger `AFTER INSERT` di semua tabel reducer (`ar_payments`, `ar_credit_notes`, `ar_deposit_applications`, `ar_bad_debt_writeoffs`, `ar_return_credits`, `warranty_replacements`, `goods_issues`, `goods_issue_lines`) + 1 trigger gabungan di `journal_entries` (`journal_entries_sync_reversal_status`, dipakai bareng AP Bills/POS Sales/AR&AP Deposits buat kasus reversal). View `ar_invoices_with_status` MASIH ADA (nama & kolom sama, `queries.ts` gak berubah) tapi sekarang cuma `select` polos dari kolom yang udah tersimpan. **Efek samping**: `ar_invoices_block_edit_delete` (trigger immutability generik dari `0005`, nolak SEMUA update) diganti jadi selective (`ar_invoices_block_edit_delete_or_sync`, pola niru `purchase_orders_block_edit_delete_or_cancel` `0024`) — kolom bisnis asli (customer/tanggal/nominal/dll) tetap immutable, cuma `outstanding`/`returned`/`status`/`origin` yang boleh diubah trigger otomatis.

### AR Customer Credit (Kelebihan Bayar) — dicabut total (migration `0040_ar_payment_strict_invoice_match.sql`)

Sempat ada mekanisme "customer transfer lebih dari total invoice yang dilunasin, excess-nya jadi saldo kredit" — tabel `ar_customer_credits`/`ar_customer_credit_applications`/`ar_customer_credit_refunds` (migration `0027`), RPC `apply_ar_customer_credit`/`refund_ar_customer_credit`, akun liability `Saldo Kredit Customer` (`2400`). Semuanya dicabut total (tabel di-drop, RPC di-drop) begitu keputusan bisnis "payment gak boleh overpay" jalan — gak ada lagi jalur buat kelebihan bayar "nyantol", `record_ar_payment` `raise exception` kalau amount ngelebihin sisa. Rationale: `docs/domain/accounts-receivable.md` bagian "Kenapa cicil boleh tapi overpay gak boleh". **Tetap dicabut permanen** — cicil dibalikin (`0010`, lihat di atas) tapi overpay-jadi-saldo-ngambang ini TIDAK dibalikin.

## Credit Hold — DICABUT TOTAL, migration `0065` (2026-09-05)

Dulu ada di sini: kolom `counterparties.credit_limit`/`overdue_threshold_days` + cek 2 kondisi independen (nominal prospektif outstanding+invoice baru vs `credit_limit`, dan overdue days vs `overdue_threshold_days`) nempel di RPC `create_ar_invoice`. **Keputusan owner (2026-09-05)**: disingkirkan total — `create_transaction` (RPC pengganti) gak pernah punya cek ini sejak desain awal, kolomnya sendiri didrop migration `0065`. Rationale lengkap & histori keputusan: `memory/architecture/data/transactions-schema.md` > "Keputusan". AR gak lagi punya kemampuan formal nolak invoice yang ngelewatin plafon kredit — kalau kebutuhan ini muncul lagi, dirancang ulang dari nol (bukan diaktifkan lagi begitu saja).

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
  invoice_id uuid not null references transactions(id), -- dulu references ar_invoices(id), repoint migration 0064
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
  customer_id uuid not null references counterparties(id), -- dulu references customers(id), repoint migration 0059
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

Retur Warung Kang Ade (`0023_seed_demo_ar_credit_notes.sql`, sebelum fitur ini ada) udah lebih dulu bikin invoice-nya minus tanpa lewat jalur otomatis di atas — migration seed `0032` manual insert jurnal reklasifikasi + baris `ar_return_credits` yang SEHARUSNYA otomatis kebentuk kalau fitur ini udah ada waktu itu, lalu demo `refund_ar_return_credit` buat nunjukin disposisinya. Kompatibel apa adanya sama `0041` (gak pernah insert ke `ar_return_credit_applications`, gak perlu diedit).

#### Catatan terbuka — belum ada cap gabungan lintas invoice/waktu

Per invoice udah ada batas alami (`ar_credit_notes_no_over_return` caps retur ≤ `amount` invoice), tapi belum ada cap akumulasi saldo kredit retur lintas invoice/waktu buat 1 customer. Gak dirancang sekarang karena belum ada bukti kebutuhan di cerita.

### RLS & Grant (AR Return Credit)

Pola identik AR lain — `select` semua `authenticated`, `insert` cuma `admin`/`accountant`, **gak ada** policy `update`/`delete` (default deny + `block_edit_delete`). Detail: migration file.

### Batas Waktu Retur — dicabut total (migration `0039_ar_remove_return_window.sql`)

Sempat ada 2 lapis (window per item `items.return_window_days` dari `0021`, window per customer `customers.return_window_days`/`ar_invoices.return_window_days` dari `0033`+seed `0034`) — keduanya dicabut total, kolom di-drop, cek di trigger `inventory_return_lines_guard` dan RPC `create_ar_credit_note` dihapus. Retur diterima/ditolak sekarang murni keputusan manual owner/staff di luar sistem. Rationale: `docs/domain/accounts-receivable.md` bagian "Retur Barang (Credit Note)", `memory/domain/accounts-receivable.md`.

## Penukaran Barang Pasca-Retur (Garansi)

Customer minta barang pengganti buat item yang udah terjual (lewat `goods_issue`) — BUKAN gratis/cuma-cuma (dijurnal HPP/Persediaan), TANPA invoice baru, dan (sejak `0057`) **gak nyentuh Piutang Usaha sama sekali**. Detail rationale bisnis: `docs/domain/accounts-receivable.md` bagian "Penukaran Barang Pasca-Retur (Garansi)". Migration: `0026_ar_warranty_replacements.sql` (versi awal) → `0037_ar_warranty_replacement_discount_reversal.sql` (pembalikan diskon) → `0041_ar_return_credit_resolution.sql` (penyelesaian saldo kredit retur) → **`0057_ar_warranty_replacement_independent.sql`** (restrukturisasi jadi independen, keputusan owner 2026-09-03).

**Restrukturisasi `0057` — kenapa & apa yang berubah:** dulu warranty replacement WAJIB nunjuk `credit_note_id` yang sudah lebih dulu mencatat retur fisik+diskon (`ar_credit_notes.amount`, SELALU > 0 — gak ada jalur "amount = 0"). Kalau replacement dipanggil buat qty yang sama, sistem MENGIZINKAN lalu mewajibkan pembalikan proporsional diskon (`0037`) biar gak dobel kompensasi — strategi "izinkan lalu koreksi". Sekarang direstrukturisasi jadi INDEPENDEN — mirror `create_purchase_replacement` (AP, `ap-schema.md`) yang independen dari awal, nunjuk `bill_id` langsung, gak pernah butuh credit note ada duluan. Fungsi baru `sales_returned_qty(invoice_id, item_id)` (mirror `purchase_returned_qty`) menjumlah qty yang udah diklaim LINTAS SEMUA jalur (retur kredit + ganti barang) buat 1 item di 1 invoice, dipakai jaga qty fisik yang sama gak diklaim dobel — mencegah kompensasi ganda dari akarnya (dicegah dari awal), gantiin mekanisme reversal yang cuma mengoreksi belakangan.

### `warranty_replacements` + `warranty_replacement_lines`

Satu baris header = satu kejadian penggantian (bisa lebih dari 1 kali per invoice). `journal_entry_id` nunjuk jurnal Debit HPP / Kredit Persediaan Barang Jadi (`create_journal_entry`, reuse) — **satu-satunya jurnal** yang dibuat RPC ini sejak `0057`. `invoice_id` (**baru, `0057`**) rujukan utama, independen dari credit note. `credit_note_id` (**jadi nullable, `0057`**) TETAP ada buat baris HISTORIS (data lama) yang masih nunjuk situ — baris BARU selalu NULL. Kolom reversal (`discount_reversed_amount`, `discount_reversal_journal_entry_id`, `return_credit_settled_amount`, `return_credit_settlement_journal_entry_id`) juga TETAP ada buat histori — RPC baru gak pernah ngisi (selalu default `0`/`NULL`), gak ada backfill mundur. Immutable, pola sama `ar_credit_notes`/`inventory_returns`.

```sql
create table warranty_replacements (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references transactions(id),          -- 0057, rujukan utama; dulu ar_invoices(id), repoint 0064
  credit_note_id uuid references ar_credit_notes(id),             -- 0057: jadi nullable, cuma histori
  replacement_date date not null,
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  discount_reversed_amount numeric(14,2) not null default 0 check (discount_reversed_amount >= 0),  -- histori doang sejak 0057
  discount_reversal_journal_entry_id uuid references journal_entries(id),
  return_credit_settled_amount numeric(14,2) not null default 0 check (return_credit_settled_amount >= 0),  -- histori doang sejak 0057
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

### `sales_returned_qty(invoice_id, item_id)` — mirror `purchase_returned_qty` (`0057`)

```sql
create function sales_returned_qty(p_invoice_id uuid, p_item_id uuid) returns numeric as $$
  select
    coalesce((select sum(irl.qty_returned) from inventory_return_lines irl
      join inventory_returns ir on ir.id = irl.inventory_return_id
      join ar_credit_notes acn on acn.id = ir.credit_note_id
      where acn.invoice_id = p_invoice_id and irl.item_id = p_item_id), 0)
    + coalesce((select sum(wrl.qty_replaced) from warranty_replacement_lines wrl
      join warranty_replacements wr on wr.id = wrl.warranty_replacement_id
      where wr.invoice_id = p_invoice_id and wrl.item_id = p_item_id), 0);
$$ language sql stable;
```

Gabungan qty yang udah "diklaim" dari 1 item di 1 invoice, lintas retur kredit (`inventory_return_lines` via `ar_credit_notes`) + ganti barang (`warranty_replacement_lines` via `invoice_id` langsung). **Ini yang beneran menegakkan mutual exclusivity** — begitu qty suatu item abis diklaim lewat retur kredit, sisa yang bisa diganti otomatis 0 tanpa butuh cek "diskon > 0" eksplisit (yang gak akan pernah kerja karena `ar_credit_notes.amount` emang selalu > 0).

### Trigger `warranty_replacement_lines_no_over_replace` (ditulis ulang `0057`)

Dulu: cap ke `SUM(qty_returned)` di `inventory_return_lines` 1 credit note doang. Sekarang: cap ke `goods_issue_lines.qty_issued` (invoice asli, via `goods_issues.invoice_id`) **dikurangi** `sales_returned_qty()` — mirror persis `purchase_replacement_lines_no_over_return` (AP). Item yang gak ketemu di `goods_issue_lines` invoice itu `raise exception` duluan (invoice financial-only gak punya barang fisik buat diganti).

### Trigger `warranty_replacements_no_over_reverse` (fix `0037`) dan `warranty_replacements_no_over_settle_return_credit` (`0041`) — TETAP ADA, gak diubah `0057`

Dua-duanya baca `new.credit_note_id`/`new.discount_reversed_amount`/`new.return_credit_settled_amount` — aman dijalankan buat baris baru (`credit_note_id` NULL, kedua kolom amount selalu `0`): `no_over_settle_return_credit` short-circuit di awal kalau `return_credit_settled_amount = 0`; `no_over_reverse` gak short-circuit eksplisit tapi `select amount from ar_credit_notes where id = NULL` balikin NULL, bikin perbandingan `... > NULL` evaluasi NULL (bukan TRUE) di PL/pgSQL — `raise exception` gak pernah kepicu. Dipertahankan aktif buat baris HISTORIS yang credit_note_id-nya masih terisi, walau RPC baru gak akan pernah nyentuh kolom-kolom yang dijaga trigger ini lagi.

### RPC `create_warranty_replacement` (signature baru, jauh lebih sederhana — `0057`)

```sql
create_warranty_replacement(
  p_invoice_id uuid, p_replacement_date date, p_source_ref text,
  p_lines jsonb, -- {"item_id":uuid,"qty":numeric}
  p_hpp_account_id uuid, p_finished_good_account_id uuid
) returns uuid
```

Turun dari 9 parameter ke 6 — `p_credit_note_id`/`p_contra_revenue_account_id`/`p_receivable_account_id`/`p_return_credit_liability_account_id` semua dicabut, karena RPC baru gak pernah bikin jurnal reversal/settlement sama sekali. **Wajib `drop function if exists create_warranty_replacement(uuid, date, text, jsonb, uuid, uuid, uuid, uuid, uuid)` sebelum `create function`** — signature-nya berubah total (bukan cuma nambah param opsional di akhir), kalau enggak Postgres bikin overload ambigu (pelajaran dari bug `0011`/`0012` `create_ap_bill`, sudah didokumentasikan sebagai konvensi wajib project ini).

- `security invoker`, reuse `create_journal_entry` + `consume_weighted_average` — 0 fungsi baru buat logic konsumsi stok.
- Guard `p_lines` kosong/null tetap dicek eksplisit (pola lama dipertahankan).
- **Gak ada lagi guard "credit note jalur full"** — RPC ini sekarang gak butuh credit note apa pun, langsung konsumsi stok + bikin 1 jurnal HPP/Persediaan, insert header+lines+`inventory_movements`. Mutual exclusivity ditegakkan trigger `warranty_replacement_lines_no_over_replace` di atas, bukan guard eksplisit di RPC.
- **Konsumsi stok**: gak berubah dari versi sebelumnya — tetap pool `inventory_balances` (Weighted Average) via `consume_weighted_average`, tetap otomatis gak kepakai barang `DAMAGED` (baris itu emang gak pernah nambah `inventory_balances` sejak `0015`).

Migration/riwayat: `0026` (versi awal) → `0037` (pembalikan diskon) → `0038` (costing disederhanakan) → `0041` (penyelesaian saldo kredit retur) → **`0057`** (restrukturisasi independen, bentuk final saat ini).

### RLS & Grant (Penukaran Barang)

Pola identik AR/Inventory lain — `select` semua `authenticated`, `insert` cuma `admin`/`accountant`, **gak ada** policy `update`/`delete` (default deny + `block_edit_delete`).

## Uang Muka / DP (Deposit)

Customer bayar duluan sebelum invoice ada (misal DP pesanan custom). **Bukan** `ar_payment` — jurnalnya gak nyentuh Piutang Usaha sama sekali pas diterima (piutangnya belum ada), dicatat ke akun liability baru `Uang Muka Penjualan` (`2300`, insert di migration seed 0025, pola sama `4900 Retur & Potongan Penjualan`). Detail rationale bisnis: `docs/domain/accounts-receivable.md` bagian "Uang Muka / DP (Deposit)". Migration: `0024_ar_deposits_schema.sql` + `0025_seed_demo_ar_deposits.sql` (versi awal), `0012_ar_deposit_refund_and_partial.sql` (partial-capable + refund).

### `ar_deposits` — DP diterima (selalu dibuat)

Satu baris = satu kejadian terima uang muka. `journal_entry_id` nunjuk jurnal Debit Kas/Bank / Kredit Uang Muka Penjualan (`create_journal_entry`, reuse). Immutable, pola sama `ar_invoices`/`ar_payments`.

```sql
create table ar_deposits (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references counterparties(id), -- dulu references customers(id), repoint migration 0059
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
  invoice_id uuid not null references transactions(id), -- dulu references ar_invoices(id), repoint migration 0064
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

~~Status 1 deposit (belum dipakai / sebagian / selesai) **derived** dari `ar_deposit_remaining()` vs `amount`, bukan kolom~~ — **UPDATE migration `0053`** (lihat di bawah): sekarang KOLOM ASLI (`ar_deposits.status`/`remaining`), bukan derived lagi, walau cara hitungnya (reuse `ar_deposit_remaining()`) gak berubah.

### `ar_deposits_with_status` view — migration `0037_ar_deposit_status_view.sql`

Nutup scope-debt filter status di list `/ar-deposits`. Mirror persis `ap_deposits_with_status` (0031, arah kebalik — DP diterima dari customer, bukan dibayar ke supplier): reuse `ar_deposit_remaining()` di atas lewat `cross join lateral` (sekali per baris), `security_invoker = true` biar RLS `ar_deposits_select` tetap ke-enforce lewat view, grant eksplisit ke `authenticated`. `apps/erp/src/lib/ar-deposits/queries.ts` query view ini langsung, gak perlu lagi fetch nested `ar_deposit_applications`/`refunds`/`forfeitures` cuma buat dihitung ulang di client — itu tetap dipakai di halaman detail `[id]/view.tsx`.

**Denormalisasi ke kolom asli — migration `0053_denormalize_transactional_status.sql`** (lihat detail mekanisme lengkap di submodule AR Invoice di atas, pola identik): `remaining`/`status` sekarang kolom asli di `ar_deposits`, dijaga `recompute_ar_deposit_status()` (`security definer`) lewat trigger `AFTER INSERT` di `ar_deposit_applications`/`ar_deposit_refunds`/`ar_deposit_forfeitures` + trigger gabungan `journal_entries_sync_reversal_status`. `ar_deposit_applications` insert juga mancing recompute `ar_invoices` (karena `deposit_applied` ikut jadi reducer `ar_invoice_remaining()`) — 1 trigger gabungan, gak dobel-hitung. View `ar_deposits_with_status` sekarang `select` polos. `ar_deposits_block_edit_delete` diganti selective, pola sama AR Invoice.

### RPC: `create_ar_deposit`, `apply_ar_deposit`, `refund_ar_deposit`, `forfeit_ar_deposit`

`security invoker`, pola sama RPC AR lain — semua reuse `create_journal_entry`, gak pernah insert manual ke `journal_entries`/`journal_lines`. `create_ar_deposit` insert `ar_deposits`. `apply_ar_deposit` insert `ar_deposit_applications` (nominal diinput eksplisit dari caller). `refund_ar_deposit` (**baru `0012`**) insert `ar_deposit_refunds`. `forfeit_ar_deposit` (**signature baru `0012`**, nambah `p_amount` — sebelumnya gak nerima nominal, `drop function` dulu buat signature lama karena beda jumlah param) insert `ar_deposit_forfeitures` pakai nominal eksplisit, bukan `ar_deposits.amount` langsung lagi.

Full body (definisi terkini): `supabase/migrations/0005_ar_schema.sql`.

### `cancel_ar_invoice` diperluas — auto-unwind `ar_deposit_applications`

**Keputusan desain paling penting di submodule ini.** Sebelum ini, `cancel_ar_invoice` (`0009_ar_invoice_cancellation.sql`) cuma reverse jurnal invoice-nya sendiri. Kalau invoice itu udah punya `ar_deposit_applications`, itu bakal bikin Piutang Usaha nyasar minus (jurnal application gak ikut ke-reverse) dan DP-nya nyangkut gak jelas statusnya — dianalisa lewat contoh angka konkret bareng user.

Fix-nya **`create or replace function`** di `0024_ar_deposits_schema.sql` (bukan edit `0009`, migration lama tetep gak disentuh, SQL lengkap ada di submodule "Konsep Inti") — RPC ini sekarang, setelah reverse jurnal invoice, loop semua `ar_deposit_applications` invoice itu yang masih aktif (belum di-reverse) dan ikut manggil `reverse_journal_entry` buat tiap satu. Signature (nama param, urutan, return type) identik persis versi 0009 — caller existing (`src/app/(app)/ar-invoices/[id]/view.tsx`, manggil pakai named-parameter object) gak perlu berubah.

**Kenapa auto-unwind, bukan cuma nolak** (beda dari guard `ar_payment_allocations` di RPC yang sama, yang tetep nolak keras, gak diubah): nolak doang gak nyelesain masalah duitnya — deposit yang udah "kepake" ke invoice yang ternyata salah input butuh jalan keluar, bukan jalan buntu. Guard `ar_payment_allocations` sengaja tetep beda perlakuan karena itu duit customer yang beneran udah "nyantol" ke pelunasan (nasibnya lebih kompleks, `docs/domain/accounts-receivable.md` udah nandain "keputusan bisnis terpisah, belum di-scope") — sementara DP-application gampang di-unwind bersih karena cuma 1 jurnal reklasifikasi sederhana.

### RLS & Grant (Uang Muka / DP)

Pola identik AR lain — `select` semua `authenticated`, `insert` cuma `admin`/`accountant`, **gak ada** policy `update`/`delete` (default deny + `block_edit_delete`). Detail: migration file.

## Piutang Tak Tertagih (Bad Debt Write-off) — DICABUT TOTAL, migration `0064`+`0065` (2026-09-05)

Dulu ada di sini: `ar_bad_debt_writeoffs` (write-off direct terhadap 1 invoice, immutable) + RPC `write_off_ar_invoice` + guard `ar_bad_debt_writeoffs_no_over_writeoff` + reducer ke-5 di beberapa fungsi outstanding. **Keputusan owner (2026-09-05)**, dibundel jadi 1 sama pencabutan Credit Hold: disingkirkan total — RPC & trigger aktif didrop migration `0064`, tabelnya sendiri didrop migration `0065`. Rationale lengkap & histori keputusan: `memory/architecture/data/transactions-schema.md` > "Keputusan". AR gak lagi punya jalur formal buat nyatet piutang macet jadi beban — kalau kebutuhan ini muncul lagi (termasuk fitur "Recovery" yang dulu emang belum sempat didesain), dirancang ulang dari nol.
