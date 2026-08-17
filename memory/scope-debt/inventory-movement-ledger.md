# Kartu Stok / Riwayat Mutasi per Item (Inventory Movement Ledger)

**Modul asal:** Inventory (Posisi Persediaan). **Status:** Ditunda.

## Kasus

Halaman `/inventory` (Posisi Persediaan) cuma nampilin saldo akhir per item (`inventory_balances.qty_on_hand` + `avg_cost`) — gak ada cara lihat riwayat gimana angka itu terbentuk (kapan beli, kapan dipakai produksi, kapan ada selisih opname, dst). Kebutuhan: item di list bisa diklik, buka halaman "kartu stok" yang nampilin riwayat mutasi kronologis (tanggal, sumber, ref dokumen, qty masuk/keluar, saldo berjalan) dengan filter (minimal tanggal) + paginasi — analoginya kayak buku tabungan bank (saldo sekarang vs riwayat transaksi).

**Cakupan sumber disepakati: SEMUA jalur yang nyentuh `inventory_balances`, bukan cuma yang inti.** ±10 tabel beda struktur:
- Masuk (IN): `goods_receipt_lines` (beli), `production_orders` header (`qty_produced`, hasil produksi), `inventory_return_lines` kondisi `RESALABLE` (retur customer), `stock_opname_lines` (selisih lebih).
- Keluar (OUT): `goods_issue_lines` + `pos_sale_lines` (terjual), `production_order_lines` (`qty_consumed`, bahan baku dipakai), `purchase_return_lines` (retur ke supplier), `purchase_writeoff_lines` (barang rusak), `warranty_replacement_lines` (ganti garansi), `stock_opname_lines` (selisih kurang).

## Kenapa ditunda

**Keputusan arsitektur (dibahas 2026-08-16): "Cara B" — tabel ledger terpusat baru (`inventory_movements`), BUKAN view gabungan read-only.** User pilih ini secara sadar walau direkomendasikan sebaliknya (view lebih murah & rendah risiko, mirror pola `*_with_status` yang baru dibangun sesi sebelumnya) — trade-off yang diterima: baca riwayat lebih cepat & konsisten jangka panjang (1 tabel rapi, gak perlu buka ±10 tabel tiap query), ditukar dengan biaya & risiko awal yang jauh lebih besar:

1. **±9 RPC yang udah jalan di production harus diubah** buat nambah INSERT ke `inventory_movements` juga: `create_goods_receipt`, `create_goods_issue`, `create_production_order`, `record_stock_opname`, `create_ap_credit_note` (jalur retur ke supplier), `create_purchase_writeoff`, `create_purchase_replacement`, `create_ar_credit_note` (jalur retur customer), `create_warranty_replacement`, `create_pos_sale`. Tiap RPC butuh direview sendiri (`schema-reviewer`) — ini bukan kerjaan 1 migration, harus direncanakan bertahap.
2. **Wajib backfill data lama** (disepakati eksplisit) — transaksi yang udah kejadian sebelum ledger ini dibangun harus dipindah ulang ke `inventory_movements`, bukan cuma mulai kosong dari sekarang. Butuh migration/script backfill terpisah yang baca ke-10 tabel sumber di atas dan insert baris historisnya (urutan kronologis per item harus benar, biar saldo berjalan/`running balance` konsisten sama `inventory_balances.qty_on_hand` yang ada sekarang).
3. **Temuan dari diskusi:** gak satu pun dari ±9 tabel sumber punya index di `item_id` (cuma diindex lewat FK ke tabel header-nya masing-masing) — index ini perlu ditambah sebagai bagian dari kerjaan ini juga (migration index-only, mirror pola `0029`/`0030_transactional_date_indexes.sql`), apa pun detail desain ledger-nya nanti.
4. **Desain kolom ledger belum difinalkan** — perlu diputuskan pas mulai dikerjakan: apakah `running balance` disimpan langsung per baris (butuh urutan insert yang benar per item) atau dihitung on-the-fly pas dibaca (window function `SUM() OVER (...)`, lebih aman dari race condition tapi lebih berat pas query panjang).

Ini semua di luar scope sesi diskusi kebutuhan — butuh sesi `new-feature` tersendiri (ERD lengkap `inventory_movements`, urutan RPC yang diubah, desain backfill, review per-RPC) sebelum mulai schema->API->UI.

## Referensi

- `memory/domain/inventory.md` (submodule "Konsep Inti" — `inventory_balances` sebagai satu-satunya state costing tersimpan)
- `memory/architecture/data/inventory-schema.md`
