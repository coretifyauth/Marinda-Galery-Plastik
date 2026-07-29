# Tech Stack Decisions

## Database + Auth: Supabase (2026-07-29)

**Decision:** Supabase Postgres + Supabase Auth + Row Level Security (RLS). Dropped Prisma and NextAuth from original AGENT.md plan.

**Why:**
- Supabase Auth handles role (admin/accountant/viewer) natively, enforced at DB level via RLS — one less layer vs NextAuth + app-level checks.
- User chose `@supabase/supabase-js` client directly over Prisma — no separate ORM/migration tool, queries go straight through Supabase client.

**Impact on future modules:**
- Every table needs an RLS policy per role from the start — don't ship a table without one, financial data is the whole point of this app.
- Financial writes (journal entries, etc.) need atomicity without Prisma's `$transaction` — use Postgres RPC (stored procedure) called via `supabase.rpc(...)` so multi-row writes (e.g. journal header + lines) commit atomically.
- Schema/migrations: managed via Supabase migrations (SQL files), not Prisma schema — ERD still designed the same way, just written as SQL DDL.
- No Prisma types — need Zod schemas (already planned) to double as the type/validation boundary on both client and server.

**Common mistake to avoid:** Relying on app-level role checks only. Supabase client can be called from browser context, so RLS is the actual security boundary, not the API route.
