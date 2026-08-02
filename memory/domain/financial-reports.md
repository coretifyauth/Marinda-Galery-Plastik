# Financial Reports — AI Context

Read-only aggregation layer over `journal_lines` (no new tables, no new transactions). Answers "what's the business state now" vs prior modules which answered "what happened". 4 reports, strict dependency order.

## 1. Trial Balance — foundation

All accounts + balance at 1 point in time, `SUM(debit)=SUM(credit)` total (Core Invariant, enforced since phase 2 via `journal_lines_balance_check`). Per-account balance: `SUM(debit)-SUM(credit)` if normal_balance=debit, inverse if credit — same logic as `/accounts/[id]` Ledger tab. Feeds both Income Statement and Balance Sheet from ONE source, not computed twice.

## 2. Income Statement — period range, not snapshot

Revenue + Expense accounts from Trial Balance, for a date RANGE (resets each period, matching principle). `Laba Bersih = Total Revenue - Total Expense`.

## 3. Balance Sheet — snapshot at 1 date

Asset + Liability + Equity accounts. `Asset = Liability + Equity` (always holds if journal_lines always balanced — this is the double-entry guarantee surfacing at report level). **Equity = Modal Pemilik + Laba Ditahan**, where Laba Ditahan requires the Income Statement's Laba Bersih via a **closing entry** — Balance Sheet cannot be computed before Income Statement. Contra-asset (Akumulasi Penyusutan) MUST be subtracted from Aset Tetap, not shown at gross cost.

## 4. Cash Flow — physical cash movement only, needs 2 Trial Balances

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
**Direct method**: build from raw cash categories (cash received from customers, cash paid to suppliers) instead of starting from Laba Bersih — same final number, different path. Depreciation never appears in Direct method (never a cash transaction to begin with) — proof that the Indirect method's add-back is a correction of the *starting point*, not a statement that depreciation "doesn't count."

**Why Indirect chosen**: all inputs (Laba Bersih, AR/Inventory/AP deltas) already exist from the other 3 reports — zero extra schema. Direct method needs per-`journal_lines`-row cash categorization (no such column exists).

**Non-cash investing/financing**: if an asset is acquired directly against a liability (no Kas account touched at all — see actual seed `0015_seed_demo_fixed_assets.sql`: `Debit Peralatan Oven / Kredit Utang Bank`, zero cash lines), both Investing and Financing show 0 for that event. Not a bug — disclosed as a supplemental non-cash footnote per accounting standards, never hidden.

## 5. Period Closing — business context (mechanics already in `general-ledger.md`)

Deferred from phase 2 to phase 7 — needs Income Statement to know the definitive Laba Bersih to close.

**Real problem**: banks request reports for a SPECIFIC period ("Laba Rugi Juli 2026") and make lending decisions off that exact number. If a late-discovered transaction (e.g. a missed July receipt) is allowed to post retroactively into July after that report was already handed to the bank, Laba Bersih silently changes — the bank never knows the number it decided on has shifted. Different from reversing entries (phase 2, `general-ledger.md` constraint #4) — those are *visible* corrections in the history; this is about a period already "sealed" and handed to an external party, which must never silently change.

**Secondary problem**: without resetting Revenue/Expense each period, Bu Nur can't compare month-to-month performance (numbers accumulate since 2023, company founding — `docs/story/company-profile.md`) to decide things like raising bread prices or switching suppliers.

**Mechanism** (detail: `general-ledger.md`): (1) close Revenue/Expense balances into Laba Ditahan (Equity, permanent), reset to 0; (2) lock the period — late transactions post dated into the CURRENT open period, never retroactively into a closed one.

## Build order (strict dependency)

```
1. Trial Balance (aggregate, 1 point in time)
2. Income Statement (Revenue/Expense from TB)
3. Balance Sheet (Asset/Liability/Equity; Equity needs step 2's Laba Bersih closed into Laba Ditahan)
4. Cash Flow (needs step 2's Laba Bersih AS STARTING POINT, + 2 Trial Balances — period start & end — for AR/Inventory/AP deltas)
```

Cash Flow is the only report needing data from 2 points in time, not 1.

## Validation (not the same as the build input)

Comparing 2 Trial Balances (start vs end) is the **input material** for building Cash Flow (getting AR/Inventory/AP deltas) — not the validation method.

**Actual validation**: computed ending cash balance from Cash Flow MUST exactly equal the Kas account balance in the CURRENT period's Trial Balance (a fact, directly `SUM(debit)-SUM(credit)` on the Kas account, no estimation involved).
```
Beginning Cash (prior period TB) + Operating + Investing + Financing = Computed Ending Cash
                    MUST EQUAL
Kas account balance in current Trial Balance (ground truth)
```
If mismatch: the bug is in the Cash Flow adjustment logic (wrong sign, missed delta), never in the Trial Balance data.

## Worked example (1 period, fully validated end-to-end)

Opening: Kas 10.000.000, Modal Pemilik 10.000.000. 7 transactions: (1) buy oven 15.000.000 via Utang Bank direct (non-cash), (2) buy inventory 3.000.000 half cash/half AP, (3) sell 8.000.000 half cash/half AR, (4) COGS 2.000.000 on that sale, (5) pay salary 1.500.000 cash, (6) depreciation 250.000, (7) pay down AP 500.000 cash.

Trial Balance (end): Kas 10.500.000, Piutang 4.000.000, Persediaan 1.000.000, Aset Tetap 15.000.000, HPP 2.000.000, Beban Gaji 1.500.000, Beban Penyusutan 250.000 (debit side, total 34.250.000) = Akumulasi Penyusutan 250.000, Utang Usaha 1.000.000, Utang Bank 15.000.000, Modal 10.000.000, Pendapatan 8.000.000 (credit side, total 34.250.000). Balances.

Income Statement: `8.000.000 - 2.000.000 - 1.500.000 - 250.000 = 4.250.000` Laba Bersih.

Balance Sheet: Asset `10.500.000+4.000.000+1.000.000+15.000.000-250.000=30.250.000` = Liability `1.000.000+15.000.000=16.000.000` + Equity `10.000.000+4.250.000(Laba Ditahan)=14.250.000` → `30.250.000=30.250.000`. Balances.

Cash Flow (indirect): Operating = `4.250.000+250.000-4.000.000(ΔAR)+1.000.000(ΔAP)-1.000.000(ΔInv) = 500.000`. Investing=0, Financing=0 (oven acquisition never touched Kas). Kenaikan Kas = 500.000.

Validation: `Kas Awal 10.000.000 + 500.000 = 10.500.000` = Kas balance in Trial Balance (10.500.000). Match.

## Constraints

- Trial Balance total debit = total credit exactly, no rounding tolerance.
- Income Statement = date range; Balance Sheet = single date. Never interchange.
- Laba Bersih must be closed to Laba Ditahan before Balance Sheet is computed.
- Contra-asset (Akumulasi Penyusutan) always subtracted from Aset Tetap in Balance Sheet.
- Cash Flow ending balance must reconcile to current Trial Balance's Kas account.

## Common mistakes to guard against

- Treating Balance Sheet imbalance as acceptable rounding — it's always a bug.
- Omitting contra-asset accounts from Balance Sheet (overstates Aset Tetap).
- Treating Income Statement as a snapshot instead of a date range.
- Skipping the Laba Bersih → Laba Ditahan closing step.
- Equating Cash Flow with Income Statement (profit ≠ cash).
- Assuming asset purchases always hit Investing — non-cash-financed acquisitions show 0 there, disclosed separately.
- Forgetting the depreciation add-back in Indirect method (understates Operating cash).
- Flipping the sign on AR/Inventory increases (should subtract) vs AP increases (should add).
- Confusing "compare 2 Trial Balances" (build step) with "validate Cash Flow" (reconcile ending cash to current TB's Kas account).

## Period Closing — dibangun (`0016_period_closing.sql`)

RPC `close_period(start_date, end_date, retained_earnings_account_id, source_ref)`: hitung ulang saldo Revenue/Expense periode itu langsung dari `journal_lines`, nol-in via closing entry ke `create_journal_entry` yang udah ada, catat rentangnya di `period_closings` (ledger append-only, bukan tabel "periode" dengan status). Trigger baru di `journal_entries` nolak entry baru yang bertanggal masuk ke rentang tertutup. Wajib berurutan-bersambung, gak ada reopen. Detail teknis: `memory/architecture/data/financial-reports-schema.md` bagian "Period Closing".

**Rekomendasi cadence buat skala UMKM (CV Roti Barokah)**: hard close tahunan, bukan bulanan — selaras SPT Tahunan pajak + momen lapor ke bank, minim risiko transaksi telat kejebak. Review bulanan cukup pakai `getIncomeStatement` biasa (soft, gak dikunci). Detail + contoh angka pemecahan periode 2025 vs 2026: `docs/domain/general-ledger.md` bagian "Best Practice buat Skala UMKM" dan "Contoh — Kenapa Pemecahan Periode Penting".

## Belum termasuk (di luar scope fase ini)

Direct Method Cash Flow (needs per-line cash categorization, no schema for it), Trial Balance rollup performance at scale (`memory/scope-debt/trial-balance-rollup.md`).

Naratif lengkap + reasoning penuh: `docs/domain/financial-reports.md`.
