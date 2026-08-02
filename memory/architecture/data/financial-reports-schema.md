# Financial Reports — Schema (Finalized — Read Model, Bukan Tabel Baru)

Fase 7 roadmap. Ref konsep bisnis: `docs/domain/financial-reports.md` + `memory/domain/financial-reports.md`. Ref skenario nyata (angka riil tervalidasi): `docs/story/financial-reports.md`. Ref schema yang dibaca (bukan diubah): `memory/architecture/data/coa-schema.md` (`accounts`), `memory/architecture/data/journal-entry-schema.md` (`journal_entries`+`journal_lines`).

## Keputusan

- **Gak ada tabel baru, gak ada migration baru.** Financial Reports murni read-side — 4 laporan dihitung on-demand dari `accounts`+`journal_entries`+`journal_lines` yang udah ada sejak Fase 1-2. ERD sistem gak berubah dari kondisi setelah `fixed-assets-schema.md`.
- **Bukan RPC, bukan SQL view — fetch baris mentah + reduce di TypeScript**, persis pola yang udah ada di tab Ledger `/accounts/[id]` (`src/app/(app)/accounts/[id]/view.tsx`, query `journal_lines` + reduce di client) dan `/general-ledger`. Bedanya cuma cakupan: Ledger tab query 1 akun, Financial Reports query **semua akun sekaligus** (`journal_lines` join `journal_entries` difilter tanggal, tanpa filter `account_id`) lalu di-`reduce` per `account_id` di kode aplikasi.
  - **PostgREST aggregate select (`debit.sum()`) SENGAJA GAK dipakai** — sempat dicoba, tapi fitur ini gak aktif di project Supabase ini (`db-aggregates-enabled` bukan default, butuh diaktifkan manual di Dashboard project, di luar cakupan migration `.sql`). Dites langsung ke REST API: `GET .../journal_lines?select=account_id,debit.sum(),credit.sum()` balas `400 PGRST123 "Use of aggregate functions is not allowed"`. Daripada gantung ke toggle project-level yang gak keliatan dari kode, pilih pendekatan yang **pasti jalan di semua environment** (fetch+reduce) walau kurang efisien secara query.
  - Kenapa bukan RPC: aturan RPC wajib (`CLAUDE.md`) khusus buat **financial writes** (butuh atomicity, "no partial writes") — ini read-only, gak ada race condition ditulis-baca yang perlu diatomik-kan.
  - Kenapa bukan SQL view: nambah 1 lapis DB object buat sesuatu yang bisa diekspresiin penuh dari query + reduce biasa nambah beban maintenance (perlu migration tiap ganti logic) tanpa manfaat konkret di skala data UMKM ini.
- **`Laba Ditahan` di `computeBalanceSheet` tetap dihitung ulang dari Income Statement, TERLEPAS dari Period Closing sekarang udah ada** (lihat bagian "Period Closing" di bawah) — dan ini justru sengaja gak diubah kodenya, bukan lupa. Begitu suatu periode ditutup lewat `close_period`, closing entry-nya nge-nol-in saldo Revenue/Expense periode itu SUNGGUHAN di `journal_lines` (bukan cuma di laporan) — jadi begitu ada periode yang udah ditutup, sisa saldo Revenue/Expense yang keliatan di Trial Balance kumulatif otomatis cuma representasi periode yang **masih berjalan** (belum ditutup), karena periode-periode sebelumnya udah nol. `computeBalanceSheet` gak perlu tau apakah Period Closing pernah jalan atau enggak — rumus `revenueTotal - expenseTotal` dari Trial Balance kumulatif tetap benar di kedua kondisi (belum pernah ditutup: itu representasi SEMUA histori; udah pernah ditutup: itu otomatis representasi cuma periode terbuka doang). Saldo `3200 Laba Ditahan` yang REAL (dari closing entry yang udah lewat) ikut kehitung otomatis lewat baris akun equity biasa di Trial Balance — gak butuh logic khusus.
- **Income Statement/Cash Flow untuk 1 rentang tanggal spesifik gak kepengaruh Period Closing sama sekali** — keduanya query `journal_lines` yang bertanggal DALAM rentang yang diminta, gak peduli rentang itu "tertutup" atau "terbuka". Period Closing cuma mengunci **entry BARU** yang mau masuk ke rentang yang udah tertutup (lihat bagian "Period Closing" di bawah) — data yang udah ada tetap bisa dilaporkan seperti biasa.
- **Cash Flow butuh 2 kali panggil Trial Balance** (tanggal awal & akhir periode) buat dapetin delta Piutang/Persediaan/Utang — bukan query terpisah, reuse fungsi Trial Balance yang sama dipanggil 2x beda tanggal.

## Query Spec

### 1. Trial Balance — `getTrialBalance(asOfDate: string)`

Fetch semua `accounts` (buat `code`/`name`/`category`/`normal_balance`/`is_contra`/`parent_id`) + semua `journal_lines` yang `journal_entries.entry_date <= asOfDate` (buat `account_id`/`debit`/`credit`), lalu di-reduce per `account_id` di TypeScript.

```ts
const [{ data: accounts }, { data: lines }] = await Promise.all([
  supabase.from("accounts").select("id, code, name, category, normal_balance, is_contra, parent_id"),
  supabase
    .from("journal_lines")
    .select("account_id, debit, credit, journal_entries!inner(entry_date)")
    .lte("journal_entries.entry_date", asOfDate),
]);
// reduce `lines` jadi { [account_id]: { debit_total, credit_total } }, gabung ke `accounts`
```

Saldo per akun: `sum(debit) - sum(credit)` kalau `normal_balance='debit'`, kebalikannya kalau `'credit'` — identik rumus di `docs/domain/financial-reports.md` dan tab Ledger `/accounts/[id]`. Akun header (`parent_id` null yang punya child, mis. `1000 Kas`/`1600 Aset Tetap`) gak pernah punya baris `journal_lines` langsung (leaf-only posting rule sejak Fase 1) — kalau perlu ditampilin sebagai 1 baris gabungan (mis. "Kas" = `1100`+`1200`), itu digabung di layer presentasi, bukan di query.

### 2. Income Statement — `getIncomeStatement(startDate, endDate)`

Filter Trial Balance query di atas ke `entry_date between :start and :end` (bukan `<=`), lalu ambil akun kategori `revenue` dan `expense` doang.

```
Laba Bersih = SUM(saldo akun revenue) - SUM(saldo akun expense)
```

**Exclude baris closing entry** (`fetchClosingJournalEntryIds()` di `period-closing.ts` — semua `period_closings.journal_entry_id` yang gak null) sebelum di-reduce. Tanpa ini, kalau rentang yang di-query persis sama dengan periode yang baru ditutup, baris penolan Revenue/Expense dari closing entry-nya sendiri (bertanggal `end_date` periode itu) ikut kehitung dan membatalkan balik saldo yang baru aja dinolkan — hasilnya 0, bukan angka historis. Ketemu + diperbaiki setelah `close_period` dibangun (kronologi lengkap: `docs/story/financial-reports.md` bagian 5). **Trial Balance SENGAJA gak exclude ini** — TB (poin 1 di atas) butuh efek closing entry biar saldo Revenue/Expense kumulatif emang keliatan udah ke-nol-in, itu justru tujuannya.

### 3. Balance Sheet — `getBalanceSheet(asOfDate)`

1. Panggil `getTrialBalance(asOfDate)`.
2. Panggil `getIncomeStatement(startDate = tanggal transaksi pertama sistem, endDate = asOfDate)` — "sejak awal" karena belum ada Period Closing buat nentuin batas periode berjalan yang jelas.
3. Ambil akun kategori `asset`+`liability`+`equity` dari (1), tambahin 1 baris derived **Laba Ditahan** = Laba Bersih dari (2).
4. Kontra-asset (`is_contra=true`) otomatis udah bersaldo kredit dari generated column `normal_balance` (`coa-schema.md`) — tinggal dikurangkan pas ditampilkan di grup Aset, gak perlu logic khusus lagi.

Validasi wajib: `Total Asset = Total Liability + Total Equity` — kalau meleset, bug ada di query rollup (akun kelewat, atau closing Laba Ditahan lupa disertain), bukan toleransi pembulatan.

### 4. Cash Flow — `getCashFlow(startDate, endDate)` — Indirect Method

1. `getIncomeStatement(startDate, endDate)` → Laba Bersih (titik awal Operating).
2. `getTrialBalance(startDate - 1 hari)` dan `getTrialBalance(endDate)` → ambil saldo `1300 Piutang Usaha`, `1400+1420 Persediaan`, `2100 Utang Usaha` di 2 titik waktu, hitung delta.
3. Beban Penyusutan (`5600`+`5610`, atau lebih umum: semua akun expense yang namanya/flag-nya nunjuk penyusutan — untuk sekarang di-hardcode by account code karena belum ada flag `is_depreciation` di `accounts`, cukup buat skala UMKM ini) di-add-back dari (1).
4. Operating = Laba Bersih + Add-back Penyusutan − ΔPiutang − ΔPersediaan + ΔUtang Usaha.
5. Investing/Financing: **belum ada flag kategori di `journal_entries`/`journal_lines` buat otomatis misahin mana transaksi Investing/Financing** — untuk sekarang di-hardcode dari daftar akun yang diketahui (`2200 Utang Bank` mutasi = Financing, akun `16xx` Aset Tetap kalau nyentuh Kas = Investing). Ini batasan yang didokumentasikan di bagian "Belum termasuk" di bawah, bukan mekanisme generik.
6. Validasi: `Kas Awal (dari TB startDate-1) + Operating + Investing + Financing = Kas Akhir (dari TB endDate)`. Kalau gak cocok, bug di logic adjustment #3-#5, bukan di data Trial Balance (yang selalu benar langsung dari `journal_lines`).

## RLS Policy (Query Spec di atas — Trial Balance/Income Statement/Balance Sheet/Cash Flow)

**Gak ada perubahan.** Query di atas cuma `select` dari `accounts`+`journal_lines`+`journal_entries`, ketiganya udah punya policy `select using (auth.role() = 'authenticated')` sejak `coa-schema.md`/`journal-entry-schema.md`. Financial Reports gak nambah role baru atau pembatasan tambahan — siapa pun yang bisa liat Ledger 1 akun otomatis bisa liat laporan gabungan semua akun (gak ada data lebih sensitif yang kebuka).

## Period Closing — Satu-satunya Bagian Fase 7 yang Beneran Nulis Tabel/Trigger/RPC Baru

Beda dari 4 laporan di atas (murni read), Period Closing itu **financial write** — sesuai `CLAUDE.md`, wajib lewat RPC atomik. Migration: `supabase/migrations/0016_period_closing.sql`. Ref konsep bisnis: `docs/domain/general-ledger.md` bagian "Period Closing", `memory/domain/general-ledger.md`.

### Keputusan

- **Gak ada tabel `periods` dengan status open/closed.** Cukup `period_closings` — ledger append-only rentang tanggal yang UDAH ditutup. "Terbuka" itu konsep negatif: berarti "gak ada baris `period_closings` yang nyakup tanggal itu", bukan state eksplisit yang disimpan.
- **`journal_entry_id` di `period_closings` nullable** — kalau suatu rentang gak punya aktivitas Revenue/Expense sama sekali, gak ada yang perlu di-nol-in, jadi gak ada closing entry, tapi rentangnya tetap bisa dicatat tertutup (biar urutan tetap bersambung).
- **`close_period` RPC hitung saldo Revenue/Expense LANGSUNG dari `journal_lines`, gak percaya angka dari client** — beda dari beberapa RPC lain (mis. `create_ar_invoice` yang terima `amount` dari luar). Alasannya: closing entry ini nge-nol-in BANYAK akun sekaligus secara presisi — kalau angkanya salah/dimanipulasi, akun Revenue/Expense gak beneran ke-nol-in walau entry-nya tetap "balance" secara debit=kredit (karena `journal_lines_balance_check` cuma ngecek total, bukan ngecek "apakah abis ini akun X beneran 0").
- **Urutan insert di dalam RPC penting**: closing entry (lewat `create_journal_entry`) diinsert DULU, baris `period_closings` yang mengunci rentang itu diinsert BELAKANGAN. Trigger baru di `journal_entries` (lihat di bawah) cuma ngecek baris `period_closings` yang UDAH ADA — jadi pas closing entry itu sendiri lagi diproses, rentangnya belum "resmi tertutup" di mata trigger, gak nyangkut ke lock yang lagi dia bikin sendiri.
- **Wajib berurutan & bersambung** (`p_start_date` = `end_date` closing terakhir + 1 hari) — cegah ada gap (rentang yang kelewat, permanen "gak pernah ditutup") atau ditutup gak sesuai urutan waktu.
- **Gak ada jalur "buka lagi" (reopen) periode yang udah ditutup** — sengaja, konsisten sama filosofi "periode yang udah dipegang pihak luar gak boleh diam-diam berubah" (`docs/domain/general-ledger.md`). Kalau ada salah, koreksi lewat entry baru di periode yang SEDANG berjalan, bukan buka kunci periode lama.
- **2 lapis proteksi race condition** (ketauan pas review, awalnya cuma `select ... where` di plpgsql doang — TOCTOU race: 2 pemanggilan `close_period` konkuren bisa sama-sama lolos cek overlap sebelum salah satu commit): (1) `pg_advisory_xact_lock` di awal `close_period` — serialize semua pemanggilan closing lintas transaksi; (2) `exclude using gist (daterange(...) with &&)` di tabel `period_closings` — jaring kedua di level DATABASE, overlap gak mungkin ke-`INSERT` sama sekali terlepas dari race apapun di app. Pola sama kayak immutability "2 lapis" (RLS+trigger) di modul lain. Risiko residual yang SENGAJA belum ditutup: entry biasa (bukan closing) yang nyelip pas window sempit antara SELECT saldo dan commit `period_closings` — butuh `SERIALIZABLE` buat nutup penuh, belum ada preseden itu di project ini.

### DDL

```sql
create table period_closings (
  id uuid primary key default gen_random_uuid(),
  start_date date not null,
  end_date date not null check (end_date >= start_date),
  journal_entry_id uuid references journal_entries(id),
  source_ref text not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index period_closings_range_idx on period_closings(start_date, end_date);

create extension if not exists btree_gist;

alter table period_closings add constraint period_closings_no_overlap
  exclude using gist (daterange(start_date, end_date, '[]') with &&);
```

### Trigger — `journal_entries_block_retroactive_into_closed_period`

Tolak entry baru yang `entry_date`-nya jatuh di rentang yang udah tertutup. Sengaja cuma `BEFORE INSERT` (bukan `UPDATE` — `journal_entries` emang udah gak bisa di-`UPDATE` sama sekali sejak `block_edit_delete` di `journal-entry-schema.md`).

```sql
create function journal_entries_block_retroactive_into_closed_period() returns trigger as $$
begin
  if exists (
    select 1 from period_closings
    where new.entry_date between start_date and end_date
  ) then
    raise exception 'Tanggal % sudah masuk periode yang ditutup — catat transaksi ini dengan tanggal periode yang sedang berjalan, bukan tanggal lama', new.entry_date;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger journal_entries_block_retroactive_into_closed_period_trigger
  before insert on journal_entries
  for each row execute function journal_entries_block_retroactive_into_closed_period();
```

### RPC — `close_period(p_start_date, p_end_date, p_retained_earnings_account_id, p_source_ref)`

Alur: (1) validasi `end_date >= start_date`, gak overlap, kontigu ke closing terakhir; (2) validasi akun tujuan kategori `equity`; (3) `SELECT account_id, SUM(debit)-SUM(credit) as net ... GROUP BY account_id HAVING <> 0` buat semua akun `revenue`/`expense` yang punya aktivitas dalam rentang; (4) tiap akun dengan `net > 0` (saldo debit bersih) di-kredit sebesar itu buat di-nol-in, `net < 0` (saldo kredit bersih) di-debit; (5) selisih total debit-kredit dari langkah 4 = Laba Bersih periode itu — dipindah ke akun ekuitas tujuan (kredit kalau laba, debit kalau rugi); (6) kalau ada baris sama sekali, panggil `create_journal_entry` yang udah ada (reuse balance-check & atomicity-nya); (7) insert baris `period_closings`.

Full SQL: `supabase/migrations/0016_period_closing.sql` (gak diduplikasi di sini biar gak ada 2 sumber kebenaran — file migration itu sendiri udah banyak komentar humanable per langkah).

### RLS Policy (`period_closings`)

Pola identik `journal_entries`: `select` terbuka `authenticated`, `insert` cuma `admin`/`accountant`, gak ada `update`/`delete` (RLS default deny + reuse trigger `block_edit_delete()` dari `journal-entry-schema.md` sebagai jaring kedua).

```sql
alter table period_closings enable row level security;

create policy period_closings_select on period_closings
  for select using (auth.role() = 'authenticated');

create policy period_closings_insert on period_closings
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

create trigger period_closings_block_edit_delete
  before update or delete on period_closings
  for each row execute function block_edit_delete();

grant select, insert on period_closings to authenticated;
```

## Belum termasuk (dependency / di luar scope fase ini)

Detail lengkap: `memory/scope-debt/` dan `docs/domain/financial-reports.md` bagian "Belum termasuk".

- **Reopen periode yang udah ditutup** — sengaja gak ada (lihat "Keputusan" di atas), tapi berarti kesalahan closing (mis. salah pilih akun ekuitas tujuan) gak bisa "dibatalkan" — cuma bisa dikoreksi lewat entry baru di periode berjalan, gak beneran menghapus efeknya di histori.
- **UI buat preview closing entry sebelum submit** — `close_period` langsung eksekusi, belum ada langkah "lihat dulu draft-nya" di level RPC (bisa di-preview dari UI dengan manggil `getIncomeStatement` buat rentang yang sama sebelum submit, tapi itu 2 pemanggilan terpisah, gak dijamin data belum berubah di antaranya).
- **Direct Method Cash Flow** — butuh kolom kategori kas per baris `journal_lines` (dari pelanggan/ke supplier/dst), gak ada mekanismenya sekarang.
- **Flag kategori Investing/Financing yang generik** — poin 5 di Query Spec Cash Flow di atas masih hardcode by account code, bukan derive otomatis dari struktur data. Kalau akun baru kategori serupa ditambah (misal utang jangka panjang lain), daftar hardcode ini harus diupdate manual.
- **Performance rollup di skala besar** — `memory/scope-debt/trial-balance-rollup.md` **masih terbuka**, bukan tertutup oleh keputusan di atas. Fetch+reduce di TypeScript narik SEMUA baris `journal_lines` yang relevan ke aplikasi (bukan agregat di sisi DB) — aman di skala UMKM ini (puluhan-ratusan baris), tapi kalau nanti volume data naik jauh (ribuan+ baris per query), perlu direvisit: entah aktifkan `db-aggregates-enabled` di Supabase Dashboard (di luar migration), atau bikin materialized view/RPC agregat khusus.
