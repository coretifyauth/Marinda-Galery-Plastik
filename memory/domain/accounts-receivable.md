# Accounts Receivable — AI Context

AR = lapisan tambahan di atas General Ledger buat nagih piutang termin: siapa berutang (customer), berapa/kapan jatuh tempo (invoice), udah dibayar berapa (payment + allocation). Tiap invoice/payment tetap wajib punya journal entry sendiri (Debit/Kredit sesuai kejadian) — AR gak bypass GL.

## Entitas

- **customer** — master data (bukan transaksional). Kolom kunci: `payment_term_days` (default termin, dipakai ngitung `due_date` invoice baru), `credit_limit` (nullable, batas nominal piutang open sebelum hold), `overdue_threshold_days` (nullable, toleransi hari telat sebelum hold — default di-prefill = `payment_term_days` pas customer dibuat, tapi kolom independen). Boleh di-`UPDATE` di tempat kalau termin/limit berubah — gak ngaruh ke invoice lama karena `due_date` udah di-snapshot.
- **ar_invoice** — piutang timbul. Jurnal: Debit Piutang Usaha, Kredit Pendapatan. `due_date = invoice_date + customer.payment_term_days`, dihitung & disimpan **sekali** pas insert (bukan generated column dinamis).
- **ar_payment** — piutang berkurang, kejadian bayar nyata (bukan jadwal terjadwal). Jurnal: Debit Kas/Bank, Kredit Piutang Usaha, sejumlah **total** payment (gak peduli itu nutup berapa invoice).
- **ar_payment_allocation** — jembatan many-to-many payment↔invoice, `(payment_id, invoice_id, amount)`. Wajib ada karena hubungan payment-invoice gak selalu 1:1 (lihat Skenario).
- **Status invoice** (lunas/sebagian/belum) — derived dari `SUM(allocation.amount) WHERE invoice_id = X` dibanding `invoice.amount`. Bukan kolom manual (pola sama kayak `archived_at`/"published" di modul lain).
- **ar_credit_note** — retur barang (bukan koreksi salah input). Beda `cancel_ar_invoice`: partial-capable, tetap bisa dibuat walau invoice udah ada alokasi payment, invoice asli gak diedit/dibatalkan. Dua jalur, auto-detect dari ada-gaknya baris `goods_issues.invoice_id`:
  - **Financial-only** (invoice gak lewat `create_goods_issue`): 1 jurnal, Debit `Retur & Potongan Penjualan` (akun kontra-revenue baru, `is_contra=true`) / Kredit Piutang Usaha.
  - **Full** (invoice lewat `create_goods_issue`): 2 jurnal — kontra-revenue di atas + Debit Persediaan Barang Jadi / Kredit HPP sejumlah cost proporsional dari `goods_issue_lines.total_cost` snapshot asli (bukan harga sekarang). Barang balik masuk lot baru (`source_type = SALES_RETURN`, FIFO) atau nambah `inventory_balances` (Weighted Average).
  - Independen dari status bayar invoice — kalau invoice udah lunas, retur bikin outstanding negatif (saldo kredit customer, penanganannya di luar scope, lihat "Belum termasuk").
- **warranty_replacement** — penggantian barang gratis pasca-retur (jalur full). Wajib referensi ke `ar_credit_note` yang punya `inventory_returns` (bukti barang emang balik). Jurnal: Debit HPP / Kredit Persediaan Barang Jadi — gak nyentuh Piutang/Pendapatan. Qty diganti (akumulasi) ≤ qty yang diretur di credit note itu (per item), pola no-over-return. Barang pengganti diambil dari stok fresh (FIFO/Weighted Average biasa), bukan dari lot `SALES_RETURN`.
- **ar_deposit** — uang muka/DP diterima sebelum invoice ada. **Bukan** `ar_payment` — jurnalnya Debit Kas / Kredit `Uang Muka Penjualan` (liability baru, akun `2300`), gak nyentuh Piutang Usaha sama sekali (piutangnya belum ada). 3 kejadian turunan, masing-masing tabel anak sendiri (immutable, status deposit derived dari situ, bukan kolom):
  - **ar_deposit_application** — DP diterapkan ke invoice yang udah diterbitkan penuh. Jurnal: Debit Uang Muka Penjualan / Kredit Piutang Usaha (reklasifikasi, ngurangin outstanding invoice).
  - **ar_deposit_forfei/ture** — DP hangus, order dibatalin SEBELUM invoice ada (kebijakan: DP gak direfund). Jurnal: Debit Uang Muka Penjualan / Kredit `Pendapatan Lain-lain` (akun `4300`, baru — BUKAN `Pendapatan Penjualan`, biar gak nyampur sama hasil jualan beneran).
  - 1 deposit cuma boleh punya **1 disposisi aktif** (diterapkan ATAU hangus, gak dua-duanya) — trigger jaga ini, sama pola no-over-allocation.
  - **`cancel_ar_invoice` diperluas**: kalau invoice yang dibatalin punya `ar_deposit_applications`, RPC ikut manggil `reverse_journal_entry` buat jurnal application-nya juga (bukan cuma jurnal invoice) — DP-nya otomatis balik status "belum dipakai". Ini beda dari guard `ar_payment_allocations` (yang cuma nolak keras) — dipilih auto-unwind karena nolak doang gak nyelesaiin apa-apa buat kasus DP (duitnya nyangkut gak jelas kalau cuma diblok).
- **ar_customer_credit** — kelebihan bayar 1 payment event di atas total alokasi ke invoice. **Beda dari `ar_deposit`**: piutang udah ada & udah kesentuh (invoice ternutup penuh via alokasi normal), bukan bayar sebelum piutang ada. `record_ar_payment` diperluas: kalau `p_amount > SUM(p_allocations.amount)`, excess-nya masuk baris jurnal ke-3 (Kredit `Saldo Kredit Customer`, akun liability baru — beda dari `Uang Muka Penjualan` karena beda asal jurnal) dalam **journal entry yang sama** (1 payment event = 1 bukti transfer = 1 entry, bukan 2 payment terpisah), dan insert 1 baris `ar_customer_credits` (customer_id, source `payment_id`, amount = excess).
  - **ar_customer_credit_application** — kredit dipakai motong invoice lain (kapan aja ke depan, gak harus invoice berikutnya). Jurnal: Debit Saldo Kredit Customer / Kredit Piutang Usaha.
  - **ar_customer_credit_refund** — kredit direfund tunai. Jurnal: Debit Saldo Kredit Customer / Kredit Kas/Bank.
  - Beda dari `ar_deposit` (1 disposisi aktif doang): kredit ini bisa dipakai **sebagian-sebagian, berkali-kali** (application + refund berulang) sampai habis — pola lebih mirip `ar_payment_allocations` (partial-capable) daripada disposisi tunggal DP. Guard: `SUM(applications.amount) + SUM(refunds.amount)` per credit ≤ `ar_customer_credits.amount`.

## Constraints (wajib ditegakkan di implementasi)

- **Journal-backed**: tiap `ar_invoice`/`ar_payment` wajib punya `journal_entry_id` yang nunjuk entry balance beneran — dibuat via RPC atomik (pola sama kayak `create_journal_entry`), bukan insert AR + insert GL terpisah dari client.
- **Immutability**: invoice/payment/allocation gak bisa di-UPDATE/DELETE setelah dibuat (RLS default-deny + trigger jaring kedua, pola sama `journal_entries`/`journal_lines`). Koreksi = reversing entry, bukan edit.
- **No over-allocation**: `SUM(allocation.amount)` per payment ≤ `ar_payment.amount`; `SUM(allocation.amount)` per invoice ≤ `ar_invoice.amount`.
- **`due_date` snapshot**: dihitung dari `payment_term_days` customer **pas invoice insert**, disimpan permanen. Perubahan `payment_term_days` customer setelahnya TIDAK boleh retroaktif ngubah `due_date` invoice lama.
- **Cancellation guard**: invoice cuma boleh dibatalkan (reversing entry via `cancel_ar_invoice`) kalau `ar_payment_allocations` buat invoice itu masih 0 baris. Begitu ada 1 alokasi (walau partial), pembatalan ditolak — piutang udah kesentuh transaksi lain, nasib pembayarannya jadi keputusan bisnis terpisah (belum di-scope).
- **Credit hold**: `create_ar_invoice` hard-reject kalau customer kelampaui `credit_limit` (total outstanding open) ATAU ada invoice open yang overdue lebih dari `overdue_threshold_days`-nya (OR, bukan AND). Status hold gak disimpan, derived tiap kali RPC dipanggil. NULL di salah satu kolom = batas itu gak berlaku buat customer itu. Cash sale ke customer on-hold gak lewat `ar_invoices` sama sekali (langsung jurnal Debit Kas/Kredit Pendapatan, di luar scope AR).
- **No over-return**: total `ar_credit_note` (akumulasi) per invoice gak boleh ngelebihin `ar_invoice.amount` (jalur financial-only) atau `qty_issued` baris `goods_issue_lines`-nya (jalur full) — pola sama no-over-allocation.
- **Return window (per item)**: `items.return_window_days` (nullable, `NULL`=gak dibatasi). `create_ar_credit_note` cek tiap baris jalur full: `credit_note_date - invoice_date > items.return_window_days` → reject. Ditaro per item (bukan per customer/global) karena soal umur simpan fisik barang, bukan hubungan dagang.
- **Period-closing tetap berlaku**: retur ke periode tertutup ditolak otomatis lewat `journal_entries_block_retroactive_into_closed_period` (reuse, gak ada constraint baru).
- **Penggantian gratis wajib nunjuk credit note jalur full**: `warranty_replacement.credit_note_id` harus punya baris `inventory_returns` yang match — kalau credit note-nya financial-only (gak ada retur fisik), RPC `raise exception`.
- **No over-replace**: `SUM(qty)` `warranty_replacement_lines` (akumulasi, per item, per credit note) ≤ `SUM(qty_returned)` `inventory_return_lines` item itu di credit note yang sama.
- **Overpayment split dalam 1 journal entry**: `record_ar_payment` gak boleh split excess jadi payment/entry terpisah — 1 bukti transfer = 1 entry (3 baris kalau ada excess: Kas, Piutang Usaha, Saldo Kredit Customer).
- **No over-use saldo kredit**: `SUM(ar_customer_credit_applications.amount) + SUM(ar_customer_credit_refunds.amount)` per `ar_customer_credits` ≤ `ar_customer_credits.amount`.

## Skenario referensi (detail angka: `docs/story/accounts-receivable.md`)

| # | Kasus | Pola alokasi |
|---|---|---|
| 1 | Lunas tepat waktu | 1 payment → 1 invoice, penuh |
| 2 | Cicil | 1 invoice ← 2+ payment, tiap payment 1 baris alokasi |
| 3 | Bayar gabungan | 1 payment → banyak invoice, tapi tetap 1 journal entry |
| 4 | Telat bayar (aging) | Query read-side: `due_date < now()` dan belum lunas — gak butuh kolom/job baru |
| 5 | Invoice dibatalkan (belum ada payment) | Reversing entry via `cancel_ar_invoice`, invoice asli tetap ada di histori |
| 6 | Credit hold | `create_ar_invoice` ditolak: outstanding > `credit_limit` ATAU overdue terlama > `overdue_threshold_days` |
| 7 | Retur, financial-only | 1 jurnal kontra-revenue, outstanding turun |
| 8 | Retur, full (via goods_issue), udah lunas | 2 jurnal (kontra-revenue + reversal HPP), stok balik, outstanding jadi negatif |
| 9 | DP diterima lalu diterapkan penuh ke invoice | 3 jurnal terpisah (terima DP, terbitkan invoice, terapkan DP) |
| 10 | DP hangus (order dibatalin sebelum invoice ada) | 1 jurnal, Uang Muka Penjualan → Pendapatan Lain-lain, gak pernah ada invoice |
| 11 | Invoice dengan DP-application dibatalkan | `cancel_ar_invoice` reverse jurnal invoice + jurnal application, DP balik "belum dipakai" |
| 12 | Penggantian barang gratis pasca-retur | 1 jurnal (HPP/Persediaan Barang Jadi), referensi credit note jalur full, gak nyentuh Piutang/Pendapatan |
| 13 | Overpayment — payment > invoice, excess jadi saldo kredit | 1 payment event, 1 journal entry 3 baris (Kas, Piutang Usaha, Saldo Kredit Customer) |
| 14 | Saldo kredit dipakai motong invoice lain | Debit Saldo Kredit Customer / Kredit Piutang Usaha, partial-capable |
| 15 | Saldo kredit direfund tunai | Debit Saldo Kredit Customer / Kredit Kas |

## Common mistakes to guard against

- `due_date` dihitung ulang tiap baca dari `payment_term_days` customer saat ini (bukan snapshot) — invoice lama ikut geser kalau termin berubah.
- Status lunas/belum sebagai kolom manual yang di-`UPDATE` tiap payment — resiko gak sinkron. Harus derived query.
- `ar_payments.invoice_id` langsung (tanpa tabel alokasi) — gak nampung payment gabungan/cicilan.
- Insert AR tanpa lewat RPC yang juga bikin journal entry — AR dan GL jadi dua sumber angka gak sinkron.
- Alokasi ngelebihin amount invoice atau amount payment.
- Batalin invoice yang udah ada alokasi payment tanpa guard — GL balance tapi duit customer yang udah masuk jadi nyantol gak jelas.
- Cek credit hold cuma di UI (skippable) — harus hard-reject di RPC.
- Simpen status "on hold" sebagai kolom manual — harus derived tiap invoice baru dicek.
- DP diterima langsung dicatat ngurangin Piutang Usaha atau jadi Pendapatan — piutangnya belum ada, barang/jasanya belum diserahkan. Harus lewat `Uang Muka Penjualan` (liability) dulu.
- DP hangus dicatat ke `Pendapatan Penjualan` — harus ke `Pendapatan Lain-lain`, biar gak nyampur sama pendapatan jualan beneran.
- `cancel_ar_invoice` cuma reverse jurnal invoice-nya doang tanpa ikut reverse jurnal `ar_deposit_applications` — Piutang Usaha customer itu nyasar jadi minus, DP-nya nyangkut gak jelas status.
- Penggantian barang gratis lewat `create_goods_issue` biasa — bikin piutang/pendapatan palsu.
- Penggantian barang gratis tanpa referensi ke credit note — kehilangan audit trail.
- Barang pengganti diambil dari lot `SALES_RETURN` — harusnya stok fresh.
- Overpayment dicatat sebagai 2 payment terpisah — harus 1 event, 1 entry.
- Excess overpayment ke `Uang Muka Penjualan` — harus ke `Saldo Kredit Customer`, beda asal jurnal dari DP.
- Saldo kredit dipakai/refund ngelebihin nominal awal — harus ditolak trigger, pola no-over-allocation.

## Belum termasuk (di luar scope fase ini)

- **Retur yang bikin outstanding invoice negatif** — beda mekanisme dari overpayment payment (yang di atas udah di-scope): retur ngurangin `amount` piutang lewat kontra-revenue, bukan lewat kelebihan kas. Penanganan saldo kreditnya masih belum didesain.

## Glossary

- **Customer**: master data pihak yang berutang (warung langganan).
- **AR Invoice**: piutang timbul dari 1 kejadian kirim barang/jasa dengan termin.
- **AR Payment**: 1 kejadian bayar nyata dari customer, terhadap invoice yang udah ada.
- **AR Payment Allocation**: pemetaan payment ke invoice yang dia lunasi, sejumlah tertentu.
- **Credit Hold**: kondisi derived, customer ditolak bikin invoice baru karena outstanding/keterlambatan kelampaui batasnya.
- **Aging**: invoice yang `due_date`-nya udah lewat dan belum lunas.
- **AR Credit Note**: retur barang yang udah diinvoice — ngurangin outstanding invoice tanpa ubah `amount` asli, beda dari `cancel_ar_invoice`.
- **AR Deposit**: uang muka diterima sebelum invoice ada, dicatat ke liability `Uang Muka Penjualan` — beda dari `AR Payment` yang selalu terhadap invoice existing.
- **Warranty Replacement**: penggantian barang gratis pasca-retur — keluar stok+HPP tanpa invoice/piutang baru, wajib referensi credit note jalur full.
- **AR Customer Credit**: kelebihan bayar 1 payment event di atas invoice yang ditutup — liability `Saldo Kredit Customer`, beda asal dari `AR Deposit`, bisa dipakai/refund parsial berkali-kali.

Naratif lengkap + reasoning penuh: `docs/domain/accounts-receivable.md`.
