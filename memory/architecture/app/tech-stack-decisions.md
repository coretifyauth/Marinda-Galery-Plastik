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

## Data-fetching POS: TanStack React Query v5 (2026-08-16)

**Decision:** `apps/pos` (cuma `apps/pos`, BELUM diterapkan ke `apps/erp`) pindah dari fetch manual (`useState`+`useEffect`+`supabase.from(...).select(...)` langsung di `page.tsx`) ke `@tanstack/react-query`. Dipicu masalah nyata: `loadCatalog()` (6 query dibundel jadi 1 — items+accounts+customers+pos_charge_types+tax_settings+company_settings) di-refetch PENUH setiap kali checkout sukses, padahal cuma stok beberapa item yang berubah.

**Kenapa aman buat invariant no-oversell** (lihat section App Structure di atas — POS gak boleh punya cache stok lokal PERMANEN): validasi stok cukup/tidak TETAP 100% terjadi server-side di RPC `create_pos_sale` (SECURITY DEFINER, cek `inventory_balances` sebelum nulis) — React Query cuma ganti cara ANGKA STOK YANG DITAMPILKAN ke kasir disimpen & di-refresh, bukan cara checkout divalidasi. Cache `items` dikasih `staleTime: 15_000` (bukan `Infinity`) + `refetchOnWindowFocus` default (aktif) — sengaja gak dibuat "permanen".

**Pola yang dipakai** (`apps/pos/src/app/page.tsx`):
- 6 query lepas (`useQuery` per tabel: `items`/`accounts`/`customers`/`pos_charge_types`/`tax_settings`/`company_settings`), masing-masing `staleTime` beda — panjang (10 menit) buat data yang jarang berubah (akun, kategori biaya, pajak, nama toko), pendek (15 detik) buat `items` (stok). `pos_sales` (riwayat transaksi) query terpisah, key ikut tanggal dipilih (`["pos_sales", historyDate]`) — ganti tanggal di drawer otomatis refetch.
- Checkout jadi `useMutation` (`create_pos_sale` RPC). `onSuccess`-nya **nge-patch cache `items` langsung** (`queryClient.setQueryData` — kurangin `qty_on_hand` item yang baru kejual) instead of refetch ulang seluruh katalog, plus `invalidateQueries(["pos_sales", <tanggal hari ini>])` biar riwayat transaksi ke-refresh.
- `QueryClient` dibuat di `apps/pos/src/lib/query-provider.tsx` (client component, `useState` sekali per tab), dibungkus di `layout.tsx`. **Devtools SENGAJA gak dipasang** — app POS harus ramping (poin di atas), gak worth nambah bundle buat tool dev doang.

**Impact on future modules:**
- Kalau `apps/erp` (banyak halaman, beda dari POS yang cuma 2 route) mau ikut React Query, manfaat utamanya beda — di ERP manfaat "cache kepake lagi lintas halaman" baru relevan (di POS ini nyaris gak kepake, POS cuma dapet manfaat dari granular invalidation + retry). Evaluasi ulang, jangan asumsikan keputusan ini otomatis berlaku sama di ERP.
- Query key konvensi: nama tabel Postgres apa adanya (`["items"]`, bukan `["catalog"]` dsb) — biar gampang dilacak balik ke query aslinya.

**Common mistake to avoid:** Naikin `staleTime` query `items` jadi panjang/`Infinity` demi "biar gak sering refetch" — ini yang justru ngelanggar invariant no-oversell tampilan (server tetap nolak oversell, tapi kasir bisa keliatan stok yang udah lama basi). Kalau butuh stok lebih real-time lagi (lintas kasir/terminal), pertimbangkan Supabase Realtime subscription yang push ke cache ini — BUKAN naikin staleTime.

## Data-fetching ERP (pilot: Journal Entries) — server-side pagination + filter + React Query (2026-08-16)

**Decision:** `apps/erp` mulai ikut React Query juga — beda alasan dari POS di atas. Masalah nyata di ERP BUKAN cache-patching (satu halaman, checkout cepat), tapi: (1) semua halaman list narik SELURUH tabel ke browser tanpa `.range()`/`.limit()` lalu filter/hitung di JS, gak scale kalau data makin banyak, dan (2) gak ada cara filter buat nemuin data pas volume udah besar. Journal Entries (`apps/erp/src/app/(app)/journal-entries/page.tsx`) jadi PILOT dulu sebelum pola ini diterapkan ke modul lain — belum semua modul ERP ikut pola ini, cuma Journal Entries.

**Pola yang dipakai:**
- Filter (date range `entry_date` via `.gte()`/`.lte()`, search teks PER KOLOM — `description` dan `source_ref` masing-masing via `.ilike()` sendiri, AND bukan OR) dan pagination (`.range()` + `{ count: "exact" }`, page size user-adjustable) semua terjadi DI QUERY SUPABASE, bukan di JS setelah fetch penuh. Lihat `apps/erp/src/lib/journal-entries/queries.ts` (`fetchJournalEntries`, `useJournalEntries`, `PAGE_SIZE_OPTIONS`).
- Filter UI-nya BUKAN bar terpisah di atas tabel — dipindah jadi baris kecil langsung di bawah judul kolom (`<thead>` baris ke-2: date-range di bawah "Tanggal", search box masing-masing di bawah "Deskripsi" dan "Source Ref"). Keputusan (2026-08-16): karena search per kolom (bukan 1 search box lintas kolom), tiap kolom yang punya filter dapet input sendiri persis di bawah judulnya — bukan digabung/di-span. Kalau nanti ada modul dengan filter bertipe select (mis. status AR invoice), taruh dropdown-nya di kolom yang sama caranya, bukan bikin bar filter terpisah lagi.
- Input filter di header pakai class compact lokal (`compactFilterInputClass` di `page.tsx`) bukan komponen `Input`/`Select` bersama — versi biasa kegedean buat muat di `<th>`. Kalau pola ini kepake di modul lain, pertimbangkan naikin jadi komponen bersama BARU KALAU udah kepake di >1 modul (belum sekarang, masih 1 modul).
- Search input di-debounce (`apps/erp/src/lib/hooks/use-debounced-value.ts`, generik, dipakai ulang — dipanggil 2x, satu per kolom yang bisa dicari) sebelum masuk ke query key — biar gak fetch tiap ketikan.
- Query key = kombinasi filter (`["journal_entries", { dateFrom, dateTo, descriptionSearch, sourceRefSearch, page, pageSize }]`) + `placeholderData: keepPreviousData` — ganti halaman/filter/page-size gak bikin tabel kedip kosong.
- Ganti filter ATAU page-size apa pun reset `page` ke 0. Dilakukan pas RENDER (bandingin `filterKey` vs `prevFilterKey`, `setState` kalau beda), BUKAN di `useEffect` — `setState` sinkron di dalam effect body kena lint `react-hooks/set-state-in-effect` (App Router/React versi ini udah strict soal ini, lihat pola "adjust state during render" di react.dev).
- Create (`create_journal_entry` RPC) jadi `useMutation`, `onSuccess`-nya `invalidateQueries(["journal_entries"])` — bukan manual reload kayak pola lama.
- UI pagination di `apps/erp/src/components/ui/pagination.tsx` (Prev/Next + label "Halaman X dari Y · N total" + dropdown page-size opsional lewat prop `pageSizeOptions`/`onPageSizeChange`) — generik, dipakai ulang buat modul lain nanti.
- Index DB baru: `journal_entries_entry_date_idx` (`supabase/migrations/0029_journal_entries_filter_index.sql`) — tabel ini sebelumnya gak punya index sama sekali, dibutuhin buat sort/filter `entry_date` di skala besar.

**Impact on future modules:**
- Rencana: pola ini digulirkan ke SEMUA modul ERP (customers, ar-invoices, ap-bills, dst), Journal Entries cuma yang pertama buat validasi pola. Tiap modul bikin `lib/<modul>/queries.ts` sendiri (fetcher + `useQuery` hook) dengan bentuk yang sama, reuse `use-debounced-value.ts` + `pagination.tsx`, dan filter UI-nya nempel di judul kolom (bukan bar terpisah) — search per kolom (bukan 1 search box lintas kolom) dan filter select taruh di kolom yang relevan.
- `count: "exact"` di Supabase/Postgres bisa lambat kalau tabel udah jutaan baris — belum jadi masalah sekarang, tapi kalau nanti kerasa lambat, ganti ke `count: "estimated"`/`"planned"` atau cursor-based pagination, JANGAN cuma dibiarin.
- ILIKE search sengaja BELUM dikasih index (`pg_trgm`/GIN) — data masih kecil. Kalau search mulai kerasa lambat di modul mana pun, itu saatnya nambah trigram index, bukan sebelumnya (spekulatif kalau dipaksa duluan).
- Session/role-check (`supabase.auth.getSession()` + query `user_roles`) di tiap halaman SENGAJA belum di-dedup jadi shared hook — itu concern auth terpisah dari fetch/pagination, di luar scope perubahan ini.

**Common mistake to avoid:** Nambahin filter/pagination di level JS (fetch semua lalu `.filter()`/`.slice()` di client) — itu balik lagi ke masalah awal (semua data tetap kedownload). Filter/pagination HARUS di query Supabase (`.gte()`/`.lte()`/`.ilike()`/`.range()`), React Query cuma lapisan cache di atasnya.

**Beda kasus, jangan disamakan: pagination (di atas) vs agregat/saldo.** Pola pagination ini nyelesain "jangan kirim ribuan baris ke LAYAR" — dia gak nyelesain "hitung TOTAL/SALDO yang benar dari ribuan baris" (mis. saldo akun dari `journal_lines`). Buat kebutuhan kedua, pagination di UI gak membantu sama sekali — client cuma liat 1 halaman, tapi kalau totalnya dihitung dengan fetch-semua-lalu-reduce di JS (bukan `SUM()` di database), dia tetap harus narik SEMUA baris di baliknya, dan itu kena resiko `max_rows` PostgREST (`supabase/config.toml`) — begitu baris yang di-scan lewat batas itu, hasilnya diam-diam salah tanpa error. Ini sudah kejadian nyata di laporan keuangan (Trial Balance/Balance Sheet/General Ledger) — **sudah diperbaiki 2026-08-17**, checklist deteksi generik buat pola ini ada di bagian bawah.

**Cara kenali pola ini di modul APA PUN ke depannya**: kalau nemu query Supabase ke tabel yang isinya tumbuh terus seiring waktu (append-only/ledger-style — bukan cuma `journal_lines`), TANPA `.range()`, DAN hasilnya di-`reduce()`/dijumlahin manual di TypeScript buat dapetin 1 angka total/saldo — itu kandidat kena `max_rows` silent truncation. Solusinya BUKAN pagination (gak relevan buat agregat), tapi pindahin `SUM(...) GROUP BY` ke Postgres RPC (pola yang sudah dipakai `close_period`, `supabase/migrations/0008_period_closing_schema.sql` — hitung ulang saldo langsung di server, bukan percaya angka dari client).

## Agregat/saldo dari tabel append-only: RPC read-only, BUKAN PostgREST aggregate toggle (2026-08-17)

**Decision:** Konvensi baku buat SELAMANYA (bukan cuma `journal_lines`, berlaku ke tabel append-only/ledger-style apa pun ke depannya — kandidat: riwayat stok granular, riwayat pembayaran granular, dst): kalau butuh SUM/total/saldo dari tabel yang isinya tumbuh terus, itu WAJIB Postgres RPC read-only (`SUM(...) GROUP BY ... `, hidup di `supabase/migrations/*.sql`) — bukan (a) fetch-semua-lalu-reduce di TypeScript, dan bukan (b) nyalain fitur `db-aggregates-enabled` PostgREST lalu pakai aggregate-select (`?select=col.sum()`) langsung dari client.

**Kenapa RPC, bukan toggle `db-aggregates-enabled`** (dites ulang 2026-08-17, fitur ini masih OFF di project — balas `PGRST123`):
- Toggle itu state di Supabase Dashboard, BUKAN di kode/migration — gak ke-track git, gak ke-review, gak otomatis ke-apply kalau project di-reset/dibuat ulang/dikloning ke environment baru. RPC di `supabase/migrations/` otomatis ikut ter-apply di mana pun project ini di-provision.
- RPC bisa terima parameter (`asOfDate`, `startDate`/`endDate`, dst) dan encode business rule di SQL-nya sendiri (mis. exclude closing entry buat Income Statement) — aggregate-select PostgREST cuma bisa nge-group/sum apa adanya, gak ada tempat nyisipin logic tambahan.
- Konsisten sama pola yang udah dipakai buat SEMUA hal yang harus benar (bukan cuma ditampilkan): `close_period` (write, SECURITY DEFINER), `create_pos_sale` (write, validasi stok server-side) — RPC read-only buat agregat saldo ngikutin filosofi yang sama: jangan percaya angka dihitung di client buat apa pun yang harus akurat secara finansial.

**Impact on future modules:** modul baru mana pun yang butuh saldo/total dari tabel ledger-style HARUS mulai dari RPC ini sejak awal, JANGAN fetch+reduce dulu "karena datanya masih dikit" — itu persis kesalahan yang bikin `journal_lines` numpuk debt serupa dulu (sudah diperbaiki 2026-08-17, lihat `memory/architecture/data/financial-reports-schema.md`). Kalau butuh RPC generik yang reusable lintas modul (bukan 1 RPC per laporan), desain signature-nya nerima nama tabel/filter secara parametrized — TAPI itu baru dikerjakan pas ada kebutuhan RPC kedua/ketiga (belum sekarang, `journal_lines` masih 1 kandidat).

**Common mistake to avoid:** Nyalain `db-aggregates-enabled` di Dashboard sebagai jalan pintas. Kelihatannya lebih sedikit kode (ganti `.select()` doang, gak perlu migration baru), tapi nyimpen dependency ke setting yang invisible dari kode — orang lain (atau kamu sendiri nanti) gak akan tau ini harus dinyalain manual sampai fiturnya tiba-tiba error di environment baru.
