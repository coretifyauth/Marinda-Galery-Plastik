# Chart of Accounts — AI Context

COA = master list of accounts, every other module (GL/AR/AP/etc) references accounts here. Build phase 1.

Naratif lengkap + reasoning penuh: `docs/domain/chart-of-accounts.md`. Struktur module → submodule di file ini SAMA urutannya dengan padanan naratif itu dan dengan `memory/architecture/data/coa-schema.md` (lihat `AGENTS.md` > "Format Baku: Struktur Module → Submodule"). COA cuma punya 1 submodule genuine (Akun Kontra) — sisanya foundational, gak dipecah lagi.

## Konsep Inti

**5 categories + normal_balance**

- Asset: normal_balance=debit (Kas, Piutang, Persediaan, Aset Tetap)
- Liability: normal_balance=credit (Utang Usaha, Utang Bank)
- Equity: normal_balance=credit (Modal, Laba Ditahan)
- Revenue: normal_balance=credit (Pendapatan)
- Expense: normal_balance=debit (Beban, HPP)

Derivation: `Asset = Liability + Equity`, `Equity = Modal + (Revenue - Expense)` → `Asset + Expense = Liability + Modal + Revenue`. Expense/Revenue are temporary sub-ledgers of Equity, closed to Laba Ditahan at period end.

**Fields per account**

- code: string, prefix by category (1xxx asset, 2xxx liability, 3xxx equity, 4xxx revenue, 5xxx expense) — drives report sort order
- category: enum(asset, liability, equity, revenue, expense)
- normal_balance: enum(debit, credit) — derived from category, used to validate postings
- parent_id: self-FK, nullable — hierarchical (e.g. Kas -> Kas Kecil, Kas Bank BCA), enables rollup in reports

**Hierarchical structure (parent-child)**

Accounts form a tree via `parent_id`, arbitrary depth (e.g. Kas -> Kas di Bank -> Bank BCA). Two account roles:
- **header account** — has children, balance = SUM of all descendant leaf balances (rollup), used for summary reporting.
- **leaf/detail account** — no children, the ONLY type that may receive transaction postings.

**Enforcement rule:** reject any journal posting where the target account still has children (i.e. is a header). Must be checked at write time (DB constraint/trigger preferred over app-level, per Supabase RLS-can't-column-lock caveat) — a header receiving direct postings makes rollup ambiguous/double-counted. Trigger itself (`journal_lines_leaf_only`) built at Journal Entry phase (fase 2, needed `journal_lines` to exist first) — full DDL: `memory/architecture/data/journal-entry-schema.md`. Same phase also closed an edge case found while designing GL: a leaf account already posted-to can't silently become a header by adding a new child under it (`accounts_no_retroactive_header`).

**debit/kredit semantics**

Not "cash in/out" — position in double-entry (left=debit, right=credit). Every txn posts >=2 lines, `SUM(debit)=SUM(credit)` invariant (see AGENT.md Core Invariants).

Effect table:
| category | debit | credit |
|---|---|---|
| asset | + | - |
| expense | + | - |
| liability | - | + |
| equity | - | + |
| revenue | - | + |

**Role / RBAC**

- Role pakai lookup table (`roles`), bukan enum — nambah role baru = `INSERT` baris, bukan migration `ALTER TYPE`. 3 role: `admin` (full access + kelola user/role), `accountant` (create/edit transaksi & COA), `viewer` (read-only).
- `user_roles` PK composite `(user_id, role_name)` — 1 user boleh punya >1 role sekaligus.
- Assign role ke user lain lewat aplikasi (screen "User Management") — **belum digarap**, masih manual/lewat service role. Butuh `security definer` function biar gak circular-check (policy INSERT/UPDATE ke `user_roles` yang subquery ke `user_roles` sendiri buat cek "apakah pemanggil admin" = circular). Ref: `memory/scope-debt/user-role-admin-assignment.md`.

**Published-lock**

Field kritikal (`code`, `category`, `normal_balance`, `parent_id`, `is_contra`) sebuah akun terkunci begitu akun itu pernah dipakai di `journal_lines` — mencegah histori laporan lama berubah makna diam-diam. `name`/`archived_at` tetap bebas diubah kapan pun. Derived/ditegakkan via DB trigger (`accounts_published_lock`), BUKAN kolom status — trigger-nya juga baru bisa ditulis pas modul Journal Entry (fase 2) dibangun, karena butuh tabel `journal_lines` yang belum ada di fase 1. Full DDL: `memory/architecture/data/journal-entry-schema.md`.

**Common Mistakes**

- Over-granular accounts (per-branch cash accounts) instead of using a cost-center/department dimension.
- Miscategorized accounts (e.g. Utang Usaha under expense) — corrupts Balance Sheet vs Income Statement.
- Skipping normal_balance check on posting input — allows business-logic-invalid entries even when SUM balances.
- Posting directly to a header account (has children) — makes rollup double-counted/ambiguous. Must post to leaf only.

## Akun Kontra (Contra Account)

**Entitas & Aturan**

Exception to the normal_balance-by-category rule: an account whose `category` follows its parent group, but whose `normal_balance` is **deliberately flipped** from that category's default. The balance direction is still fixed/consistent (not "sometimes debit sometimes credit") — it's just flipped relative to sibling accounts in the same category.

Purpose: hold a **reduction** against a paired account without touching that paired account's balance — preserves gross-value history (auditable "what was the original cost/amount") while still deriving net value (`paired account - contra account`).

| Category | Normal account | Contra account (flipped) | Module |
|---|---|---|---|
| asset (debit) | Aset Tetap | **Akumulasi Penyusutan** (credit) | Fixed Assets |
| asset (debit) | Piutang Usaha | **Cadangan Kerugian Piutang** (credit) — bad debt estimate, AR balance stays legally accurate | AR |
| revenue (credit) | Pendapatan Penjualan | **Retur & Potongan Penjualan** (debit) | AR/AP |

Without a contra account, the paired account gets credited/debited directly and mutates over time — losing the ability to answer "what was the original cost" from the balance alone, and collapsing two distinct facts (gross value, reduction-to-date) into one number.

**Project status**: as of Inventory (phase 5), zero contra accounts exist. `accounts.normal_balance` (`coa-schema.md`) is a rigid generated column (`asset|expense → debit`, no exception) — this structurally prevented anyone from creating a contra account before the design was ready.

Decided in Fixed Assets (phase 6): add `accounts.is_contra boolean default false`, `normal_balance` generated formula branches on it, and `accounts_published_lock` extended to lock `is_contra` too once an account is used. See `memory/domain/fixed-assets.md` + `memory/architecture/data/fixed-assets-schema.md` (migration `0014_fixed_assets_schema.sql`) for DDL + rationale. Migration applied to a live Supabase instance.

**Common Mistakes**

- Crediting/debiting the paired account directly instead of routing through a separate contra account — collapses gross value and reduction-to-date into one number, losing the ability to answer "what was the original amount".
- Treating a contra account as meaningful standalone — it only makes sense read together with its paired account.

## Glossary

- **Account (Akun)**: unit dasar COA — code, name, category, normal_balance (derived), parent_id, archived_at.
- **Header account**: akun yang punya child — cuma boleh nampung saldo rollup, gak boleh diposting langsung.
- **Leaf/detail account**: akun tanpa child — satu-satunya jenis yang boleh diposting transaksi.
- **Normal balance**: arah saldo wajar (debit/kredit) tiap kategori — derived dari `category`, dipakai validasi posting.
- **Contra account**: akun yang kategorinya ikut akun pasangannya tapi normal balance-nya sengaja dibalik — nampung pengurang tanpa nyentuh saldo akun pasangan.
- **Published-lock**: field kritikal akun terkunci begitu akun itu pernah dipakai di jurnal — cegah histori laporan lama berubah makna diam-diam.

Full narrative + worked numeric examples: `docs/domain/chart-of-accounts.md`.
