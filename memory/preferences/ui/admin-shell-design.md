# Admin Shell, List View & Detail View — Design Reference

## Sumber

Supersede reference lama (HRMent card-dashboard style — lihat git history file ini kalau perlu balikin). Acuan sekarang: pola visual & struktural **ERPNext/Frappe desk**, bukan konten HR-nya — pola list-view/detail-view generic-nya yang dipake buat entity kita (Account, Journal Entry, dst).

Kenapa ganti: ERPNext dirancang buat data operasional padat (banyak baris, banyak field, banyak entity terkait) — cocok sama sifat data akuntansi (COA bisa ratusan akun, journal entries ribuan baris). Pola card-dashboard HRMent lebih pas buat data personal (1 staff = 1 halaman rich), bukan buat tabel transaksi.

## 1. App Shell

- **Sidebar kiri persisten, ramping** — logo+nama app di atas. Di bawahnya list modul, tiap modul = 1 baris icon+label, flat (bukan kartu).
- **Grouped by functional area, bukan flat list rata** — begitu jumlah route lebih dari ~5-6, sidebar dikelompokkan pakai section label kecil (`text-xs uppercase text-slate-400`) + 1 icon per grup, **collapsible** — klik label grup toggle expand/collapse (chevron rotate, state di client component, **default semua collapsed** biar sidebar ringkas pas pertama load). Grouping sekarang: **Accounting** (`Calculator` — Chart of Accounts, Journal Entries, General Ledger), **Accounts Receivable** (`Wallet` — Customers, AR Invoices, AR Payments), **Accounts Payable** (`CreditCard` — Suppliers, AP Bills, AP Payments), **Inventory** (`Boxes` — Items, Stock Position, Purchase Orders, Goods Receipts, BOM, Production Orders, Goods Issues). Modul baru masuk grup yang sesuai; kalau gak ada grup yang cocok, bikin grup baru + icon baru — jangan taruh flat di luar grup manapun.
- **Item aktif**: background abu-abu muda (`bg-slate-100`) di baris itu + teks jadi warna aksen/bold — bukan garis vertikal tebal, bukan pill.
- **Top bar tipis** — kiri: breadcrumb (`Module / List / Detail`). Kanan: search global (icon kaca pembesar, expand jadi input), lalu **Documentation** (icon `BookOpen`, link ke `/docs`), lalu notifikasi, lalu avatar+nama user (dropdown: profile/settings/logout). Top bar TIDAK berat/tinggi — ERPNext top bar cuma ~48-56px, beda dari HRMent yang lebih tebal.
- **Sidebar khusus modul bisnis/akuntansi (Domain Roadmap), bukan tempat untuk link meta/utility.** `/docs` (knowledge base) sengaja TIDAK masuk sidebar — itu bukan modul transaksional, dan sidebar-nya udah didesain buat data operasional (poin di atas). Link semacam ini ("Documentation", nanti mungkin "Help"/"Settings" kalau ada) hidup di top bar kanan, persis di kiri icon notifikasi — pola yang sama dipakai kalau ada link meta lain ke depannya, biar sidebar tetap murni daftar modul.
- Breadcrumb selalu ada, bahkan di halaman list (`Accounting / Chart of Accounts`) — bukan cuma muncul di detail page.
- **Sidebar posisi fixed terhadap viewport — gak boleh ikut ke-scroll pas konten discroll.** Implementasi: shell terluar `h-screen overflow-hidden` (bukan `min-h-screen`), sidebar-nya sendiri `h-screen overflow-y-auto` (biar list nav-nya sendiri yang scroll internal kalau kepanjangan, bukan seluruh halaman), dan kolom konten (`main`) yang dapet `overflow-y-auto` buat scroll independen. Pola ini berlaku di app shell utama (`(app)/layout.tsx` + `sidebar.tsx`) DAN di shell dokumentasi (`docs-shell.tsx` + `doc-explorer.tsx`) — dua-duanya butuh treatment yang sama karena struktur sidebar+konten-scrollable-nya identik.

## 2. List View — pola default buat semua data tabular

Ini pola utama ERPNext, dipake di HAMPIR SEMUA index halaman kita (`/accounts`, `/journal-entries`), gantiin pola card-grid lama.

- **Toolbar tipis nempel langsung di atas tabel** (bukan di atas page): kiri judul list ("Chart of Accounts") + count badge (jumlah row), kanan sederet tombol kecil — `+ New` (primary, paling menonjol), Filter, Sort, Refresh, kolom-visibility (opsional). Semua tombol kecil (`text-sm`, padding tipis), bukan tombol besar.
- **Filter sidebar kiri** (di dalam content area, bukan app sidebar) — opsional, muncul kalau user klik "Filter" atau kalau list-nya emang butuh (COA butuh filter by category/normal_balance). Kolom sempit (~200px), isi checkbox/dropdown per field yang bisa difilter.
- **Tabel padat**: baris pendek (`py-2`, bukan `py-4`), font `text-sm`, border cuma horizontal antar baris (`border-b border-slate-100`) — TIDAK ada border vertikal antar kolom, TIDAK ada shadow per-row. Header kolom: `text-xs font-medium text-slate-500 uppercase`, background sedikit beda (`bg-slate-50`), sticky waktu scroll.
- **Checkbox kolom pertama** tiap baris (buat bulk-select/bulk-action) — konsisten di semua list view, walau belum ada bulk action jalan (siapin strukturnya).
- **Klik baris (bukan icon) navigasi ke detail** — seluruh row clickable, hover kasih `bg-slate-50`.
- **Pagination/infinite scroll** di bawah tabel, bukan di tengah page — kompak, cuma "Load more" atau angka halaman kecil di kanan bawah.
- List view TIDAK pakai kartu putih rounded per baris data (beda dari pola lama) — datanya tabel murni di dalam 1 container putih besar.

## 3. Detail/Form View — pola buat 1 entity (Account detail, Journal Entry form)

- **Header row di atas** (di luar body form): breadcrumb + judul entity (nama/kode akun) + tombol aksi kanan atas (`Save`, `Delete`/`Cancel`, status badge kalau ada seperti "Published"/"Draft").
- **Body form**: field disusun 2 kolom per baris (label kecil abu-abu di atas, input/value di bawah), TAPI tanpa dipecah jadi banyak kartu kecil terpisah — 1 form section polos dalam 1 container putih, dipisah cuma pakai divider/spacing antar grup field, bukan card border+shadow tiap grup.
- Field yang locked/published (lihat `state-naming-convention.md`) ditampilkan read-only dengan style abu-abu + ikon gembok kecil, bukan disembunyikan.
- Untuk entity yang punya banyak related data (Journal Entry -> journal lines), related data ditampilkan sebagai **tabel editable inline di bawah form utama** (child table pattern ERPNext) — bukan tab terpisah, karena datanya bagian tak terpisah dari transaksi itu sendiri (harus keliatan bareng pas review balance debit=credit).
- Tab horizontal cuma dipake kalau entity punya sub-view yang BENERAN independen & jarang diliat bareng (contoh: Account detail bisa punya tab "Ledger" buat lihat histori transaksi akun itu, terpisah dari tab "Details" form utamanya) — bukan default buat semua detail page.

## Detail Page — ATURAN WAJIB (bukan lagi case-by-case)

**Keputusan user (per percakapan sesi ini, supersede catatan "dipicu kebutuhan riil" versi lama):** tiap tabel yang punya child/related table (1-ke-banyak — invoice punya payment+retur+DP, deposit punya application+forfeiture, journal entry punya lines, dst) **wajib** punya halaman detail `[id]`, dan **aksi transaksional apa pun** terhadap baris itu (retur, batalkan, terapkan, hanguskan, posting, dsb) **wajib hidup di halaman detail itu**, bukan inline di row list. Ini sekarang default buat entity baru — bukan sesuatu yang ditunggu sampai "kerasa butuh".

Entity yang **sudah** ikut aturan ini penuh (8, termasuk aksi transaksional pindah ke detail): `/accounts/[id]`, `/customers/[id]`, `/suppliers/[id]`, `/items/[id]`, `/ar-invoices/[id]`, `/ar-deposits/[id]`.

**Utang retrofit** (`memory/scope-debt/ui-detail-page-retrofit.md`) — list-nya masih murni tabel row tanpa detail page, padahal tabelnya punya children:
- `/journal-entries` (child: `journal_lines`)
- `/ar-payments` (child: `ar_payment_allocations`)
- `/ap-bills`, `/ap-payments` (child: `ap_payment_allocations` dst, mirror AR)
- `/purchase-orders` (child: `purchase_order_lines`), `/goods-receipts` (child: `goods_receipt_lines`), `/production-orders` (child: `production_order_lines`), `/bom` (child: `bom_lines`), `/goods-issues` (child: `goods_issue_lines`)

Fixed-assets (`/fixed-assets/[id]`) itu pengecualian lama yang **belum** dirapikan ke pola baru — detail page-nya udah ada tapi cuma read-only histori, aksi "Posting Penyusutan" masih nyangkut di row list `/fixed-assets` (kategori gap beda dari daftar di atas: bukan "belum ada detail page", tapi "detail page ada, aksinya belum dipindah ke situ"). Dicatat di scope-debt yang sama.

- **Pola implementasi**: tiap route `[id]` punya `page.tsx` (Server Component tipis, cuma `await params` — Next 16 `params` selalu `Promise` di Page component) yang render `view.tsx` (Client Component, isi logic query+UI-nya, nerima `id` sebagai prop biasa). Bukan bikin 1 file client langsung baca `params` via `use()`.
- **Row klik navigasi** ditambahkan di halaman list yang punya detail page (poin 2 di atas, "Klik baris navigasi ke detail") — seluruh `<tr>` clickable, TIDAK ada lagi tombol aksi apa pun di row list begitu detail page-nya ada (beda dari pola lama `fixed-assets` yang masih nyimpen "Posting Penyusutan" di row — itu pola LAMA yang sekarang dianggap gak sesuai aturan).
- **Tab cuma dipake di `/accounts/[id]`** (Detail + Ledger) — karena histori jurnal 1 akun beneran independen dari form detailnya & jarang diliat bareng. Entity lain **gak pakai tab** — related data ditampilkan sebagai tabel bertumpuk langsung di bawah header, karena datanya emang lazim diliat bareng buat ngerti relasi.
- **Semua aksi transaksional (retur, batalkan, terapkan, hanguskan, posting, dst) hidup DI detail page** — row list jadi murni browse-only, gak ada tombol aksi apa pun di row-nya. `/ar-invoices/[id]` (Retur, Batalkan) adalah contoh pertama yang udah bener sesuai aturan ini.
- **Breadcrumb rute dinamis**: `Topbar` (`src/components/topbar.tsx`) di-generalize — kalau `pathname` gak match persis `routeLabels`, dicek prefix (mis. `/accounts/abc-123` cocok prefix `/accounts`) lalu breadcrumb jadi `[Label List, "Detail"]`. Gak fetch nama entity di topbar (topbar komponen global, gak punya akses ke data halaman) — breadcrumb generic "Detail" cukup, nama entity udah ada di `<h1>` halaman itu sendiri.

## Kapan dipakai, kapan enggak

- List view (poin 2): default buat semua index/listing halaman data (`/accounts`, `/journal-entries`) — TAPI kalau tabelnya punya children, row list gak boleh punya tombol aksi, cuma klik-ke-detail.
- Detail/form view (poin 3): wajib buat tabel yang punya child/related table (lihat aturan wajib di atas). Aksi transaksional selalu di sini.
- App shell (poin 1): berlaku di semua halaman tanpa kecuali.
- Landing/dashboard halaman ringkasan (kalau nanti dibikin, misal financial report overview) boleh pakai kartu ringkasan/stat tile — itu bukan list data mentah, jadi gak wajib ikut pola tabel.
