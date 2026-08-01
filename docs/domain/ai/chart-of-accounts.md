# COA — AI Context

COA = master list of accounts, every other module (GL/AR/AP/etc) references accounts here. Build phase 1.

## 5 categories + normal_balance

- Asset: normal_balance=debit (Kas, Piutang, Persediaan, Aset Tetap)
- Liability: normal_balance=credit (Utang Usaha, Utang Bank)
- Equity: normal_balance=credit (Modal, Laba Ditahan)
- Revenue: normal_balance=credit (Pendapatan)
- Expense: normal_balance=debit (Beban, HPP)

Derivation: `Asset = Liability + Equity`, `Equity = Modal + (Revenue - Expense)` → `Asset + Expense = Liability + Modal + Revenue`. Expense/Revenue are temporary sub-ledgers of Equity, closed to Laba Ditahan at period end.

## Fields per account (informs future schema)

- code: string, prefix by category (1xxx asset, 2xxx liability, 3xxx equity, 4xxx revenue, 5xxx expense) — drives report sort order
- category: enum(asset, liability, equity, revenue, expense)
- normal_balance: enum(debit, credit) — derived from category, used to validate postings
- parent_id: self-FK, nullable — hierarchical (e.g. Kas -> Kas Kecil, Kas Bank BCA), enables rollup in reports

## Hierarchical structure (parent-child)

Accounts form a tree via `parent_id`, arbitrary depth (e.g. Kas -> Kas di Bank -> Bank BCA). Two account roles:
- **header account** — has children, balance = SUM of all descendant leaf balances (rollup), used for summary reporting.
- **leaf/detail account** — no children, the ONLY type that may receive transaction postings.

**Enforcement rule:** reject any journal posting where the target account still has children (i.e. is a header). Must be checked at write time (DB constraint/trigger preferred over app-level, per Supabase RLS-can't-column-lock caveat already noted in `docs/architecture/data/coa-schema.md`) — a header receiving direct postings makes rollup ambiguous/double-counted.

## debit/kredit semantics

Not "cash in/out" — position in double-entry (left=debit, right=credit). Every txn posts >=2 lines, `SUM(debit)=SUM(credit)` invariant (see AGENT.md Core Invariants).

Effect table:
| category | debit | credit |
|---|---|---|
| asset | + | - |
| expense | + | - |
| liability | - | + |
| equity | - | + |
| revenue | - | + |

## Contra Account

Exception to the normal_balance-by-category rule: an account whose `category` follows its parent group, but whose `normal_balance` is **deliberately flipped** from that category's default. The balance direction is still fixed/consistent (not "sometimes debit sometimes credit") — it's just flipped relative to sibling accounts in the same category.

Purpose: hold a **reduction** against a paired account without touching that paired account's balance — preserves gross-value history (auditable "what was the original cost/amount") while still deriving net value (`paired account - contra account`).

| Category | Normal account | Contra account (flipped) | Module |
|---|---|---|---|
| asset (debit) | Aset Tetap | **Akumulasi Penyusutan** (credit) | Fixed Assets |
| asset (debit) | Piutang Usaha | **Cadangan Kerugian Piutang** (credit) — bad debt estimate, AR balance stays legally accurate | AR (scope debt) |
| revenue (credit) | Pendapatan Penjualan | **Retur & Potongan Penjualan** (debit) | AR/AP (scope debt) |

Without a contra account, the paired account gets credited/debited directly and mutates over time — losing the ability to answer "what was the original cost" from the balance alone, and collapsing two distinct facts (gross value, reduction-to-date) into one number.

Project status: as of Inventory (phase 5), zero contra accounts exist. `accounts.normal_balance` (`coa-schema.md`) is a rigid generated column (`asset|expense → debit`, no exception) — this structurally prevented anyone from creating a contra account before the design was ready.

Decided in Fixed Assets (phase 6): add `accounts.is_contra boolean default false`, `normal_balance` generated formula branches on it. See `docs/domain/ai/fixed-assets.md` + `docs/architecture/data/fixed-assets-schema.md` (migration `0014_fixed_assets_schema.sql`) + `docs/scope-debt/fixed-assets-akun-kontra-asset.md` for DDL + rationale. Migration applied to a live Supabase instance.

## Common mistakes to guard against in validation/UX

- Over-granular accounts (per-branch cash accounts) instead of using a cost-center/department dimension.
- Miscategorized accounts (e.g. Utang Usaha under expense) — corrupts Balance Sheet vs Income Statement.
- Skipping normal_balance check on posting input — allows business-logic-invalid entries even when SUM balances.
- Posting directly to a header account (has children) — makes rollup double-counted/ambiguous. Must post to leaf only.

Full narrative + worked numeric examples: `docs/domain/human/chart-of-accounts.md`.
