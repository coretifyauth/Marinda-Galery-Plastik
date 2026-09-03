# POS / Jualan Eceran — AI Context

POS = penjualan tunai kios, berdiri sendiri dari AR (gak pernah nyentuh Piutang Usaha sama sekali secara data) walau konsepnya "versi tunai" dari AR Invoice. 1 sale = 1 header + N baris item (basket), mirip gabungan `create_ar_invoice`+`create_goods_issue` tapi sisi debit-nya Kas/Bank langsung, bukan Piutang.

Naratif lengkap + reasoning penuh: `docs/domain/pos.md`. Struktur module → submodule di file ini SAMA urutannya dengan padanan naratif itu.

## Konsep Inti

**Entitas & Jurnal**
- **POS Sale** (RPC `create_pos_sale`, `0023_pos_schema.sql`, sudah diapply) — header + banyak baris item. 2 jurnal per transaksi:
  ```
  Debit Kas/Bank [total]         Kredit Pendapatan Penjualan Toko (4100) [total]
  Debit HPP [biaya pokok]        Kredit Persediaan Barang Jadi [biaya pokok]
  ```
  Kredit selalu ke `4100 Pendapatan Penjualan Toko` — akun ini sudah ada di seed COA sejak awal, terpisah dari `4200 Pendapatan Penjualan Grosir` yang dipakai AR Invoice, biar dua channel jualan kelihatan terpisah di laporan.
  Biaya pokok dihitung per baris item via `consume_weighted_average` (reuse, sama fungsi dipakai `create_goods_issue`/`create_production_order`).
- **`customer_id` nullable** — boleh dikaitkan ke `counterparties` (dulu `customers`, digabung sama `suppliers` migration `0059` — lihat `memory/architecture/data/counterparty-schema.md`) buat kasus cash sale ke customer yang lagi kena Credit Hold (lihat `memory/domain/accounts-receivable.md` submodule "Credit Hold" — catatan itu jadi cikal-bakal pattern ini), atau `null` buat walk-in anonim. Gak pernah bikin `ar_invoices` row apapun.
- **`payment_method`** — nentuin akun debit (Kas vs Bank/QRIS), dua akun COA beda (`1100 Kas Toko` vs `1200 Kas di Bank`, sudah ada di seed) — bukan disamain 1 akun, biar rekonsiliasi bank vs kas fisik akurat.
- **No-oversell, no offline capability di checkout** — keputusan arsitektur final (bukan scope-debt lagi, sempat dicatat di `memory/scope-debt/pos-offline-capability.md` sampai 2026-08-10, dihapus karena isinya keputusan final yang udah diimplementasikan, bukan sesuatu yang ditunda). Owner sempat minta POS tetap bisa transaksi walau internet putus ("zero-downtime") — ini bentrok langsung sama aturan no-oversell di Inventory (`memory/domain/inventory.md`): POS offline-capable (cache stok lokal di device) berarti kasir bisa jualan dari data stok yang basi, resiko oversell begitu 2 kasir jual barang sama secara bersamaan pas offline. Keputusannya: pegang no-oversell, checkout wajib online real-time ke `inventory_balances` yang sama dipakai AR/Inventory — konsekuensinya kasir sempat gak bisa transaksi kalau internet mati. Kalau nanti ada keluhan lapangan nyata soal ini, revisit-nya WAJIB bareng rediskusi kebijakan no-oversell di Inventory (2 keputusan itu terikat, gak bisa diubah sepihak).
- **Multi Unit of Measure reuse** — kalau baris item pakai satuan jual bukan-dasar (`item_units`), konversi qty ke satuan dasar terjadi di UI sebelum manggil RPC, pola identik `create_goods_issue` (lihat `memory/domain/inventory.md` submodule "Satuan Jual & Harga").
- **Retur belum dibangun** — grey area kebijakan bisnis, belum keputusan owner. Detail: `memory/special-case/pos-retur-policy.md`.

**Kategori Biaya Tambahan & PPN (migration `0025_compound_transactional_entries_schema.sql`)** — dulu `create_pos_sale` cuma bisa 1 akun kredit tetap (Pendapatan Penjualan Toko), jadi biaya packing/ongkir atau PPN gak bisa nempel ke 1 transaksi kasir yang sama. Sekarang:
- Kasir bisa nambah baris "kategori biaya tambahan" (mis. Biaya Packing) dari katalog preset yang disiapkan admin (`pos_charge_types` — nama + akun tujuan), bukan pilih akun bebas. Nominalnya tetap diinput manual tiap transaksi (gak ada nilai default).
- PPN (kalau kios ini PKP) dihitung **otomatis oleh sistem** dari tarif yang diset admin (`tax_settings`), bukan diketik manual — dulu (interim) PPN dicatat lewat jurnal manual terpisah yang gak nempel ke transaksi kasir manapun, sekarang jadi bagian jurnal yang sama sehingga ikut kebalik otomatis kalau transaksinya dibatalkan.
- Detail teknis penuh: `memory/architecture/data/pos-schema.md` submodule "Compounding & PPN".

**Constraints**
- Konsumsi stok per baris gak boleh melebihi `inventory_balances.qty_on_hand` (anti over-consumption, guard sama `consume_weighted_average` dipakai modul lain).
- Money `numeric(14,2)`, bukan float (invariant `AGENTS.md`).
- Immutability sama pola AR/AP: gak ada `UPDATE`/`DELETE`, koreksi = reversing entry via submodule "Pembatalan (Void)".

## Pembatalan (Void)

**Entitas & Jurnal**
- RPC `void_pos_sale` (`0023_pos_schema.sql`, sudah diapply), pola identik `cancel_ar_invoice`: manggil `reverse_journal_entry` ke jurnal asli (kedua jurnal — Kas/Pendapatan DAN HPP/Persediaan — sama-sama dibalik). Status "dibatalkan" derived dari ada-tidaknya reversal (`exists (select 1 from journal_entries where reverses_entry_id = ...)`), bukan kolom `voided_at` manual — konsisten pola "no `is_active`" (`coa-schema.md`).
- Beda dari `cancel_ar_invoice`: gak ada guard "sudah ada payment" (penjualan kios lunas seketika di titik transaksi dibuat, gak ada tahap payment terpisah). Guard yang berlaku cuma reuse existing: trigger block-retroactive-period (`create_journal_entry`) nolak pembatalan ke periode yang sudah ditutup.

**Constraints**
- Void cuma reversing entry, gak pernah hapus/edit row `pos_sales`/`pos_sale_lines` asli.
- Void ke periode yang sudah ditutup ditolak otomatis (reuse trigger, gak ada constraint baru).

**Skenario referensi**
| # | Kasus | Pola |
|---|---|---|
| 1 | Kasir salah input, dibatalkan segera | `void_pos_sale` balikin 2 jurnal (Kas/Pendapatan + HPP/Persediaan), stok balik ke `inventory_balances` |

**Common Mistakes**
- Void dengan hapus/update row asli — harus selalu reversing entry.
- Nyalin guard "sudah ada payment" dari `cancel_ar_invoice` ke sini — gak relevan, POS gak punya tahap payment terpisah dari sale-nya sendiri.

## Topologi Aplikasi

App terpisah dalam monorepo (`apps/pos`, di samping `apps/erp` existing) — checkout kasir (device laptop/desktop) di layout sendiri tanpa admin shell, riwayat transaksi (+ aksi Void) tetap di `apps/erp` ikut pola list+detail yang sudah ada (`memory/preferences/ui/admin-shell-design.md`). Kedua app konek ke Supabase project yang SAMA (real-time, no local cache stok). Detail penuh + rationale: `memory/architecture/app/tech-stack-decisions.md` > "App Structure: Monorepo".

## Glossary

- **POS Sale**: 1 transaksi kasir tunai di kios, header+banyak baris item, gak pernah bikin Piutang Usaha.
- **Void**: pembatalan POS Sale via reversing entry, guard cuma soal periode tertutup (gak ada guard payment kayak AR).
- **`payment_method`**: nentuin akun Kas (tunai fisik) vs Bank (QRIS/transfer) yang kena debit.
