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

## Common mistakes to guard against in validation/UX

- Over-granular accounts (per-branch cash accounts) instead of using a cost-center/department dimension.
- Miscategorized accounts (e.g. Utang Usaha under expense) — corrupts Balance Sheet vs Income Statement.
- Skipping normal_balance check on posting input — allows business-logic-invalid entries even when SUM balances.
- Posting directly to a header account (has children) — makes rollup double-counted/ambiguous. Must post to leaf only.

Full narrative + worked numeric examples: `docs/domain/human/chart-of-accounts.md`.
