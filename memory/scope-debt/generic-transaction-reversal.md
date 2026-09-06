# Fungsi Reverse Generik di Level `transactions`

**Modul asal:** cross-cutting (AR/AP/POS), muncul dari diskusi `memory/scope-debt/pos-sales-simplify-rely-on-goods-issue.md`. **Status:** Ditunda.

## Kasus

Mekanisme "batalkan/reverse" transaksi sekarang tersebar di beberapa fungsi terpisah yang masing-masing hafal caranya sendiri: `cancel_ar_invoice`, `cancel_ap_bill`, dan RPC pembatalan POS yang direncanakan di `pos-sales-simplify-rely-on-goods-issue.md` (poin 7 — cari `goods_issues`/`payments` manual lewat FK, reverse 3 jurnal + balikin stok). User mengusulkan idealnya ada **1 fungsi generik** `reverse_transaction(transaction_id)` di level `transactions` yang membalikkan SEMUA jurnal yang terkait 1 transaksi, gantiin fungsi-fungsi terpisah di atas.

## Kenapa ditunda

Bukan technical debt kecil — butuh desain sendiri, bukan sekadar "loop semua `journal_entries` yang nyantol lalu reverse":

- **Reverse bukan cuma soal jurnal.** Tiap jenis pendamping transaksi punya efek samping sendiri di luar jurnal yang harus ikut ditangani: `goods_issues` → restore `inventory_balances` + tulis compensating `inventory_movements` (bukan cuma reverse jurnal HPP); `deposit_applications` → balikin status DP jadi "belum dipakai"; `returns`/`warranty_replacements` → biasanya malah gak boleh dibatalkan gitu aja begitu ada retur/penggantian nyusul (business rule existing, bukan bug). Jadi fungsi generik ini tetap butuh dispatch/logic per-jenis pendamping di dalamnya — cuma pintu masuknya yang 1, bukan berarti semua logic melebur jadi "reverse semua jurnal secara buta".
- **Scope nyentuh AR dan AP sekaligus**, bukan cuma POS — `cancel_ar_invoice`/`cancel_ap_bill` (yang sekarang punya guard sengaja "tolak kalau invoice/tagihan udah punya payment apa pun", maksudnya staff harus sadar reverse payment dulu manual sebelum cancel invoice) berpotensi diganti/dirombak total kalau mau benar-benar generik. Ini keputusan bisnis (bukan cuma teknis) soal apa boleh "cancel otomatis reverse semuanya" jadi default buat SEMUA jenis transaksi, atau tetap ada friksi sengaja buat kasus kredit biasa (banyak payment/retur bertahap).

## Kapan perlu digarap

Sesi desain terpisah, idealnya **setelah** `pos-sales-simplify-rely-on-goods-issue.md` dieksekusi lebih dulu — RPC pembatalan POS di situ (kasus paling sederhana: 1 invoice + 1 goods_issue + 1 payment, gak ada retur/DP) bisa jadi preseden konkret buat basis desain versi generiknya, daripada mendesain abstraksi dari nol.

## Referensi

- `memory/architecture/data/transactions-schema.md` — RPC `cancel_ar_invoice`/`cancel_ap_bill` existing beserta guard-nya.
- `memory/scope-debt/pos-sales-simplify-rely-on-goods-issue.md` — sumber diskusi & preseden konkret yang direkomendasikan dikerjakan lebih dulu.
