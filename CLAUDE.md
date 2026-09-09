# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Start here

Read [AGENTS.md](AGENTS.md) first, every session — it defines the agent persona, teaching flow, docs structure, feature-development rules, tech stack, and core invariants for this ERP project. This CLAUDE.md does not duplicate it.

## Project state

Next.js app scaffolded (App Router, TypeScript strict, Tailwind), Supabase client + Zod + Vitest installed. Project is linked (`supabase link`) to a live Supabase project and has been pushed to it. `supabase/migrations/` holds 25 consolidated schema files (`0001_extensions_and_shared_functions.sql` through `0025_financial_reports_schema.sql`), one per spine table/concept (mirrors `docs/architecture/*.md` 1:1, each of which links to its migration pair) — each represents the current final schema, not incremental history (that lives in `git log`; the original 84 incremental migration files were squashed into these 25, 2026-09-07). Seed data is structural-config-only (Chart of Accounts in `0002_coa_schema.sql`, `document_number_types`, `default_account_settings`, `fixed_asset_account_presets`, `roles`, `pos_settings`+"Pelanggan Umum" fallback counterparty) — no demo/story transactional seed data; the business "story" (customers, invoices, items, etc.) is rebuilt separately as needed, not carried in migrations. Before editing schema: this is a live-linked project now, so **do not edit an already-applied migration file** — add a new migration on top instead (`supabase migration list` shows local-vs-remote status). Check `/docs` before writing any code (business/domain knowledge + schema ERD — the single source of truth as of 2026-09-08, read by Claude and the user alike) and `/memory` (agent process: preferences, mental-model rules, scope-debt/special-case ledgers — no narrative content lives here anymore). Read `docs/brief.md` and `memory/brief.md` first for the current map of each. For exact DDL/RPC syntax, read the actual `supabase/migrations/*.sql` file — it's the only copy Postgres enforces, so it's ground truth over any doc.

## Non-negotiable process (from AGENT.md)

1. Explain business/accounting context and teach interactively until the user actually understands — not a one-shot explanation. Only after understanding is reached: write it up in `docs/domain/`. Never skip to implementation.
2. Design/update the ERD (entities, relations, FKs, cardinality) before schema.
3. Check impact on existing ERD/modules before changing anything.
4. Order: schema -> API -> UI.

## Core invariants

- Every journal entry: SUM(debit) = SUM(credit).
- No editing posted/closed periods — reversing entries only.
- Every transaction traceable to a source document.
- Money as integer cents or Decimal — never float.

## Tech stack

Next.js (App Router) + TypeScript strict, Supabase (Postgres + Auth + RLS) via `@supabase/supabase-js` — no Prisma, no NextAuth (see `memory/architecture/app/tech-stack-decisions.md`). Zod, Vitest. API routes at `/app/api/[module]/route.ts`. Financial writes wrapped in a Postgres RPC (`supabase.rpc(...)`) — no partial writes.
