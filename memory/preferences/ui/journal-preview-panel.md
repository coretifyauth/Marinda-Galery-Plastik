# Akun Jurnal Otomatis: Panel Ringkasan di Atas Form, Bukan Field Tersebar

Diputuskan 2026-08-13 (preferensi user). Berlaku di semua form/modal yang punya field akun terkunci (`<LockedAccountField>`) — 12 file: `ap-bills`, `ap-deposits`, `ar-deposits`, `ar-invoices`, `goods-issues`, `goods-receipts`, `items`, `production-orders`, `sales-orders`, `stock-opnames` (page + `[id]/view` sesuai yang punya).

## Kenapa

`<LockedAccountField>` (baca akun dari `default_account_settings`, gak bisa dipilih user) sebelumnya dirender sebagai box read-only per akun, tersebar di antara field yang benar-benar diisi user (tanggal, nominal, dll) di dalam grid form. Ini bikin user harus memilah mana field yang perlu diisi dan mana yang cuma informasi — dan info "jurnal apa yang bakal kejadian" jadi kepotong-potong, gak ada satu tempat buat lihat gambaran lengkap sebelum submit.

## Pola Baru

1. **`<LockedAccountField>` (`src/components/ui/locked-account-field.tsx`) sekarang cuma render `<input type="hidden">`** — gak ada UI visible sama sekali (gak ada label, gak ada box, gak ada warning inline). Props (`label`, `htmlFor`, `resolved`) gak berubah — cuma `label` sekarang gak dipakai buat render (dibiarin ada di signature, bukan cleanup task terpisah).
2. **`<JournalPreviewPanel>` (`src/components/ui/journal-preview-panel.tsx`, baru)** — satu panel abu-abu (`border-slate-200 bg-slate-50`), judul kecil "Jurnal yang Terlibat". Ditaruh **di atas `<form>`**, biasanya tepat setelah paragraf deskripsi modal (`<p className="mb-4 ...">`), sebelum grid field yang diisi user.
3. **`<LockedAccountField>` yang lama TETAP dipanggil di posisi lamanya di dalam grid form** (gak dihapus/dipindah) — sekarang otomatis invisible karena poin 1, jadi gak perlu ubah struktur grid/key React. Data buat `<JournalPreviewPanel>` diduplikasi manual di atas form (bukan dikumpulin otomatis lewat context) — trade-off sengaja, ngehindarin kerumitan two-pass render cuma buat ~2-6 baris data per form.

## Format baris — niru gaya tulisan jurnal akuntansi manual (2026-08-13, revisi 2)

Props panel `groups: (leg[] | falsy)[]` — **array per JURNAL TERPISAH**, bukan array leg flat:

- **Font kode+nama akun dikecilin jadi `text-xs`** (sebelumnya `text-sm font-medium`) — baris label tetap `text-sm`, biar akun (info sekunder) gak menyaingi label (info utama) secara visual.
- **Leg kredit di-indent** (`pl-6`) relatif ke leg debit — niru cara jurnal akuntansi ditulis tangan/dibuku (debit rata kiri, kredit digeser kanan). Tiap leg punya `side?: "debit" | "credit"` eksplisit (bukan diparse dari teks label — beberapa label ambigu, mis. "Akun Persediaan (debit barang masuk & kredit barang keluar)" dipakai 2 arah). `side` opsional — dikosongin kalau leg gak punya pasangan debit/kredit yang jelas di grup yang sama (mis. akun reklas Tukar Barang AP yang sama persis dipakai debit & kredit — 1 leg doang, indent gak relevan).
- **1 transaksi yang bikin >1 `journal_entry` row (bukan sekadar >1 baris) dipisah garis pembatas** (`border-t` + `mt-3 pt-3`) antar grup. Ini BUKAN soal "ada berapa akun ditampilin" — soal berapa kali RPC manggil `create_journal_entry()`. Contoh: `create_goods_issue` manggil `create_journal_entry` 2x (jurnal invoice: Piutang/Pendapatan, lalu jurnal HPP: HPP/Persediaan) → 2 grup, 1 garis pembatas. `create_ar_credit_note` bisa sampai 3x (retur dasar, excess jadi saldo kredit kalau ada, reversal HPP kalau invoice-nya `goodsIssue`) → sampai 3 grup.

**WAJIB baca RPC-nya di `supabase/migrations/000X_*.sql` sebelum nentuin grouping** — jangan nebak dari label doang. Tiap `create_journal_entry(...)` call terpisah = 1 grup. Proses nulis versi pertama panel ini (tanpa `side`/grouping) sempat kelewat 3 leg "lawan akun" yang harusnya ada tapi gak ditulis (ketauan pas riset RPC buat majang `side`, bukan dari laporan user kedua) — semuanya kasus akun yang JADI counter-leg di jurnal kondisional (excess/settlement) tapi akunnya udah kepakai di leg lain di grup sebelumnya, jadi gampang kelewat kalau cuma nyalin label yang udah ada:
- `ap-bills/[id]/view.tsx` modal Retur — grup excess (`ap.return_credit_asset` debit) kelewat pasangan `ap.payable` kredit-nya.
- `ar-invoices/[id]/view.tsx` modal Tukar Barang (Garansi) — grup settlement (`ar.return_credit_liability` debit) kelewat pasangan `ar.receivable` kredit-nya.
- `ar-invoices/[id]/view.tsx` modal Catat Retur — grup excess (`ar.return_credit_liability` kredit) kelewat pasangan `ar.receivable` debit-nya.

Pelajaran: tiap kali corat-coret grup baru, cek eksplisit "2 leg di grup ini beneran jumlahnya 2 di `create_journal_entry` yang bersangkutan?" — jangan cuma nyalin leg yang kebetulan udah ada di versi sebelumnya.

## `<CashMethodField>` — tetap interaktif di form, TAPI legnya tetap masuk panel

`<CashMethodField>` (`src/components/ui/cash-method-field.tsx`, toggle Tunai/Transfer Bank) **tetap dirender di form seperti biasa** — beda dari `LockedAccountField`, ini pilihan aktif user (bukan cuma informasi), jadi tetap harus keliatan & bisa diklik.

**Percobaan pertama sengaja mengecualikan leg `CashMethodField` dari panel** (dianggap "bukan info, jadi gak perlu didobel di panel") — ternyata salah: user komplain lawan akun (counter-account) gak muncul di panel, misal form "Terima Uang Muka" cuma nunjukin `Akun Uang Muka Penjualan (kredit)` tanpa `Akun Kas/Bank (debit)`-nya, padahal itu 2 kaki dari 1 jurnal yang sama. Panel yang cuma nunjukin sebagian kaki jurnal nyesatin, bukan cuma "kurang lengkap".

**Perbaikan**: leg `CashMethodField` TETAP masuk `legs` panel, dihitung lewat `resolveCashAccount(method, defaultAccounts)` (export dari `cash-method-field.tsx`) — otomatis update tiap user toggle Tunai/Bank, karena `method` itu state yang sama dipakai kedua tempat (field interaktif di form DAN leg di panel). Jadi: field `CashMethodField` sendiri gak diubah/gak masuk hidden input — cuma value resolved-nya yang didobel-tulis ke panel, sama pola kayak `LockedAccountField` biasa cuma sumber datanya beda (`resolveCashAccount(method, ...)` bukan `defaultAccounts[role_key]` langsung).

File yang punya kombinasi `CashMethodField` + panel (6 file, 8 modal): `ap-bills/[id]/view.tsx` (Catat Pembayaran, Refund Piutang Retur Supplier), `ap-deposits/page.tsx` (Bayar Uang Muka), `ap-deposits/[id]/view.tsx` (Refund Tunai), `ar-deposits/page.tsx` (Terima Uang Muka), `ar-deposits/[id]/view.tsx` (Refund Tunai), `ar-invoices/[id]/view.tsx` (Catat Pembayaran, Refund Saldo Kredit Retur).

## Kalau nambah form baru dengan akun otomatis

Pola: baca dulu RPC-nya buat tau berapa `journal_entry` row yang bakal kebuat & leg apa aja per row (termasuk yang kondisional). Tulis `<JournalPreviewPanel groups={[[...], [...]]} />` tepat sebelum `<form onSubmit=...>` (atau sebelum grid pertama kalau gak ada paragraf deskripsi) — 1 array dalam = 1 `journal_entry`, tiap leg isi `{ label, resolved, side }`. Biarin `<LockedAccountField>` individual tetap ada di posisi field-nya masing-masing di dalam form (buat konsistensi/histori — kalau mau, boleh juga dihapus karena udah gak ada efek visual, tapi gak wajib).

## Grup harus DINAMIS terhadap inputan user, bukan cuma dokumen-level flag (2026-08-13, revisi 3)

Revisi 2 di atas udah bikin grup kondisional (mis. `goodsIssue && [...]`), tapi baru sebatas flag level-dokumen (tipe dokumen, ada-gaknya relasi) — belum mengecek ISI form yang lagi diketik user saat itu. User nunjuk langsung: modal Catat Retur AR nampilin 3 jurnal SEKALIGUS padahal RPC-nya cuma bikin sebagian tergantung apa yang user isi (nominal retur, qty per baris, kondisi Layak Jual/Rusak) — dan modal Terima Barang (goods-receipts) sama sekali gak nampilin leg PPN Masukan walau ada checkbox "Kena PPN". **Prinsipnya: panel harus nunjukin PERSIS jurnal yang bakal kejadian kalau form disubmit SEKARANG, dengan nilai yang udah diisi user SEKARANG** — bukan "semua kemungkinan jurnal yang RPC ini BISA bikin".

Pola nge-detect kondisi dari input (bukan cuma dari prop/data statis):
- **Excess/kelebihan** (retur ngelebihin outstanding) — hitung ulang rumus RPC-nya (`effective_amount - max(0, outstanding)`) di render scope pakai state form saat ini (`returAmount`/`returLines`), BUKAN nunggu submit. Kalau RPC hitung `effective_amount` dari qty×cost per baris (jalur fisik), duplikasi rumus yang sama persis di render scope (lihat `returEffectiveAmount` di `ap-bills/[id]/view.tsx`) — jangan asumsikan selalu manual nominal.
- **Kondisi per baris (HISTORIS — klasifikasi RESALABLE/DAMAGED dicabut total migration `0075`, `returns-schema.md`)** — dulu `returLines.some(l => l.condition === "X" && Number(l.qty_returned) > 0)`, sub-leg dalam 1 grup yang tergantung kondisi ini masing-masing di-`&&`. Prinsip umumnya (deteksi cabang jurnal dari isi form saat ini, bukan flag statis) tetap berlaku buat kasus serupa ke depan — cuma contoh konkretnya (kondisi retur AR) udah gak ada lagi. Retur sekarang cukup 1 cabang qty diisi/nggak (`returHasQty`), gak ada lagi pemisahan RESALABLE/DAMAGED.
- **Qty diisi/nggak per baris (masih berlaku)** — `returLines.some(l => Number(l.qty_returned) > 0)`, dipakai buat nentuin apakah grup jurnal reversal HPP (Persediaan/HPP) muncul sama sekali di form Catat Retur.
- **Qty yang bakal ditukar** (Tukar Barang/Garansi) — `replaceLines.some(l => Number(l.qty) > 0)`. Kalau semua baris masih kosong, GAK ADA jurnal sama sekali yang bakal kejadian (termasuk grup 1/HPP-Persediaan yang tadinya dikira "selalu ada") — jangan asumsikan grup pertama pasti jalan cuma karena dia gak kondisional di RPC lain.
- **Checkbox PPN** (`applyTax`) — leg PPN (Masukan buat AP/goods-receipts, Keluaran buat AR/goods-issues/sales-orders fulfill) ditambahin ke grup PERTAMA (bukan grup baru — RPC nambahin ke `v_journal_lines` yang sama, bukan `create_journal_entry` baru) `applyTax && {...}`. Akun PPN diresolve dari tabel `tax_settings` (BUKAN `default_account_settings`) lewat `resolvedPpnMasukan`/`resolvedPpnKeluaran` (`lib/tax-settings/schema.ts`, pola sama `resolveCashAccount`) — perlu `fetchTaxSettings()` (join ke `accounts` buat code/name) gantiin `supabase.from("tax_settings").select("*")` polos yang cuma dapet id doang.
- **Selisih stock opname** (kurang/lebih per baris) — `lines.some(l => Number(l.qty_actual) < systemQtyFor(l.item_id))` dst. Beda dari kasus lain: 2 grup di sini independen (bisa kejadian bareng kalau ada baris kurang DAN baris lebih), bukan mutually exclusive.

File yang kena revisi 3: `ap-bills/[id]/view.tsx` (retur excess), `ar-invoices/[id]/view.tsx` (retur excess + kondisi per baris; tukar barang qty), `ap-bills/page.tsx` + `ar-invoices/page.tsx` + `goods-receipts/page.tsx` + `goods-issues/page.tsx` + `sales-orders/[id]/view.tsx` (leg PPN), `stock-opnames/page.tsx` (selisih per baris).

**Kalau nambah grup kondisional baru: jangan cuma tanya "RPC-nya punya cabang kondisional gak" (revisi 2) — tanya juga "kondisi itu computed dari APA, dan apakah itu berubah tiap user ngetik/pilih sesuatu di form ini". Kalau ya, hitung ulang di render scope pakai state form saat ini, jangan pakai flag yang cuma nyala sekali pas modal dibuka.**

## Kategori bebas (`ChargeLinesEditor` + Select kategori tunggal) JUGA harus masuk panel (2026-08-13, revisi 4)

Revisi 3 masih kelewat 1 kelas kasus: akun yang dipilih user lewat dropdown kategori (bukan `LockedAccountField`/`CashMethodField`/checkbox PPN yang cuma 1-2 pilihan tetap), yaitu:
- **Select kategori wajib tunggal** — mis. "Kategori Persediaan/Beban (debit)" di `ap-bills/page.tsx` (`debitCategoryId`). Sebelum revisi ini, SISI DEBIT seluruh jurnal AP Bill gak pernah nongol di panel sama sekali (cuma kredit Utang Usaha yang keliatan) — padahal user beneran milih akun spesifik dari katalog kategori, bukan input bebas.
- **`<ChargeLinesEditor>`** ("Kategori Debit/Pendapatan Tambahan (opsional)") — daftar baris DINAMIS panjangnya (0..N), tiap baris pilih kategori + nominal sendiri-sendiri. Dipakai di `ap-bills/page.tsx`, `ar-invoices/page.tsx`, `goods-issues/page.tsx`, `goods-receipts/page.tsx` (lewat `p_extra_debit_lines`), `sales-orders/[id]/view.tsx` fulfill.

Awalnya ini sengaja dikecualikan dari scope `<LockedAccountField>` (kategori = Select bebas, bukan akun terkunci) — tapi itu alasan buat "field-nya tetap interaktif di form" (benar, TETAP), bukan alasan buat "gak usah muncul di panel" (salah — sama kelasnya sama `CashMethodField`: akun spesifik & resolvable, cuma sumbernya beda).

**Perbaikan** — `lib/charge-lines/schema.ts` nambah 2 helper (pola sama `resolveCashAccount`/`resolvedPpnMasukan`):
- `resolveCategoryLeg(categoryId, categories, side)` — 1 kategori terpilih -> 1 leg, `undefined` kalau belum dipilih (BUKAN nampilin warning merah "belum diset admin" — beda kasus, ini emang belum ada pilihan user, bukan admin lupa setup).
- `resolveChargeLineLegs(lines, categories, side)` — N baris `ChargeLinesEditor` yang udah keisi (kategori+nominal) -> N leg, filter yang masih kosong. Ditulis sebagai `...resolveChargeLineLegs(...)` di tengah array leg grup (bukan bikin grup baru — semua ini 1 `journal_entry` yang sama, RPC nampung ke `v_journal_lines`/`v_debit_lines` array yang sama).
- Kategori (`ChargeCategoryWithAccount`, dari `charge_categories` difilter `module`) udah kequery ikut join `accounts(code,name)` dari awal (dipakai buat resolve submit) — tinggal dipakai ulang, gak perlu fetch tambahan.
- Label leg dari NAMA KATEGORI (`cat.name`, mis. "Ongkir Supplier"), bukan nama akun — kategori itu yang user pilih & kenali, akun cuma detail teknis di baris resolved-nya.

File yang kena revisi 4: `ap-bills/page.tsx` (primary category + extra), `ar-invoices/page.tsx` + `goods-issues/page.tsx` + `goods-receipts/page.tsx` + `sales-orders/[id]/view.tsx` (extra doang, primary-nya udah fixed/`LockedAccountField`).

Kelas kasus yang sama juga ketemu di `ap-bills/[id]/view.tsx` modal Retur — Select "Akun Persediaan/Beban (kredit)" (`returCreditAccountId`, opsi dari `returCreditAccountOptions()` yang udah `ResolvedAccount[]` langsung, gak perlu helper tambahan) gak pernah masuk grup 1 panel, padahal itu leg kredit pasangan `ap.payable` debit yang udah ada. Fix: `!!returCreditAccountId && { label: "Akun Persediaan/Beban (kredit)", resolved: returCreditAccountOptions().find((a) => a.id === returCreditAccountId), side: "credit" }` — **hati-hati pakai `!!` di depan string state kalau langsung dipakai buat conditional leg (`str && {...}`), bukan lewat helper function** — string kosong (`""`) itu falsy tapi bukan `false`/`null`/`undefined`, jadi ketolak TypeScript sebagai `LegInput` (union eksplisit, gak nerima `string`).

**Checklist lengkap tiap kali cek 1 form**: field mana aja yang nentuin akun jurnal? Tiap field itu — `LockedAccountField` (fixed admin)? `CashMethodField` (toggle 2 pilihan)? checkbox PPN (boolean)? Select kategori tunggal/`ChargeLinesEditor` (katalog, N baris)? SEMUANYA harus punya leg di panel, gak peduli sumber datanya beda-beda — yang beda cuma CARA resolve-nya, bukan APAKAH ditampilin.
