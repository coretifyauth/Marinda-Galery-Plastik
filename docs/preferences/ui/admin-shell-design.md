# Admin Shell, List View & Detail View — Design Reference

## Sumber

Supersede reference lama (HRMent card-dashboard style — lihat git history file ini kalau perlu balikin). Acuan sekarang: pola visual & struktural **ERPNext/Frappe desk**, bukan konten HR-nya — pola list-view/detail-view generic-nya yang dipake buat entity kita (Account, Journal Entry, dst).

Kenapa ganti: ERPNext dirancang buat data operasional padat (banyak baris, banyak field, banyak entity terkait) — cocok sama sifat data akuntansi (COA bisa ratusan akun, journal entries ribuan baris). Pola card-dashboard HRMent lebih pas buat data personal (1 staff = 1 halaman rich), bukan buat tabel transaksi.

## 1. App Shell

- **Sidebar kiri persisten, ramping** — logo+nama app di atas. Di bawahnya list modul, tiap modul = 1 baris icon+label, flat (bukan kartu).
- **Grouped by functional area, bukan flat list rata** — begitu jumlah route lebih dari ~5-6, sidebar dikelompokkan pakai section label kecil (`text-xs uppercase text-slate-400`) + 1 icon per grup, **collapsible** — klik label grup toggle expand/collapse (chevron rotate, state di client component, **default semua collapsed** biar sidebar ringkas pas pertama load). Grouping sekarang: **Accounting** (`Calculator` — Chart of Accounts, Journal Entries, General Ledger), **Accounts Receivable** (`Wallet` — Customers, AR Invoices, AR Payments), **Accounts Payable** (`CreditCard` — Suppliers, AP Bills, AP Payments), **Inventory** (`Boxes` — Items, Stock Position, Purchase Orders, Goods Receipts, BOM, Production Orders, Goods Issues). Modul baru masuk grup yang sesuai; kalau gak ada grup yang cocok, bikin grup baru + icon baru — jangan taruh flat di luar grup manapun.
- **Item aktif**: background abu-abu muda (`bg-slate-100`) di baris itu + teks jadi warna aksen/bold — bukan garis vertikal tebal, bukan pill.
- **Top bar tipis** — kiri: breadcrumb (`Module / List / Detail`). Kanan: search global (icon kaca pembesar, expand jadi input), lalu notifikasi, lalu avatar+nama user (dropdown: profile/settings/logout). Top bar TIDAK berat/tinggi — ERPNext top bar cuma ~48-56px, beda dari HRMent yang lebih tebal.
- Breadcrumb selalu ada, bahkan di halaman list (`Accounting / Chart of Accounts`) — bukan cuma muncul di detail page.

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

## Kapan dipakai, kapan enggak

- List view (poin 2): default buat semua index/listing halaman data (`/accounts`, `/journal-entries`).
- Detail/form view (poin 3): dipake buat halaman tambah/edit/lihat 1 entity.
- App shell (poin 1): berlaku di semua halaman tanpa kecuali.
- Landing/dashboard halaman ringkasan (kalau nanti dibikin, misal financial report overview) boleh pakai kartu ringkasan/stat tile — itu bukan list data mentah, jadi gak wajib ikut pola tabel.
