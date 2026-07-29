# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Start here

Read [AGENT.md](AGENT.md) first, every session — it defines the agent persona, teaching flow, docs structure, feature-development rules, tech stack, and core invariants for this ERP project. This CLAUDE.md does not duplicate it.

## Project state

Next.js app scaffolded (App Router, TypeScript strict, Tailwind), Supabase client + Zod + Vitest installed. Chart of Accounts migration written at `supabase/migrations/0001_coa_schema.sql`, not yet applied to a live Supabase project (needs `.env.local` from `.env.local.example` + a linked/local Supabase instance). Check `/docs` before writing any code — it grows organically as modules are built. Read `/docs/brief.md` first for the current map.

## Non-negotiable process (from AGENT.md)

1. Explain business/accounting context before writing code — never skip to implementation.
2. Design/update the ERD (entities, relations, FKs, cardinality) before schema.
3. Check impact on existing ERD/modules before changing anything.
4. Order: schema -> API -> UI.

## Core invariants

- Every journal entry: SUM(debit) = SUM(credit).
- No editing posted/closed periods — reversing entries only.
- Every transaction traceable to a source document.
- Money as integer cents or Decimal — never float.

## Tech stack

Next.js (App Router) + TypeScript strict, Supabase (Postgres + Auth + RLS) via `@supabase/supabase-js` — no Prisma, no NextAuth (see `docs/architecture/app/tech-stack-decisions.md`). Zod, Vitest. API routes at `/app/api/[module]/route.ts`. Financial writes wrapped in a Postgres RPC (`supabase.rpc(...)`) — no partial writes.
