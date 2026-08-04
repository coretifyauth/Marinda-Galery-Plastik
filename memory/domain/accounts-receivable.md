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

## Common mistakes to guard against

- `due_date` dihitung ulang tiap baca dari `payment_term_days` customer saat ini (bukan snapshot) — invoice lama ikut geser kalau termin berubah.
- Status lunas/belum sebagai kolom manual yang di-`UPDATE` tiap payment — resiko gak sinkron. Harus derived query.
- `ar_payments.invoice_id` langsung (tanpa tabel alokasi) — gak nampung payment gabungan/cicilan.
- Insert AR tanpa lewat RPC yang juga bikin journal entry — AR dan GL jadi dua sumber angka gak sinkron.
- Alokasi ngelebihin amount invoice atau amount payment.
- Batalin invoice yang udah ada alokasi payment tanpa guard — GL balance tapi duit customer yang udah masuk jadi nyantol gak jelas.
- Cek credit hold cuma di UI (skippable) — harus hard-reject di RPC.
- Simpen status "on hold" sebagai kolom manual — harus derived tiap invoice baru dicek.

## Belum termasuk (di luar scope fase ini)

- Uang muka/DP sebelum ada invoice (payment belum teralokasi penuh) — asumsi sekarang: payment selalu dialokasikan penuh ke invoice yang udah ada.
- Overpayment jadi saldo kredit customer (termasuk hasil retur yang bikin outstanding negatif) — refund/pemakaian saldo kredit belum didesain.
- Penggantian barang gratis pasca-retur (`memory/scope-debt/ar-penggantian-barang-retur.md`) — butuh RPC keluar stok+HPP tanpa invoice baru.

## Glossary

- **Customer**: master data pihak yang berutang (warung langganan).
- **AR Invoice**: piutang timbul dari 1 kejadian kirim barang/jasa dengan termin.
- **AR Payment**: 1 kejadian bayar nyata dari customer.
- **AR Payment Allocation**: pemetaan payment ke invoice yang dia lunasi, sejumlah tertentu.
- **Credit Hold**: kondisi derived, customer ditolak bikin invoice baru karena outstanding/keterlambatan kelampaui batasnya.
- **Aging**: invoice yang `due_date`-nya udah lewat dan belum lunas.
- **AR Credit Note**: retur barang yang udah diinvoice — ngurangin outstanding invoice tanpa ubah `amount` asli, beda dari `cancel_ar_invoice`.

Naratif lengkap + reasoning penuh: `docs/domain/accounts-receivable.md`.
