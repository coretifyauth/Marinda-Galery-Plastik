# Credit Notes — Schema (Finalized)

Gantiin `ar_credit_notes` (AR) + `ap_credit_notes` (AP) — digabung jadi 1 tabel generic
`credit_notes` (kolom `type` `'INBOUND'`/`'OUTBOUND'`), migration `0070` (2026-09-05).
Fase 2 dari unifikasi tabel anak AR/AP (`payments` [`0069`], `credit_notes`, `deposits`,
`return_credits`) — mirror pola `transactions`/`payments`. Ref konsep bisnis gak berubah:
`docs/domain/accounts-receivable.md` bagian "Retur Barang (Credit Note)", pasangan AP di
`docs/domain/accounts-payable.md` bagian "Retur Barang ke Supplier".

## Keputusan

- **Tabel digabung, RPC TETAP 2 fungsi terpisah** (`create_ar_credit_note`/
  `create_ap_credit_note`) — beda dari `payments` (`0069`) yang RPC-nya juga digabung.
  Alasan: `record_ar_payment`/`record_ap_payment` itu near-exact mirror (cuma
  debit/kredit ketuker), sedangkan 2 RPC ini beneran beda bentuk:
  - **AR** bisa bikin 1 ATAU 2 jurnal (kontra-revenue selalu, reversal HPP opsional
    kalau `p_lines` diisi, dengan klasifikasi `RESALABLE`/`DAMAGED` yang nentuin restock
    atau jadi beban) — 11 parameter.
  - **AP** cuma bikin 1 jurnal (langsung ke Persediaan/akun kredit, gak ada konsep akun
    kontra sama sekali), pakai `consume_weighted_average` yang MENGURANGI stok (barang
    keluar balik ke supplier), bukan restock kayak AR — 8 parameter.

  Maksa gabung jadi 1 RPC `p_type`-branch bakal butuh union parameter dari keduanya
  (sebagian besar `NULL` kalau gak dipakai) plus `if/else` yang isinya nyalin ulang
  hampir seluruh body — lebih banyak kode buat perilaku yang sama, bukan lebih sedikit.
  Pola yang dipilih: tabel penyimpanan digabung (biar FK/traceability satu tempat), logic
  bisnis TETAP di RPC masing-masing — sama pola `create_goods_issue`/`create_goods_receipt`
  yang tetap 2 fungsi walau sama-sama nulis ke `inventory_movements`.
- **Gak ada kolom `counterparty_id`** — beda dari `payments`, `credit_notes` gak pernah
  punya kolom pihak langsung di kedua tabel asalnya (customer/supplier selalu diturunkan
  lewat `transaction_id` -> `transactions.counterparty_id`).
- Money pakai `numeric(14,2)`, bukan float (invariant `AGENT.md`).

## DDL

### `credit_notes` — retur barang, sisi AR (`type='INBOUND'`) & AP (`type='OUTBOUND'`)

```sql
create table credit_notes (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('INBOUND', 'OUTBOUND')),
  transaction_id uuid not null references transactions(id),
  credit_note_date date not null,
  source_ref text not null,
  amount numeric(14,2) not null check (amount > 0),
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index credit_notes_transaction_id_idx on credit_notes(transaction_id);
```

Backfill migration `0070` mempertahankan ID asli dari `ar_credit_notes`/`ap_credit_notes`
— **5 tabel turunan** yang FK `credit_note_id`-nya nunjuk ke sini direpoint di migration
yang sama (kolom gak berubah nama, cuma target FK): `return_credits`, `inventory_returns`,
`warranty_replacements` (`warranty-replacements-schema.md`, dulu nunjuk `ar_credit_notes`),
`purchase_return_lines` (dulu nunjuk `ap_credit_notes`). `return_credits` sendiri jadi
spine terpisah (`return-credits-schema.md`) — cuma FK-nya yang disebut di sini.

### `purchase_return_lines` — supporting table sisi AP (Opsi A, cuma jalur full)

Rincian item retur — cuma dibuat kalau `credit_notes.type='OUTBOUND'` (Opsi A "kurangi
utang") DAN bill-nya lahir dari `goods_receipt_notes` (`goods-receipt-schema.md`). Beda
dari `inventory_returns`/`inventory_return_lines` sisi AR di bawah: **gak butuh tabel
header terpisah** — `inventory_returns` di AR eksis karena `warranty_replacements` butuh
nunjuk balik ke situ (bukti fisik). Opsi B di AP (`purchase-replacements-schema.md`)
berdiri sendiri, gak pernah nunjuk ke sini, jadi `purchase_return_lines` cukup FK
langsung ke `credit_notes`.

```sql
create table purchase_return_lines (
  id uuid primary key default gen_random_uuid(),
  credit_note_id uuid not null references credit_notes(id) on delete cascade, -- dulu references ap_credit_notes(id), repoint migration 0070 (catatan: on delete cascade ilang di repoint, inert selama credit_notes immutable)
  item_id uuid not null references items(id),
  qty_returned numeric(14,3) not null check (qty_returned > 0),
  total_cost numeric(14,2) not null check (total_cost > 0)
);
```

Guard qty gabungan (Opsi A + B): `purchase_returned_qty()` — didefinisikan penuh di
`purchase-replacements-schema.md` (spine `purchase_replacements`, karena fungsi itu
jumlahin klaim dari KEDUA tabel, bukan cuma tabel ini).

### `inventory_returns` + `inventory_return_lines` — supporting table sisi AR (cuma jalur full)

Dibuat **cuma kalau** invoice-nya (`credit_notes.type='INBOUND'`) lahir dari
`create_goods_issue` (`goods-issue-schema.md`, ada baris `goods_issues.invoice_id` yang
match). Kebalikan `goods_issues`/`goods_issue_lines` — barang **masuk lagi** (bukan
keluar), stok dan HPP di-reverse proporsional.
- `credit_note_id` — 1:1 ke `credit_notes` yang jadi pasangannya (tiap `inventory_returns`
  pasti punya 1 credit note, tapi gak sebaliknya — credit note financial-only gak punya
  `inventory_returns` sama sekali).
- `goods_issue_id` — many:1, 1 goods_issue bisa diretur beberapa kali (retur bertahap
  dari 1 pengiriman).
- `journal_entry_id` — jurnal reversal HPP (Debit Persediaan Barang Jadi / Kredit HPP),
  **terpisah** dari jurnal kontra-revenue di `credit_notes` (2 jurnal independen, sama
  pola `create_goods_issue` yang juga bikin 2 jurnal).
- `inventory_return_lines.total_cost` — dihitung dari **snapshot** `goods_issue_lines.total_cost`
  asli (unit cost pas barang itu keluar), bukan harga sekarang — biar konsisten sama
  biaya yang beneran diakui waktu itu.

```sql
create table inventory_returns (
  id uuid primary key default gen_random_uuid(),
  credit_note_id uuid not null references credit_notes(id), -- dulu references ar_credit_notes(id), repoint migration 0070
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

Barang yang balik masuk blend ke `inventory_balances.avg_cost` (`inventory-ledger-schema.md`,
formula sama persis weighted-average-receive di `create_goods_receipt`) — **cuma buat
baris `condition = 'RESALABLE'`**. Sebelum migration `0038`, item FIFO malah masuk
sebagai lot baru terpisah (`inventory_lots.source_type = 'SALES_RETURN'`) — sengaja gak
dicampur ke lot fresh, supaya barang retur (berpotensi cacat) gak ketuker dipakai lagi
buat penukaran garansi. Sejak FIFO dihapus, semua retur sempat masuk ke pool
`inventory_balances` tunggal tanpa segregasi sama sekali. **Ditutup migration `0015`**:
kolom `condition` (default `RESALABLE`, opsional di `p_lines` — backward compatible)
balikin segregasinya secara logis (bukan lewat lot lagi) — baris `DAMAGED` gak pernah
nyentuh `inventory_balances` sama sekali, cost-nya direklasifikasi ke akun `Beban
Kerugian Barang Rusak` (`5900`, param `p_loss_expense_account_id`) alih-alih `Persediaan
Barang Jadi`. `inventory_return_lines` tetap diisi buat SEMUA baris terlepas `condition`
(audit trail retur fisik + basis `warranty_replacements`) — cuma `inventory_balances`
yang beda perlakuan.

### Trigger `inventory_return_lines_guard`

`before insert on inventory_return_lines` — **cuma 1 pengecekan**: no-over-return (qty).
Akumulasi `qty_returned` per item per goods_issue gak boleh ngelebihin
`goods_issue_lines.qty_issued`-nya. Sempat gabung 2 pengecekan (qty + batas hari retur
per item, `items.return_window_days`) sampai migration `0039_ar_remove_return_window.sql`
nyabut bagian window-nya total — retur diterima/ditolak sekarang murni keputusan manual
staf di luar sistem.

## Trigger (`credit_notes` sendiri)

### Immutability, konsistensi type, no-over-return, sync status

Pola identik `payments-schema.md` (`0069`) — reuse konsep yang sama:

```sql
create trigger credit_notes_block_edit_delete
  before update or delete on credit_notes
  for each row execute function block_edit_delete();

create trigger credit_notes_type_matches_transaction_trigger
  before insert on credit_notes
  for each row execute function credit_notes_type_matches_transaction();
```

**No-over-return** — gantiin `ar_credit_notes_no_over_return`+`ap_credit_notes_no_over_return`
(sebelumnya 2 fungsi hampir identik, cuma beda nama kolom `invoice_id`/`bill_id`) jadi 1:

```sql
create function credit_notes_no_over_return() returns trigger as $$
declare
  v_transaction_amount numeric;
  v_already_returned numeric;
  v_transaction_ref text;
begin
  select amount into v_transaction_amount from transactions where id = new.transaction_id;
  select coalesce(sum(amount), 0) into v_already_returned
    from credit_notes where transaction_id = new.transaction_id;

  if v_already_returned + new.amount > v_transaction_amount then
    select source_ref into v_transaction_ref from transactions where id = new.transaction_id;
    raise exception 'Retur % melebihi nilai transaksi (nilai %, sudah diretur %, coba retur %)',
      v_transaction_ref, v_transaction_amount, v_already_returned, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;
```

Cap ke `transactions.amount` (bukan sisa outstanding) — gak peduli status bayar, sama
perilaku lama.

**Sync status** — gantiin `ar_credit_notes_sync_invoice_status`/`ap_credit_notes_sync_bill_status`,
1 fungsi manggil `recompute_transaction_status(new.transaction_id)`.

## RPC — TETAP 2 fungsi, cuma insert target yang berubah

### RPC `create_ar_credit_note`

`security invoker`, reuse `create_journal_entry` (2x kalau jalur full, 1x kalau
financial-only), gak pernah insert manual ke `journal_entries`/`journal_lines`.

- `p_lines` (nullable/kosong) menentukan jalur: kosong = financial-only (1 jurnal,
  invoice yang gak lewat `create_goods_issue`). Terisi = full (2 jurnal + stok balik) —
  RPC `raise exception` kalau invoice yang dimaksud ternyata gak punya `goods_issues`.
- Nominal jurnal kontra-revenue (`p_amount`) tetap **input eksplisit dari caller**, bukan
  dihitung RPC — konsisten sama `create_transaction` yang juga gak pernah nebak nominal
  uang dari data lain.
- Nominal reversal HPP **dihitung RPC dari snapshot**
  (`goods_issue_lines.total_cost / qty_issued × qty_returned`), bukan input caller — beda
  dari nominal revenue di atas, ini sengaja dikunci server-side biar gak ada celah caller
  masukin cost yang gak sesuai catatan asli.
- Guard "item gak ketemu di goods_issue" dicek eksplisit di RPC (bukan cuma ngandelin
  trigger yang jalan belakangan pas insert `inventory_return_lines`).
- Tiap elemen `p_lines` boleh isi `condition` (`'RESALABLE'` default atau `'DAMAGED'`).
  Loop per baris akumulasi ke 2 total terpisah (`v_total_cost_resalable`/`v_total_cost_damaged`)
  — cuma baris `RESALABLE` yang update `inventory_balances`. Jurnal HPP dibangun
  **dinamis** (`v_hpp_journal_lines`, mulai `'[]'::jsonb`, di-`||` kondisional): debit
  `Persediaan Barang Jadi` cuma muncul kalau ada baris `RESALABLE`, debit param
  `p_loss_expense_account_id` cuma muncul kalau ada baris `DAMAGED`, kredit `HPP` selalu
  1 baris gabungan (`v_total_cost_returned`) — tetap 1 journal entry atomik (bisa 2 atau
  3 baris). `raise exception` kalau ada baris `DAMAGED` tapi `p_loss_expense_account_id`
  gak diisi.
- Deteksi & cairkan excess retur jadi Saldo Kredit Retur Customer (`return-credits-schema.md`)
  — `v_remaining_before := ar_invoice_remaining(p_invoice_id)` ditangkap SEBELUM insert
  credit note. Setelah insert, `v_excess := greatest(0, p_amount - greatest(0, v_remaining_before))`
  — cuma bagian retur yang beneran "kelebihan" dari sisa yang ada, dan kalau invoice udah
  negatif dari retur sebelumnya (`v_remaining_before < 0`), seluruh retur baru ini jadi
  excess. Kalau `v_excess > 0`, jurnal reklasifikasi (`Debit Piutang Usaha / Kredit Saldo
  Kredit Retur Customer`) + insert `return_credits` (`type='INBOUND'`).

```sql
create or replace function create_ar_credit_note(
  p_invoice_id uuid,
  p_credit_note_date date,
  p_source_ref text,
  p_amount numeric,
  p_contra_revenue_account_id uuid,
  p_receivable_account_id uuid,
  p_lines jsonb default null,
  p_hpp_account_id uuid default null,
  p_finished_good_account_id uuid default null,
  p_return_credit_liability_account_id uuid default null,
  p_loss_expense_account_id uuid default null
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_entry_id uuid;
  v_credit_note_id uuid;
  v_goods_issue_id uuid;
  v_line jsonb;
  v_item_id uuid;
  v_qty_returned numeric;
  v_qty_issued numeric;
  v_total_cost numeric;
  v_unit_cost numeric;
  v_line_cost numeric;
  v_condition text;
  v_total_cost_returned numeric := 0;
  v_total_cost_resalable numeric := 0;
  v_total_cost_damaged numeric := 0;
  v_qty_before numeric;
  v_avg_before numeric;
  v_hpp_entry_id uuid;
  v_hpp_journal_lines jsonb := '[]'::jsonb;
  v_return_id uuid;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_costs numeric[] := '{}';
  v_line_conditions text[] := '{}';
  i int;
  v_remaining_before numeric;
  v_excess numeric;
  v_customer_id uuid;
  v_return_credit_entry_id uuid;
  v_line_id uuid;
begin
  select ar_invoice_remaining(p_invoice_id) into v_remaining_before;

  v_entry_id := create_journal_entry(
    p_credit_note_date, 'Retur barang', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_contra_revenue_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_receivable_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into credit_notes (type, transaction_id, credit_note_date, source_ref, amount, journal_entry_id, created_by)
  values ('INBOUND', p_invoice_id, p_credit_note_date, p_source_ref, p_amount, v_entry_id, auth.uid())
  returning id into v_credit_note_id;

  v_excess := greatest(0, p_amount - greatest(0, v_remaining_before));

  if v_excess > 0 then
    if p_return_credit_liability_account_id is null then
      raise exception 'Retur % bikin outstanding invoice jadi minus (excess %) — wajib isi p_return_credit_liability_account_id',
        p_source_ref, v_excess;
    end if;

    select counterparty_id into v_customer_id from transactions where id = p_invoice_id;

    v_return_credit_entry_id := create_journal_entry(
      p_credit_note_date, 'Saldo kredit dari retur', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_receivable_account_id, 'debit', v_excess, 'credit', 0),
        jsonb_build_object('account_id', p_return_credit_liability_account_id, 'debit', 0, 'credit', v_excess)
      )
    );

    insert into return_credits (type, counterparty_id, credit_note_id, amount, journal_entry_id, created_by)
    values ('INBOUND', v_customer_id, v_credit_note_id, v_excess, v_return_credit_entry_id, auth.uid());
  end if;

  if p_lines is not null and jsonb_array_length(p_lines) > 0 then
    select id into v_goods_issue_id from goods_issues where invoice_id = p_invoice_id;

    if v_goods_issue_id is null then
      raise exception 'Invoice % gak punya goods_issue — gak bisa retur stok/HPP', p_invoice_id;
    end if;

    for v_line in select * from jsonb_array_elements(p_lines)
    loop
      v_item_id := (v_line->>'item_id')::uuid;
      v_qty_returned := (v_line->>'qty_returned')::numeric;
      v_condition := coalesce(v_line->>'condition', 'RESALABLE');

      if v_condition not in ('RESALABLE', 'DAMAGED') then
        raise exception 'condition % gak valid -- harus RESALABLE atau DAMAGED', v_condition;
      end if;

      select qty_issued, total_cost into v_qty_issued, v_total_cost
        from goods_issue_lines
        where goods_issue_id = v_goods_issue_id and item_id = v_item_id;

      if not found then
        raise exception 'Item % gak ada di goods_issue %, gak bisa diretur', v_item_id, v_goods_issue_id;
      end if;

      v_unit_cost := v_total_cost / v_qty_issued;
      v_line_cost := v_qty_returned * v_unit_cost;
      v_total_cost_returned := v_total_cost_returned + v_line_cost;

      if v_condition = 'RESALABLE' then
        v_total_cost_resalable := v_total_cost_resalable + v_line_cost;

        select qty_on_hand, avg_cost into v_qty_before, v_avg_before
          from inventory_balances where item_id = v_item_id;

        update inventory_balances
          set qty_on_hand = v_qty_before + v_qty_returned,
              avg_cost = (v_qty_before * v_avg_before + v_qty_returned * v_unit_cost) / (v_qty_before + v_qty_returned),
              updated_at = now()
          where item_id = v_item_id;
      else
        v_total_cost_damaged := v_total_cost_damaged + v_line_cost;
      end if;

      v_line_items := array_append(v_line_items, v_item_id);
      v_line_qtys := array_append(v_line_qtys, v_qty_returned);
      v_line_costs := array_append(v_line_costs, v_line_cost);
      v_line_conditions := array_append(v_line_conditions, v_condition);
    end loop;

    if v_total_cost_damaged > 0 and p_loss_expense_account_id is null then
      raise exception 'Ada baris retur DAMAGED (total cost %) -- wajib isi p_loss_expense_account_id',
        v_total_cost_damaged;
    end if;

    if v_total_cost_resalable > 0 then
      v_hpp_journal_lines := v_hpp_journal_lines ||
        jsonb_build_object('account_id', p_finished_good_account_id, 'debit', v_total_cost_resalable, 'credit', 0);
    end if;

    if v_total_cost_damaged > 0 then
      v_hpp_journal_lines := v_hpp_journal_lines ||
        jsonb_build_object('account_id', p_loss_expense_account_id, 'debit', v_total_cost_damaged, 'credit', 0);
    end if;

    v_hpp_journal_lines := v_hpp_journal_lines ||
      jsonb_build_object('account_id', p_hpp_account_id, 'debit', 0, 'credit', v_total_cost_returned);

    v_hpp_entry_id := create_journal_entry(
      p_credit_note_date, 'Reversal HPP retur', p_source_ref, v_hpp_journal_lines
    );

    insert into inventory_returns (credit_note_id, goods_issue_id, journal_entry_id, return_date, source_ref, created_by)
    values (v_credit_note_id, v_goods_issue_id, v_hpp_entry_id, p_credit_note_date, p_source_ref, auth.uid())
    returning id into v_return_id;

    for i in 1..array_length(v_line_items, 1) loop
      insert into inventory_return_lines (inventory_return_id, item_id, qty_returned, total_cost, condition)
      values (v_return_id, v_line_items[i], v_line_qtys[i], v_line_costs[i], v_line_conditions[i])
      returning id into v_line_id;

      if v_line_conditions[i] = 'RESALABLE' then
        insert into inventory_movements (item_id, movement_date, qty, inventory_return_line_id)
        values (v_line_items[i], p_credit_note_date, v_line_qtys[i], v_line_id);
      end if;
    end loop;
  end if;

  return v_credit_note_id;
end;
$$;
```

### RPC `create_ap_credit_note`

`p_lines` null/kosong → financial-only (1 jurnal, gak nyentuh inventory, `p_amount`
dipakai apa adanya). `p_lines` terisi → full, bill wajib punya `goods_receipt_notes`,
**`p_amount` DIABAIKAN dan DIGANTI** hasil penjumlahan cost fisik tiap baris
(`consume_weighted_average`, dikumpulin ke `v_total_cost_returned` lewat loop yang jalan
DULUAN sebelum jurnal dibikin). **Gak ada akun kontra** — beda dari `create_ar_credit_note`,
karena Persediaan itu akun neraca.

Kenapa `p_amount` diabaikan di jalur full: `create_ar_credit_note` sengaja punya 2 jurnal
beda angka (kontra-revenue di harga jual, reversal HPP di cost) karena emang beda
konsep. `create_ap_credit_note` cuma punya **1 jurnal** yang langsung ngeKredit
Persediaan — nominalnya HARUS sama persis nilai barang yang beneran keluar dari stok,
kalau dibiarkan independen Persediaan di GL bisa menyimpang dari `inventory_balances`
tanpa ketauan trigger mana pun. Konsekuensi urutan kerja: konsumsi stok jalan duluan
(buat tau total cost), baru jurnal + insert `credit_notes` (`type='OUTBOUND'`) + insert
`purchase_return_lines`, baru terakhir hitung excess.

Excess handling: `v_remaining_before` dihitung dari `ap_bill_remaining()` SEBELUM proses
apa pun, `v_excess := greatest(0, v_effective_amount - greatest(0, v_remaining_before))`,
kalau > 0 wajib isi `p_return_credit_asset_account_id` atau `raise exception`.

```sql
create or replace function create_ap_credit_note(
  p_bill_id uuid,
  p_credit_note_date date,
  p_source_ref text,
  p_amount numeric,
  p_payable_account_id uuid,
  p_credit_account_id uuid,
  p_lines jsonb default null,
  p_return_credit_asset_account_id uuid default null
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_remaining_before numeric;
  v_effective_amount numeric;
  v_entry_id uuid;
  v_credit_note_id uuid;
  v_grn_id uuid;
  v_line jsonb;
  v_item_id uuid;
  v_qty_returned numeric;
  v_line_cost numeric;
  v_total_cost_returned numeric := 0;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_costs numeric[] := '{}';
  i int;
  v_excess numeric;
  v_supplier_id uuid;
  v_return_credit_entry_id uuid;
  v_line_id uuid;
begin
  select ap_bill_remaining(p_bill_id) into v_remaining_before;

  if p_lines is not null and jsonb_array_length(p_lines) > 0 then
    select id into v_grn_id from goods_receipt_notes where bill_id = p_bill_id;

    if v_grn_id is null then
      raise exception 'Bill % gak punya goods_receipt_notes -- gak bisa retur stok', p_bill_id;
    end if;

    for v_line in select * from jsonb_array_elements(p_lines)
    loop
      v_item_id := (v_line->>'item_id')::uuid;
      v_qty_returned := (v_line->>'qty_returned')::numeric;

      v_line_cost := consume_weighted_average(v_item_id, v_qty_returned);

      v_line_items := array_append(v_line_items, v_item_id);
      v_line_qtys := array_append(v_line_qtys, v_qty_returned);
      v_line_costs := array_append(v_line_costs, v_line_cost);
      v_total_cost_returned := v_total_cost_returned + v_line_cost;
    end loop;

    v_effective_amount := v_total_cost_returned;
  else
    v_effective_amount := p_amount;
  end if;

  v_entry_id := create_journal_entry(
    p_credit_note_date, 'Retur barang ke supplier', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_payable_account_id, 'debit', v_effective_amount, 'credit', 0),
      jsonb_build_object('account_id', p_credit_account_id, 'debit', 0, 'credit', v_effective_amount)
    )
  );

  insert into credit_notes (type, transaction_id, credit_note_date, source_ref, amount, journal_entry_id, created_by)
  values ('OUTBOUND', p_bill_id, p_credit_note_date, p_source_ref, v_effective_amount, v_entry_id, auth.uid())
  returning id into v_credit_note_id;

  if array_length(v_line_items, 1) is not null then
    for i in 1..array_length(v_line_items, 1) loop
      insert into purchase_return_lines (credit_note_id, item_id, qty_returned, total_cost)
      values (v_credit_note_id, v_line_items[i], v_line_qtys[i], v_line_costs[i])
      returning id into v_line_id;

      insert into inventory_movements (item_id, movement_date, qty, purchase_return_line_id)
      values (v_line_items[i], p_credit_note_date, -v_line_qtys[i], v_line_id);
    end loop;
  end if;

  v_excess := greatest(0, v_effective_amount - greatest(0, v_remaining_before));

  if v_excess > 0 then
    if p_return_credit_asset_account_id is null then
      raise exception 'Retur % bikin Utang Usaha jadi minus (excess %) -- wajib isi p_return_credit_asset_account_id',
        p_source_ref, v_excess;
    end if;

    select counterparty_id into v_supplier_id from transactions where id = p_bill_id;

    v_return_credit_entry_id := create_journal_entry(
      p_credit_note_date, 'Piutang retur dari supplier', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_return_credit_asset_account_id, 'debit', v_excess, 'credit', 0),
        jsonb_build_object('account_id', p_payable_account_id, 'debit', 0, 'credit', v_excess)
      )
    );

    insert into return_credits (type, counterparty_id, credit_note_id, amount, journal_entry_id, created_by)
    values ('OUTBOUND', v_supplier_id, v_credit_note_id, v_excess, v_return_credit_entry_id, auth.uid());
  end if;

  return v_credit_note_id;
end;
$$;
```

Full body kedua RPC: `supabase/migrations/0070_unify_credit_notes_schema.sql` (retarget
insert) — riwayat sebelumnya `0021_ar_credit_notes_schema.sql`/`0015_ar_credit_note_damaged_condition.sql`
(AR), `0035_ap_credit_notes_schema.sql` (AP).

## Fungsi lain yang ikut diretarget (`create or replace`, gak ada perubahan perilaku)

- `ar_invoice_remaining`/`ap_bill_remaining` — reducer #2 (retur) + reducer add-back
  (join `ar_return_credits`/`ap_return_credits`) target `credit_notes`.
- `cancel_ap_bill` — guard credit-note-count target `credit_notes` (`type='OUTBOUND'`).
- `ar_return_credit_refunds_guard`/`ap_return_credit_refunds_guard` — join buat ambil
  `source_ref` (pesan error) target `credit_notes`.
- `ap_return_credits_sync_bill_status`/`ar_return_credits_sync_invoice_status` — lookup
  `transaction_id` (dulu `bill_id`/`invoice_id`) dari `credit_notes`.
- `purchase_return_lines_no_over_return` — lookup `transaction_id` (dulu `bill_id`) dari
  `credit_notes`.
- `purchase_returned_qty`/`sales_returned_qty` — join `credit_notes` + filter
  `type='OUTBOUND'`/`'INBOUND'` (defensif — `purchase_return_lines`/`inventory_return_lines`
  secara struktural cuma pernah diisi lewat RPC AP/AR masing-masing, tapi gak ada
  constraint DB yang maksain itu).
- `warranty_replacements_no_over_reverse`/`warranty_replacements_no_over_settle_return_credit`
  — lookup `amount`/`source_ref` dari `credit_notes`.
- `recompute_transaction_status` — reducer `v_returned` (cabang INBOUND) target
  `credit_notes`. **Kritis dilakukan sebelum drop tabel lama** — pelajaran sama persis
  kayak `payments-schema.md` (fungsi ini `plpgsql`, gak bikin `pg_depend` ke tabel yang
  di-query di body-nya, jadi salah 1 reducer kelewat = drop table lolos diam-diam, meledak
  runtime belakangan).
- **`inventory_movements_with_source` (VIEW, `inventory-ledger-schema.md`)** — join
  `ap_credit_notes` (lewat `purchase_return_lines`) diretarget ke `credit_notes` (filter
  `type='OUTBOUND'`). **Beda dari fungsi plpgsql di atas**: VIEW punya `pg_depend` BENERAN
  ke tabel yang di-select — kalau ini kelewat, `drop table ap_credit_notes` bakal GAGAL
  KERAS (migration abort, bukan lolos diam-diam kayak kasus fungsi) — ketauan
  `schema-reviewer` sebagai blocker sebelum apply.

## RLS Policy & Grant

Pola identik `ar_credit_notes`/`ap_credit_notes` lama — `select` semua `authenticated`,
`insert` cuma `admin`/`accountant`, **gak ada** policy `UPDATE`/`DELETE`.

```sql
alter table credit_notes enable row level security;

create policy credit_notes_select on credit_notes
  for select using (auth.role() = 'authenticated');

create policy credit_notes_insert on credit_notes
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );
-- sengaja gak ada policy UPDATE/DELETE -> RLS default deny

grant select, insert on credit_notes to authenticated;
```

## Dampak frontend

Nested-select alias `ar_credit_notes(...)`/`ap_credit_notes(...)` jadi
`ar_credit_notes:credit_notes(...)`/`ap_credit_notes:credit_notes(...)` (pola sama
`transactions`/`payments`) — JSON key gak berubah, TS type (`lib/ar-invoices/schema.ts`,
`lib/ap-bills/schema.ts`, `lib/ar-return-credits/schema.ts`, `lib/ap-return-credits/schema.ts`)
gak disentuh. Query langsung `.from("ar_credit_notes")`/`.from("ap_credit_notes")` diganti
`.from("credit_notes")` + `.eq("transaction_id", ...)` + `.eq("type", "INBOUND"/"OUTBOUND")`
di 2 file (`ar-invoices/[id]/view.tsx`, `ap-bills/[id]/view.tsx`). RPC call
`create_ar_credit_note`/`create_ap_credit_note` **TIDAK BERUBAH SAMA SEKALI** (nama, param,
signature identik) — keuntungan langsung dari keputusan "RPC tetap 2 fungsi": blast radius
frontend jauh lebih kecil dibanding kalau RPC-nya ikut digabung.
`generateDocumentNumber("ar_credit_notes"/"ap_credit_notes")` TETAP dipanggil apa adanya
(docType string persisten, konvensi project).
