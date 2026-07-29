# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Start here

Read [AGENT.md](AGENT.md) first, every session — it defines the agent persona, teaching flow, docs structure, feature-development rules, tech stack, and core invariants for this ERP project. This CLAUDE.md does not duplicate it.

## Project state

No code scaffolded yet (`modules/` is empty, no `package.json`). Before writing any code, check whether `/docs` exists yet — AGENT.md says it grows organically as modules are built, not pre-scaffolded. If `/docs/brief.md` exists, read it first for the current map of `/docs`.

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

## Tech stack (once scaffolded)

Next.js (App Router) + TypeScript strict, PostgreSQL + Prisma, Zod, NextAuth (if roles needed), Vitest/Jest. API routes at `/app/api/[module]/route.ts`. Financial writes wrapped in Prisma `$transaction` — no partial writes.
