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

## App Structure: Monorepo, ERP + POS jadi 2 aplikasi terpisah (2026-08-09)

**Decision:** Begitu modul POS mulai dibangun, repo direstruktur jadi monorepo (npm workspaces) — 2 aplikasi Next.js terpisah: `apps/erp` (aplikasi existing, semua modul admin/akuntansi, sidebar ERPNext-style) dan `apps/pos` (checkout kasir, baru, layout sendiri tanpa admin shell). `supabase/` (migrations) tetap 1 folder di root, dipakai bareng oleh kedua app — **KEDUANYA konek ke Supabase project yang SAMA** (1 database, real-time).

**Why:**
- App POS perlu ramping (bundle kecil, load cepat) buat kasir yang kerja cepat di titik jual — gak numpang di build app admin yang berat (sidebar banyak modul, tabel padat).
- Deployment independen — app POS bisa dideploy/diakses terpisah dari app admin (URL beda), kasir gak perlu buka seluruh app admin cuma buat checkout.
- **Invariant yang TETAP dijaga** (rationale penuh: `memory/domain/pos.md` submodule "Konsep Inti", poin no-oversell): 2 app terpisah itu soal organisasi KODE/deployment doang — datanya TETAP 1 sumber kebenaran tunggal (Supabase project yang sama, real-time, gak ada cache stok lokal permanen di app POS). Kalau data ikut dipisah, itu balik lagi ke risiko oversell yang udah sengaja ditolak.

**Impact on future modules:**
- Migration SQL tetap 1 folder `supabase/migrations/` di root, dipakai kedua app — jangan bikin folder migration per-app.
- Kode yang dipakai 2 app (init Supabase client, Zod schema yang overlap, dst) dipindah ke package bersama (misal `packages/shared`) **kalau nanti kebukti banyak duplikasi** — belum didesain strukturnya sekarang, spekulatif kalau dipaksa duluan.
- Restrukturisasi fisik (pindah `src/` existing ke `apps/erp/`, bikin `apps/pos/` baru) dikerjakan pas POS masuk tahap implementasi (schema→API→UI), bukan di tahap desain/brainstorming.

**Common mistake to avoid:** Bikin app POS akses Supabase project/database BEDA dari app ERP, atau nyimpen cache stok lokal permanen di app POS — dua-duanya ngelanggar invariant no-oversell (checkout POS sengaja gak dibuat offline-capable, keputusan final — `memory/domain/pos.md`).
