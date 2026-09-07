# POS / Jualan Eceran — AI Context

POS = penjualan tunai kios. Sejak migration `0076`/`0078`, SECARA TEKNIS mesinnya sama persis penjualan termin lunas-seketika (numpang lewat Piutang Usaha sesaat sebelum langsung dilunasi RPC yang sama) — bedanya cuma di titik waktu pengakuan Kas vs Piutang, gak pernah kelihatan outstanding dari sisi pemilik usaha. Gak ada tabel POS khusus lagi sama sekali (`0078`) — murni komposisi `transactions`+`goods_issues`+`payments` yang udah dipakai modul lain.

Naratif lengkap + reasoning penuh: `docs/domain/pos.md`. Struktur module → submodule di file ini SAMA urutannya dengan padanan naratif itu. Detail teknis (DDL/RPC): `memory/architecture/data/pos-schema.md`.

## Konsep Inti

**Entitas & Jurnal**
- **POS Sale** (RPC `create_pos_sale`, `security definer` PERTAMA di project) — orkestrasi `create_goods_issue` (jurnal Piutang↔Pendapatan + HPP↔Persediaan, konsumsi stok) lalu `record_payment` (jurnal Kas↔Piutang, lunas PENUH seketika di RPC yang sama). Kredit item selalu ke `4100 Pendapatan Penjualan Toko`, terpisah dari `4200 Pendapatan Penjualan Grosir` (AR Invoice) biar dua channel jualan kelihatan terpisah di laporan. Biaya pokok via `consume_weighted_average` (reuse, sama fungsi `create_goods_issue`/`create_production_order`).
- **`customer_id` WAJIB terisi, tapi kasir gak wajib pilih** — `transactions.counterparty_id not null` gak dilonggarkan buat POS. Kasir gak pilih -> fallback ke 1 row `counterparties` sintetis "Pelanggan Umum" (ID di `pos_settings.walk_in_customer_id`, singleton). Row ini di-exclude dari dropdown pilih customer transaksi kredit sungguhan (`ar-invoices`/`ar-deposits`/`goods-issues`/`sales-orders`), TAPI TETAP muncul di master list `/customers` (auditable) dan filter list `/pos-sales` (wajar, itu penjualan POS asli).
- **`payment_method`** — nentuin akun debit jurnal pelunasan (Kas vs Bank/QRIS), dua akun COA beda (`1100 Kas Toko` vs `1200 Kas di Bank`) — bukan disamain 1 akun, biar rekonsiliasi bank vs kas fisik akurat.
- **No-oversell, no offline capability di checkout** — keputusan arsitektur final (bukan scope-debt). Owner sempat minta POS tetap bisa transaksi walau internet putus ("zero-downtime") — bentrok langsung sama aturan no-oversell di Inventory. Keputusannya: pegang no-oversell, checkout wajib online real-time ke `inventory_balances` yang sama dipakai AR/Inventory. Revisit WAJIB bareng rediskusi kebijakan no-oversell Inventory (2 keputusan itu terikat).
- **Multi Unit of Measure reuse** — baris item satuan jual bukan-dasar (`item_units`), konversi qty ke satuan dasar terjadi di UI (`apps/pos`) sebelum manggil RPC, pola identik `create_goods_issue`.
- **Retur belum dibangun** — grey area kebijakan bisnis, belum keputusan owner. Detail: `memory/special-case/pos-retur-policy.md`.
- **Gak ada lagi cara bedain "transaksi dari kasir POS" vs "AR Invoice manual yang kebetulan bentuknya identik"** (walk-in counter sale tanpa SO, lunas seketika) — keputusan sadar user (migration `0078`), bukan celah. Identitas POS sekarang PURE STRUKTURAL: transaksi `OUTBOUND` + persis 1 `goods_issues` + persis 1 `payments` lunas penuh + 0 retur/DP.

**Kategori Biaya Tambahan & PPN (migration `0025`, masih berlaku)**
- Kasir bisa nambah baris "kategori biaya tambahan" dari katalog preset admin (`charge_categories`, `module='pos'`), bukan pilih akun bebas. Nominal diinput manual tiap transaksi.
- PPN (kalau kios PKP) dihitung **otomatis oleh sistem** dari `tax_settings`, bukan diketik manual — bagian jurnal yang sama, ikut kebalik otomatis kalau transaksinya dibatalkan.
- Detail teknis: `memory/architecture/data/pos-schema.md`.

**Constraints**
- Konsumsi stok per baris gak boleh melebihi `inventory_balances.qty_on_hand` (anti over-consumption, guard sama `consume_weighted_average` dipakai modul lain).
- Money `numeric(14,2)`, bukan float (invariant `AGENTS.md`).
- Immutability sama pola AR/AP: gak ada `UPDATE`/`DELETE`, koreksi = reversing entry via submodule "Pembatalan (Void)".

## Pembatalan (Void)

**Entitas & Jurnal**
- RPC `void_pos_transaction` (migration `0078`, gantiin `void_pos_sale` lama yang udah di-drop) — cari `goods_issues`/`payments` LANGSUNG lewat FK (`invoice_id`/`transaction_id`), gak butuh tabel penanda. Guard eksplisit: persis 1 `goods_issues` + persis 1 `payments` yang melunasi PENUH + 0 retur/DP nempel — kalau transaksinya gak match pola ini (misal punya retur susulan), `raise exception` suruh pakai `cancel_ar_invoice`. Reverse KETIGA jurnal (payment, goods_issue, transaction). Status "dibatalkan" derived dari ada-tidaknya reversal (`exists (select 1 from journal_entries where reverses_entry_id = ...)`), nempel di kolom `transactions.status` (mesin yang sama semua jenis transaksi), bukan tabel/kolom POS khusus.
- Beda dari `cancel_ar_invoice`: gak ada guard "sudah ada payment" (penjualan kios lunas seketika di titik transaksi dibuat, guard itu malah gak relevan — POS SELALU punya payment). Guard yang berlaku: periode tertutup (reuse existing) + pola struktural di atas.

**Constraints**
- Void cuma reversing entry, gak pernah hapus/edit row `transactions`/`goods_issues`/`payments` asli.
- Void ke periode yang sudah ditutup ditolak otomatis (reuse trigger, gak ada constraint baru).

**Skenario referensi**
| # | Kasus | Pola |
|---|---|---|
| 1 | Kasir salah input, dibatalkan segera | `void_pos_transaction` balikin 3 jurnal (Kas/Piutang, HPP/Persediaan, Piutang/Pendapatan), stok balik + kompensasi `inventory_movements` |

**Common Mistakes**
- Void dengan hapus/update row asli — harus selalu reversing entry.
- Nyalin guard "sudah ada payment" dari `cancel_ar_invoice` ke sini — gak relevan, POS SELALU punya payment (itu justru kenapa RPC-nya beda, bukan alasan buat nolak).
- Manggil `void_pos_transaction` buat transaksi yang udah punya retur/DP nempel — RPC ini SENGAJA nolak (bukan bug), pakai `cancel_ar_invoice` buat kasus itu.

## Topologi Aplikasi

App terpisah dalam monorepo (`apps/pos`, di samping `apps/erp` existing) — checkout kasir (device laptop/desktop) di layout sendiri tanpa admin shell, riwayat transaksi (+ aksi Void) tetap di `apps/erp` ikut pola list+detail yang sudah ada (`memory/preferences/ui/admin-shell-design.md`). Kedua app konek ke Supabase project yang SAMA (real-time, no local cache stok). Detail penuh + rationale: `memory/architecture/app/tech-stack-decisions.md` > "App Structure: Monorepo".

## Glossary

- **POS Sale**: 1 transaksi kasir tunai di kios — sekarang murni `transactions(OUTBOUND)` + `goods_issues` + `payments`, gak ada tabel POS khusus.
- **Void**: `void_pos_transaction`, pembatalan via reversing entry, guard "pola penjualan kios sederhana" (bukan soal payment kayak AR).
- **`payment_method`**: nentuin akun Kas (tunai fisik) vs Bank (QRIS/transfer) yang kena debit di jurnal pelunasan.
- **"Pelanggan Umum"**: customer fallback wajib buat pembeli anonim — bukan flag/kolom spesial, row `counterparties` biasa.
