# Financial Reports — AI Context

Read-only aggregation layer over `journal_lines` (no new tables for the 4 reports, no new transactions). Answers "what's the business state now" vs prior modules which answered "what happened". 4 reports + Period Closing (the one write-side piece), strict dependency order.

Naratif lengkap + reasoning penuh: `docs/domain/financial-reports.md`. Struktur module → submodule di file ini SAMA urutannya dengan padanan naratif itu dan dengan `memory/architecture/data/financial-reports-schema.md` (lihat `AGENTS.md` > "Format Baku: Struktur Module → Submodule").

## Konsep Inti

**Read layer & sumber data**
- Semua 4 laporan baca (Trial Balance, Income Statement, Balance Sheet, Cash Flow) fetch baris mentah dari `accounts`+`journal_entries`+`journal_lines` (sudah ada sejak Fase 1-2) lalu di-`reduce` di TypeScript — bukan RPC, bukan SQL view. ERD sistem gak berubah dari kondisi setelah `fixed-assets-schema.md` buat 4 laporan ini.
- `ar_invoice_remaining()`-style sentralisasi TIDAK relevan di sini — gak ada guard/reducer, murni agregasi baca.

**Urutan wajib penyusunan** (dependency)
```
1. Trial Balance (aggregate, 1 point in time)
2. Income Statement (Revenue/Expense from TB)
3. Balance Sheet (Asset/Liability/Equity; Equity needs step 2's Laba Bersih closed into Laba Ditahan)
4. Cash Flow (needs step 2's Laba Bersih AS STARTING POINT, + 2 Trial Balances — period start & end — for AR/Inventory/AP deltas)
```
Cash Flow is the only report needing data from 2 points in time, not 1.

**Validation philosophy** — kalau data-nya real (double-entry selalu balance), semua laporan turunan PASTI konsisten satu sama lain. Ketauan gak konsisten = bug di logic laporan turunan, bukan di data mentah `journal_lines` (yang selalu benar langsung).

**Worked example** (1 period, fully validated end-to-end, angka ilustrasi generik)

Opening: Kas 10.000.000, Modal Pemilik 10.000.000. 7 transactions: (1) buy fixed asset 15.000.000 via Utang Bank direct (non-cash), (2) buy inventory 3.000.000 half cash/half AP, (3) sell 8.000.000 half cash/half AR, (4) COGS 2.000.000 on that sale, (5) pay salary 1.500.000 cash, (6) depreciation 250.000, (7) pay down AP 500.000 cash.

Trial Balance (end): Kas 10.500.000, Piutang 4.000.000, Persediaan 1.000.000, Aset Tetap 15.000.000, HPP 2.000.000, Beban Gaji 1.500.000, Beban Penyusutan 250.000 (debit side, total 34.250.000) = Akumulasi Penyusutan 250.000, Utang Usaha 1.000.000, Utang Bank 15.000.000, Modal 10.000.000, Pendapatan 8.000.000 (credit side, total 34.250.000). Balances.

Income Statement: `8.000.000 - 2.000.000 - 1.500.000 - 250.000 = 4.250.000` Laba Bersih.

Balance Sheet: Asset `10.500.000+4.000.000+1.000.000+15.000.000-250.000=30.250.000` = Liability `1.000.000+15.000.000=16.000.000` + Equity `10.000.000+4.250.000(Laba Ditahan)=14.250.000` → `30.250.000=30.250.000`. Balances.

Cash Flow (indirect): Operating = `4.250.000+250.000-4.000.000(ΔAR)+1.000.000(ΔAP)-1.000.000(ΔInv) = 500.000`. Investing=0, Financing=0 (fixed asset acquisition never touched Kas). Kenaikan Kas = 500.000.

Validation: `Kas Awal 10.000.000 + 500.000 = 10.500.000` = Kas balance in Trial Balance (10.500.000). Match.

## Trial Balance

All accounts + balance at 1 point in time, `SUM(debit)=SUM(credit)` total (Core Invariant, enforced since phase 2 via `journal_lines_balance_check`). Per-account balance: `SUM(debit)-SUM(credit)` if `normal_balance=debit`, inverse if credit — same logic as `/accounts/[id]` Ledger tab. Feeds both Income Statement and Balance Sheet from ONE source, not computed twice.

**Constraints**
- Trial Balance total debit = total credit exactly, no rounding tolerance.

**Common Mistakes**
- Treating Balance Sheet/Trial Balance imbalance as acceptable rounding — it's always a bug.

## Income Statement

Revenue + Expense accounts from Trial Balance, for a date RANGE (resets each period, matching principle). `Laba Bersih = Total Revenue - Total Expense`.

**Exclude baris closing entry** (`fetchClosingJournalEntryIds()` di `period-closing.ts` — semua `period_closings.journal_entry_id` yang gak null) sebelum di-reduce. Tanpa ini, kalau rentang yang di-query persis sama dengan periode yang baru ditutup, baris penolan Revenue/Expense dari closing entry-nya sendiri (bertanggal `end_date` periode itu) ikut kehitung dan membatalkan balik saldo yang baru aja dinolkan — hasilnya 0, bukan angka historis. Ketemu + diperbaiki setelah `close_period` dibangun. **Trial Balance SENGAJA gak exclude ini** — TB butuh efek closing entry biar saldo Revenue/Expense kumulatif emang keliatan udah ke-nol-in, itu justru tujuannya.

**Constraints**
- Income Statement = date range; Balance Sheet = single date. Never interchange.

**Common Mistakes**
- Treating Income Statement as a snapshot instead of a date range.

## Balance Sheet

Asset + Liability + Equity accounts. `Asset = Liability + Equity` (always holds if `journal_lines` always balanced — this is the double-entry guarantee surfacing at report level). **Equity = Modal Pemilik + Laba Ditahan**, where Laba Ditahan requires the Income Statement's Laba Bersih via a **closing entry** — Balance Sheet cannot be computed before Income Statement. Contra-asset (Akumulasi Penyusutan) MUST be subtracted from Aset Tetap, not shown at gross cost.

**`Laba Ditahan` di `computeBalanceSheet` tetap dihitung ulang dari Income Statement, TERLEPAS dari Period Closing sekarang udah ada** — dan ini sengaja gak diubah kodenya, bukan lupa (detail penuh: `memory/architecture/data/financial-reports-schema.md` bagian "Balance Sheet").

**Constraints**
- Laba Bersih must be closed to Laba Ditahan before Balance Sheet is computed.
- Contra-asset (Akumulasi Penyusutan) always subtracted from Aset Tetap in Balance Sheet.

**Common Mistakes**
- Omitting contra-asset accounts from Balance Sheet (overstates Aset Tetap).
- Skipping the Laba Bersih → Laba Ditahan closing step.

## Cash Flow Statement

Accrual (Income Statement/Balance Sheet) vs cash (this report) are different lenses — high Laba Bersih ≠ high cash (e.g. uncollected AR). 3 sections: Operating, Investing, Financing.

**Indirect method** (chosen for this project): start from Laba Bersih, adjust:
```
Laba Bersih
+ Depreciation (non-cash, add-back)
- ΔPiutang (AR increase = revenue recognized but cash not yet received)
+ ΔUtang Usaha (AP increase = expense recognized but cash not yet paid)
- ΔPersediaan (cash paid for inventory, not yet expensed)
= Kas Bersih Operating
```
**Direct method**: build from raw cash categories (cash received from customers, cash paid to suppliers) instead of starting from Laba Bersih — same final number, different path. Depreciation never appears in Direct method (never a cash transaction to begin with) — proof that the Indirect method's add-back is a correction of the *starting point*, not a statement that depreciation "doesn't count." **Not implemented** — needs per-`journal_lines`-row cash categorization, no such column exists in schema now.

**Why Indirect chosen**: all inputs (Laba Bersih, AR/Inventory/AP deltas) already exist from the other 3 reports — zero extra schema.

**Non-cash investing/financing**: if an asset is acquired directly against a liability (no Kas account touched at all — e.g. `Debit Mobil Pickup Antar Barang / Kredit Utang Bank`, zero cash lines), both Investing and Financing show 0 for that event. Not a bug — disclosed as a supplemental non-cash footnote per accounting standards, never hidden.

**Investing vs Financing grouping is still hardcoded by account code** (`2200 Utang Bank` mutation = Financing, `16xx` Aset Tetap accounts touching Kas = Investing) — no generic category flag on `journal_entries`/`journal_lines` yet. If a new liability-type account is added later, this hardcoded list needs manual update.

**Validation** (not the same as the build input): comparing 2 Trial Balances (start vs end) is the **input material** for building Cash Flow (getting AR/Inventory/AP deltas) — not the validation method. **Actual validation**: computed ending cash balance from Cash Flow MUST exactly equal the Kas account balance in the CURRENT period's Trial Balance (a fact, directly `SUM(debit)-SUM(credit)` on the Kas account, no estimation involved).
```
Beginning Cash (prior period TB) + Operating + Investing + Financing = Computed Ending Cash
                    MUST EQUAL
Kas account balance in current Trial Balance (ground truth)
```
If mismatch: the bug is in the Cash Flow adjustment logic (wrong sign, missed delta), never in the Trial Balance data.

**Constraints**
- Cash Flow ending balance must reconcile to current Trial Balance's Kas account.

**Common Mistakes**
- Equating Cash Flow with Income Statement (profit ≠ cash).
- Assuming asset purchases always hit Investing — non-cash-financed acquisitions show 0 there, disclosed separately.
- Forgetting the depreciation add-back in Indirect method (understates Operating cash).
- Flipping the sign on AR/Inventory increases (should subtract) vs AP increases (should add).
- Confusing "compare 2 Trial Balances" (build step) with "validate Cash Flow" (reconcile ending cash to current TB's Kas account).

## Tutup Buku (Period Closing)

Deferred from phase 2 to phase 7 — needs Income Statement to know the definitive Laba Bersih to close.

**Real problem**: banks request reports for a SPECIFIC period ("Laba Rugi Juli 2026") and make lending decisions off that exact number. If a late-discovered transaction (e.g. a missed July receipt) is allowed to post retroactively into July after that report was already handed to the bank, Laba Bersih silently changes — the bank never knows the number it decided on has shifted. Different from reversing entries (phase 2, `general-ledger.md` constraint #4) — those are *visible* corrections in the history; this is about a period already "sealed" and handed to an external party, which must never silently change.

**Secondary problem**: without resetting Revenue/Expense each period, the owner can't compare month-to-month performance (numbers accumulate since company founding) to decide things like raising prices or switching suppliers.

**Mechanism** (detail: `general-ledger.md`): RPC `close_period(start_date, end_date, retained_earnings_account_id, source_ref)` — hitung ulang saldo Revenue/Expense periode itu langsung dari `journal_lines`, nol-in via closing entry ke `create_journal_entry` yang udah ada, catat rentangnya di `period_closings` (ledger append-only, bukan tabel "periode" dengan status). Trigger baru di `journal_entries` nolak entry baru yang bertanggal masuk ke rentang tertutup. Wajib berurutan-bersambung, gak ada reopen.

**Rekomendasi cadence buat skala UMKM**: hard close tahunan, bukan bulanan — selaras SPT Tahunan pajak + momen lapor ke bank, minim risiko transaksi telat kejebak. Review bulanan cukup pakai `getIncomeStatement` biasa (soft, gak dikunci). Detail + contoh angka pemecahan periode 2025 vs 2026: `docs/domain/general-ledger.md` bagian "Best Practice buat Skala UMKM" dan "Contoh — Kenapa Pemecahan Periode Penting".

**Belum ada UI preview closing entry sebelum submit** — `close_period` langsung eksekusi, belum ada langkah "lihat dulu draft-nya" di level RPC (bisa disimulasikan dari UI dengan manggil `getIncomeStatement` buat rentang yang sama sebelum submit, tapi itu 2 pemanggilan terpisah, gak dijamin data belum berubah di antaranya).

**Constraints**
- Periode harus ditutup berurutan & bersambung (`p_start_date` = `end_date` closing terakhir + 1 hari) — no gap, no out-of-order.
- Gak ada jalur reopen — sengaja, konsisten sama filosofi "periode yang udah dipegang pihak luar gak boleh diam-diam berubah".
- Rentang tanpa aktivitas Revenue/Expense tetap bisa ditutup (`journal_entry_id` nullable) — biar urutan tetap bersambung.

**Common Mistakes**
- Membolehkan `journal_entries` baru bertanggal masuk ke rentang yang udah tertutup — harus ditolak trigger sebelum sempat tercatat.
- Menerima nominal Revenue/Expense dari client buat closing entry — `close_period` wajib hitung ulang sendiri dari `journal_lines`, gak percaya angka dari luar.
- Menganggap performance rollup di skala besar udah dioptimasi — fetch+reduce di TypeScript narik SEMUA baris `journal_lines` relevan ke aplikasi (bukan agregat di sisi DB), aman di skala UMKM tapi belum direvisit buat volume data jauh lebih besar — **sudah diperbaiki 2026-08-17**, sekarang agregat/pagination DB-side (RPC `SUM...GROUP BY`), termasuk General Ledger & tab Ledger akun. Detail: `memory/architecture/data/financial-reports-schema.md`.

## Glossary

- **Trial Balance**: daftar semua akun + saldo di 1 titik waktu, fondasi Income Statement dan Balance Sheet.
- **Income Statement**: Pendapatan − Beban buat 1 rentang tanggal, hasilnya Laba Bersih.
- **Balance Sheet**: Asset = Liability + Equity di 1 titik waktu, Equity termasuk Laba Ditahan hasil closing.
- **Cash Flow Statement**: pergerakan kas fisik (Operating/Investing/Financing), Metode Tidak Langsung mulai dari Laba Bersih.
- **Period Closing / Tutup Buku**: nolkan saldo Revenue/Expense 1 rentang ke Laba Ditahan + kunci rentang itu dari transaksi baru — satu-satunya bagian modul ini yang menulis data.
