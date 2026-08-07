# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Start here

Read [AGENTS.md](AGENTS.md) first, every session — it defines the agent persona, teaching flow, docs structure, feature-development rules, tech stack, and core invariants for this ERP project. This CLAUDE.md does not duplicate it.

## Project state

Next.js app scaffolded (App Router, TypeScript strict, Tailwind), Supabase client + Zod + Vitest installed. Project is linked (`supabase link`) to a live Supabase project and has been pushed to it. `supabase/migrations/` holds 8 consolidated schema files (`0001_coa_schema.sql` through `0008_period_closing_schema.sql`), one per module — each represents the current final schema, not incremental history (that lives in `git log`; the original 41 incremental migration files were squashed into these 8). Seed data is COA-only (`0002_seed_coa.sql`) — no demo/story transactional seed data; the business "story" (customers, invoices, etc.) is rebuilt separately as needed, not carried in migrations. Before editing schema: this is a live-linked project now, so **do not edit an already-applied migration file** — add a new migration on top instead (`supabase migration list` shows local-vs-remote status). Check `/memory` before writing any code — it grows organically as modules are built. Read `/memory/brief.md` first for the current map. `/docs` is the separate human-facing knowledge base (narrative domain docs, business story, non-technical ERD docs) — read it when it helps explain business context, but `/memory` is the primary map for agent work.

## Non-negotiable process (from AGENT.md)

1. Explain business/accounting context and teach interactively until the user actually understands — not a one-shot explanation. Only after understanding is reached: write it up in `docs/domain/` + `memory/domain/`, then build `docs/story/`. Never skip to implementation.
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
