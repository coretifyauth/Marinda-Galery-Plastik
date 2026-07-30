# Accounts Receivable — Nagih Piutang Termin

## Masalah yang diselesaikan

Fase 2 (`general-ledger.md`) udah bisa nyatet piutang timbul (Debit Piutang Usaha) pas jual dengan termin. Tapi itu baru "kejadiannya kecatet" — belum ada mekanisme buat:

- Tau **siapa** yang berutang (customer identitasnya belum ada tabelnya sendiri, cuma nempel di `description` journal entry).
- Tau **kapan jatuh tempo** tiap piutang, dan **berapa termin** yang disepakati per customer.
- Nyatet pelunasan dan tau **piutang mana yang udah/belum lunas**, termasuk kalau pelunasannya nyicil atau digabung beberapa invoice sekaligus.
- Bikin **aging report** (piutang mana yang udah lewat jatuh tempo) buat nagih.

AR nutup gap ini: nambah lapisan "siapa berutang, berapa, kapan jatuh tempo, udah dibayar berapa" di atas General Ledger yang udah ada.

## Konsep Inti

- **Customer** — master data, entitas yang berutang ke CV Barokah (warung langganan). Punya `payment_term_days` default (misal net-7, net-14) yang dipakai buat ngitung jatuh tempo tiap invoice baru. Bukan data transaksional — kalau terminnya berubah, di-`UPDATE` di baris yang sama, gak bikin row baru (lihat "Kenapa payment_term_days aman diubah" di bawah).
- **AR Invoice** — piutang timbul. 1 kejadian "kirim barang, belum dibayar" = 1 invoice. Tiap invoice bikin 1 journal entry: **Debit Piutang Usaha, Kredit Pendapatan**. `due_date` dihitung otomatis (`invoice_date + payment_term_days` milik customer itu) **pas invoice dibuat**, lalu disimpan permanen — gak dihitung ulang tiap kali dibaca.
- **AR Payment** — piutang berkurang, kejadian bayar beneran (bukan jadwal). 1 payment bikin 1 journal entry: **Debit Kas/Bank, Kredit Piutang Usaha**, sejumlah **total** yang dibayar — gak peduli itu nutup 1 atau banyak invoice.
- **AR Payment Allocation** — jembatan many-to-many antara payment dan invoice, nyimpen "payment ini nutup invoice mana, sejumlah berapa". Dibutuhin karena hubungan pembayaran-ke-invoice di dunia nyata jarang 1:1 (lihat Skenario di bawah).
- **Status invoice (lunas/sebagian/belum)** — **derived**, dihitung dari `SUM(allocations.amount)` invoice itu dibanding `invoice.amount`, bukan kolom manual. Konsisten sama pola `archived_at`/"published" yang udah dipakai di COA & Journal Entry (`docs/preferences/system/state-naming-convention.md`).

## Kenapa payment_term_days aman diubah di tempat (bukan versioned)

`due_date` invoice dihitung dan **disimpan** sekali pas invoice dibuat, bukan formula yang dihitung ulang tiap baca. Jadi kalau `customers.payment_term_days` diubah nanti (misal warung langganan lama dipercaya, dari net-7 jadi net-14), itu cuma ngaruh ke invoice **baru** ke depan — invoice lama yang udah punya `due_date` gak ikut geser. Beda kasus sama `accounts.code/category` yang dikunci setelah dipakai jurnal (`coa-schema.md`) — itu dikunci karena field itu identitas akuntansi yang gak boleh geser retroaktif; `payment_term_days` cuma default kalkulasi, gak ada resiko serupa.

## Kenapa Butuh Tabel Alokasi (bukan `invoice_id` langsung di payment)

Kalau `ar_payments` cuma punya 1 kolom `invoice_id`, cuma bisa nampung kasus 1 payment = 1 invoice pas. Tapi kejadian nyata:

- **1 payment nutup banyak invoice** — warung transfer sekali buat nutup beberapa invoice pengiriman minggu itu.
- **1 payment nutup sebagian invoice** — warung baru sanggup bayar sebagian, sisanya nyusul.
- **1 invoice dilunasi lewat beberapa payment** — dicicil bertahap di waktu berbeda.

Tabel `ar_payment_allocations` (payment_id, invoice_id, amount) nampung ketiga kasus itu sekaligus tanpa perlu kolom tambahan atau logic khusus per kasus.

## Constraint Wajib

**1. Invoice & Payment tetap masuk General Ledger lewat jalur yang sama**
Gak ada jalur pencatatan piutang yang bypass `journal_entries`/`journal_lines` — AR cuma "lapisan tambahan" di atas GL, bukan sistem pencatatan paralel. Tiap invoice/payment wajib punya `journal_entry_id` yang nunjuk ke entry yang beneran balance (via RPC yang sama prinsipnya kayak `create_journal_entry`).

**2. Immutability sama kayak Journal Entry**
Invoice/payment/allocation gak boleh diedit/dihapus setelah dibuat. Invoice salah = reversing entry (jurnal pembalik) + invoice asli tetap ada di histori, bukan invoice-nya dihapus. Ini konsisten sama constraint #4 di `general-ledger.md`.

**3. Total alokasi gak boleh lebih dari amount payment maupun amount invoice**
`SUM(allocations)` per payment gak boleh > `ar_payments.amount` (gak bisa alokasiin uang yang gak ada). `SUM(allocations)` per invoice gak boleh > `ar_invoices.amount` (gak bisa "kelunasan" — kalau beneran ada overpay, itu kasus terpisah/belum di-scope, lihat "Belum termasuk").

**4. `due_date` dihitung sekali pas insert, bukan generated column dinamis**
Beda dari `accounts.normal_balance` (generated always as, dihitung ulang tiap baca) — `due_date` harus **snapshot** nilai `payment_term_days` customer pas invoice dibuat, biar perubahan termin customer gak retroaktif ngubah invoice lama.

**5. Invoice salah input cuma boleh dibatalkan kalau BELUM ada payment/alokasi masuk**
Koreksi "salah input" pakai reversing entry (constraint #2), tapi ada syarat tambahan: begitu ada `ar_payment_allocations` yang nunjuk ke invoice itu (walau baru sebagian/cicilan pertama), pembatalan via jalur ini **ditolak**. Alasannya: piutang itu udah "kesentuh" transaksi lain — udah ada duit customer beneran masuk dan teralokasi ke situ, jadi gak bisa dianggap "invoice ini gak pernah terjadi" lagi tanpa mikirin nasib pembayaran yang udah diterima (refund? realokasi ke invoice lain? itu keputusan bisnis terpisah, belum di-scope). Invoice yang berhasil dibatalkan otomatis keluar dari daftar outstanding/aging — statusnya derived dari cek "apakah journal entry-nya punya reversal", bukan kolom manual (konsisten sama prinsip status lunas/sebagian/belum).

## Skenario (lihat detail angka lengkap di `docs/story/accounts-receivable.md`)

1. Invoice lunas tepat waktu — kasus paling sederhana, 1 payment = 1 invoice, alokasi penuh.
2. Bayar sebagian (cicil) — 1 invoice, 2+ payment, tiap payment 1 baris alokasi ke invoice yang sama.
3. 1 payment nutup banyak invoice sekaligus — 1 payment, alokasi pecah ke beberapa invoice, tapi tetap cuma 1 journal entry (GL gak peduli breakdown per-invoice).
4. Telat bayar — query aging (`due_date < now()` dan belum lunas), read-side doang, gak butuh kolom/job tambahan.
5. Invoice dibatalkan (salah input, belum ada payment) — reversing entry via RPC `cancel_ar_invoice`, bukan hapus, sama kayak koreksi journal entry biasa. Ditolak kalau invoice udah punya alokasi payment (constraint #5).

## Common Mistakes

- Nyimpen `due_date` sebagai kolom yang dihitung ulang tiap baca dari `payment_term_days` customer saat ini — bikin invoice lama ikut geser kalau termin customer berubah. Harus snapshot pas insert.
- Nyimpen status "lunas/belum" sebagai kolom manual yang harus di-`UPDATE` tiap ada payment — resiko gak sinkron kalau ada bug/lupa update. Harus derived dari alokasi.
- Payment langsung `invoice_id` tanpa tabel alokasi — gak bisa nampung pembayaran gabungan/cicilan/overpay parsial.
- Invoice/payment insert langsung ke tabel AR tanpa lewat RPC yang juga bikin journal entry — piutang tercatat di AR tapi GL gak ke-update, dua sumber angka jadi gak sinkron.
- Alokasi ngelebihin amount invoice atau amount payment — duit "nutup" lebih dari yang sebenarnya ada.
- Batalin invoice yang udah ada payment/alokasi tanpa mikirin nasib pembayarannya — reversing entry doang bikin GL balance, tapi duit customer yang udah masuk jadi "nyantol" gak jelas. Harus ditolak di level RPC, bukan cuma diingetin di UI.

## Belum Termasuk (di luar scope fase ini)

- **Retur barang** — warung ngembaliin roti, invoice perlu dikurangi/dibatalkan sebagian. Butuh desain terpisah (credit note), belum di-scope.
- **Uang muka/DP sebelum invoice ada** — payment yang belum ada invoice buat dialokasikan (customer bayar duluan). Butuh keputusan desain terpisah (payment boleh "nganggur" belum teralokasi penuh), belum di-scope fase ini — asumsi awal: payment selalu dialokasikan penuh ke invoice yang udah ada saat itu juga.
- **Overpayment jadi saldo kredit customer** — kalau `SUM(allocations)` mau ngelebihin amount invoice, constraint #3 nolak; kasus "kelebihan bayar" jadi saldo kredit belum di-desain.
