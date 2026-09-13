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

## Update diskusi (2026-09-11) — request eksplisit dari user, ditunda lagi karena blocker teknis baru

User minta konkretnya: "reversal buat penerimaan dan pengeluaran barang serta pembayarannya" (GRN, Goods Issue, AR/AP Payment). Diskusi sempat jalan sampai hampir ke tahap schema, keputusan yang **sudah disepakati** (dipakai lagi kalau sesi ini dilanjutkan):

- **GRN/Bill (dan GI/Invoice) BUKAN 2 entity terpisah** — dibuat dalam 1 RPC call yang sama (`create_goods_receipt`/`create_goods_issue`, lihat `docs/architecture/goods-notes-schema.md`). Jadi "void dari sisi GRN" dan "void dari sisi Bill" itu **aksi yang sama persis**, bukan cascade 2 langkah seperti yang tadinya diduga — cukup perluas `cancel_ap_bill`/`cancel_ar_invoice` yang sudah ada, gak perlu RPC baru khusus GRN/GI.
- **Guard yang disepakati**: void GRN/GI cuma boleh kalau Bill/Invoice turunannya (kalau ada) belum kesentuh Payment maupun Retur/DP sama sekali — begitu salah satu ada, ditolak total, user harus urus manual dulu (sama semangat sama guard `cancel_ap_bill` yang sudah ada, cuma diperluas cakupannya ke stok/jurnal goods_notes-nya juga).
- **Payment berdiri sendiri** (AR/AP, belum ada RPC-nya sama sekali sekarang) boleh divoid asal invoice/bill yang dibayar belum punya Retur yang makan saldo dari situ, dan payment-nya belum pernah dibalik sebelumnya (guard `v_already_voided` gaya `void_pos_transaction`).

**Blocker baru yang bikin ditunda (belum ada di versi sebelumnya file ini)**: reverse jurnal GRN gampang, tapi **`avg_cost` (Rata-Rata Tertimbang) gak bisa "dimundurin" bersih** kalau sudah ada penerimaan lain untuk item yang sama sesudah GRN yang mau divoid — begitu avg_cost udah "kecampur" transaksi berikutnya, gak ada rumus mundur sederhana buat misahin balik kontribusi 1 GRN doang. **Goods Issue TIDAK kena masalah ini** (GI cuma konsumsi di avg_cost saat itu, gak pernah mengubah avg_cost, jadi reversal-nya tetap simpel — qty balik, avg_cost gak disentuh, persis pola `void_pos_transaction`). Opsi yang diusulkan tapi belum difinalkan: void GRN cuma diizinkan kalau GRN itu masih "gerakan terakhir" buat item itu (belum ada mutasi stok lain di atasnya) — kalau sudah ada, ditolak, arahkan ke Stock Opname. Alternatif lain yang belum dieksplorasi: recompute avg_cost dari seluruh `inventory_movements` yang tersisa setelah exclude GRN yang divoid.

Belum ada satu baris migration/kode pun yang ditulis untuk ini — kalau dilanjutkan, mulai dari memutuskan pendekatan avg_cost di atas dulu, baru lanjut ke schema.

## Referensi

- `docs/architecture/transactions-schema.md` — RPC `cancel_ar_invoice`/`cancel_ap_bill` existing beserta guard-nya.
- `docs/architecture/pos-schema.md` — `void_pos_transaction`, preseden konkret pola "cari pendamping transaksi lewat FK, reverse N jurnal + efek samping".
- `docs/architecture/goods-notes-schema.md` — `create_goods_receipt`/`create_goods_issue`, konfirmasi GRN/Bill (dan GI/Invoice) dibuat dalam 1 RPC call yang sama, bukan 2 entity independen.
