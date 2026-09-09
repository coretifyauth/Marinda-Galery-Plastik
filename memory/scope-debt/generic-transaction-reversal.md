# Fungsi Reverse Generik di Level `transactions`

**Modul asal:** cross-cutting (AR/AP/POS), muncul dari diskusi simplifikasi POS (2026-09-06, dieksekusi migration `0078`/`0079` — lihat `docs/architecture/pos-schema.md`). **Status:** Ditunda.

## Kasus

Mekanisme "batalkan/reverse" transaksi sekarang tersebar di beberapa fungsi terpisah yang masing-masing hafal caranya sendiri: `cancel_ar_invoice`, `cancel_ap_bill`, dan `void_pos_transaction` (POS — cari `goods_notes`(`type='OUTBOUND'`)/`payments` lewat FK, reverse 3 jurnal + balikin stok, SUDAH LIVE lewat migration `0078`). User mengusulkan idealnya ada **1 fungsi generik** `reverse_transaction(transaction_id)` di level `transactions` yang membalikkan SEMUA jurnal yang terkait 1 transaksi, gantiin fungsi-fungsi terpisah di atas.

## Kenapa ditunda

Bukan technical debt kecil — butuh desain sendiri, bukan sekadar "loop semua `journal_entries` yang nyantol lalu reverse":

- **Reverse bukan cuma soal jurnal.** Tiap jenis pendamping transaksi punya efek samping sendiri di luar jurnal yang harus ikut ditangani: `goods_notes` → restore `inventory_balances` + tulis compensating `inventory_movements` (bukan cuma reverse jurnal HPP); `deposit_applications` → balikin status DP jadi "belum dipakai"; `returns`/`replacements` → biasanya malah gak boleh dibatalkan gitu aja begitu ada retur/penggantian nyusul (business rule existing, bukan bug). Jadi fungsi generik ini tetap butuh dispatch/logic per-jenis pendamping di dalamnya — cuma pintu masuknya yang 1, bukan berarti semua logic melebur jadi "reverse semua jurnal secara buta".
- **Scope nyentuh AR dan AP sekaligus**, bukan cuma POS — `cancel_ar_invoice`/`cancel_ap_bill` (yang sekarang punya guard sengaja "tolak kalau invoice/tagihan udah punya payment apa pun", maksudnya staff harus sadar reverse payment dulu manual sebelum cancel invoice) berpotensi diganti/dirombak total kalau mau benar-benar generik. Ini keputusan bisnis (bukan cuma teknis) soal apa boleh "cancel otomatis reverse semuanya" jadi default buat SEMUA jenis transaksi, atau tetap ada friksi sengaja buat kasus kredit biasa (banyak payment/retur bertahap).

## Kapan perlu digarap

Sesi desain terpisah. Preseden konkret yang direkomendasikan sebagai basis desain **SUDAH ADA** (`void_pos_transaction`, migration `0078` — kasus paling sederhana: 1 invoice + 1 goods note + 1 payment, gak ada retur/DP, cari lewat FK langsung tanpa tabel penanda) — sesi desain generik ini bisa mulai kapan pun, gak lagi nunggu prasyarat lain.

## Referensi

- `docs/architecture/transactions-schema.md` — RPC `cancel_ar_invoice`/`cancel_ap_bill` existing beserta guard-nya.
- `docs/architecture/pos-schema.md` — `void_pos_transaction`, preseden konkret pola "cari pendamping transaksi lewat FK, reverse N jurnal + efek samping".
