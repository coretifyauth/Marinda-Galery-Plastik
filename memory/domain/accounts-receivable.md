# Accounts Receivable — AI Context

AR = lapisan tambahan di atas General Ledger buat nagih piutang termin: siapa berutang (customer), berapa/kapan jatuh tempo (invoice), udah dibayar berapa (payment + allocation). Tiap invoice/payment tetap wajib punya journal entry sendiri (Debit/Kredit sesuai kejadian) — AR gak bypass GL.

## Entitas

- **customer** — master data (bukan transaksional). Kolom kunci: `payment_term_days` (default termin, dipakai ngitung `due_date` invoice baru). Boleh di-`UPDATE` di tempat kalau termin berubah — gak ngaruh ke invoice lama karena `due_date` udah di-snapshot.
- **ar_invoice** — piutang timbul. Jurnal: Debit Piutang Usaha, Kredit Pendapatan. `due_date = invoice_date + customer.payment_term_days`, dihitung & disimpan **sekali** pas insert (bukan generated column dinamis).
- **ar_payment** — piutang berkurang, kejadian bayar nyata (bukan jadwal terjadwal). Jurnal: Debit Kas/Bank, Kredit Piutang Usaha, sejumlah **total** payment (gak peduli itu nutup berapa invoice).
- **ar_payment_allocation** — jembatan many-to-many payment↔invoice, `(payment_id, invoice_id, amount)`. Wajib ada karena hubungan payment-invoice gak selalu 1:1 (lihat Skenario).
- **Status invoice** (lunas/sebagian/belum) — derived dari `SUM(allocation.amount) WHERE invoice_id = X` dibanding `invoice.amount`. Bukan kolom manual (pola sama kayak `archived_at`/"published" di modul lain).

## Constraints (wajib ditegakkan di implementasi)

- **Journal-backed**: tiap `ar_invoice`/`ar_payment` wajib punya `journal_entry_id` yang nunjuk entry balance beneran — dibuat via RPC atomik (pola sama kayak `create_journal_entry`), bukan insert AR + insert GL terpisah dari client.
- **Immutability**: invoice/payment/allocation gak bisa di-UPDATE/DELETE setelah dibuat (RLS default-deny + trigger jaring kedua, pola sama `journal_entries`/`journal_lines`). Koreksi = reversing entry, bukan edit.
- **No over-allocation**: `SUM(allocation.amount)` per payment ≤ `ar_payment.amount`; `SUM(allocation.amount)` per invoice ≤ `ar_invoice.amount`.
- **`due_date` snapshot**: dihitung dari `payment_term_days` customer **pas invoice insert**, disimpan permanen. Perubahan `payment_term_days` customer setelahnya TIDAK boleh retroaktif ngubah `due_date` invoice lama.
- **Cancellation guard**: invoice cuma boleh dibatalkan (reversing entry via `cancel_ar_invoice`) kalau `ar_payment_allocations` buat invoice itu masih 0 baris. Begitu ada 1 alokasi (walau partial), pembatalan ditolak — piutang udah kesentuh transaksi lain, nasib pembayarannya jadi keputusan bisnis terpisah (belum di-scope).

## Skenario referensi (detail angka: `docs/story/accounts-receivable.md`)

| # | Kasus | Pola alokasi |
|---|---|---|
| 1 | Lunas tepat waktu | 1 payment → 1 invoice, penuh |
| 2 | Cicil | 1 invoice ← 2+ payment, tiap payment 1 baris alokasi |
| 3 | Bayar gabungan | 1 payment → banyak invoice, tapi tetap 1 journal entry |
| 4 | Telat bayar (aging) | Query read-side: `due_date < now()` dan belum lunas — gak butuh kolom/job baru |
| 5 | Invoice dibatalkan (belum ada payment) | Reversing entry via `cancel_ar_invoice`, invoice asli tetap ada di histori |

## Common mistakes to guard against

- `due_date` dihitung ulang tiap baca dari `payment_term_days` customer saat ini (bukan snapshot) — invoice lama ikut geser kalau termin berubah.
- Status lunas/belum sebagai kolom manual yang di-`UPDATE` tiap payment — resiko gak sinkron. Harus derived query.
- `ar_payments.invoice_id` langsung (tanpa tabel alokasi) — gak nampung payment gabungan/cicilan.
- Insert AR tanpa lewat RPC yang juga bikin journal entry — AR dan GL jadi dua sumber angka gak sinkron.
- Alokasi ngelebihin amount invoice atau amount payment.
- Batalin invoice yang udah ada alokasi payment tanpa guard — GL balance tapi duit customer yang udah masuk jadi nyantol gak jelas.

## Belum termasuk (di luar scope fase ini)

- Retur barang (credit note).
- Uang muka/DP sebelum ada invoice (payment belum teralokasi penuh) — asumsi sekarang: payment selalu dialokasikan penuh ke invoice yang udah ada.
- Overpayment jadi saldo kredit customer.

## Glossary

- **Customer**: master data pihak yang berutang (warung langganan).
- **AR Invoice**: piutang timbul dari 1 kejadian kirim barang/jasa dengan termin.
- **AR Payment**: 1 kejadian bayar nyata dari customer.
- **AR Payment Allocation**: pemetaan payment ke invoice yang dia lunasi, sejumlah tertentu.
- **Aging**: invoice yang `due_date`-nya udah lewat dan belum lunas.

Naratif lengkap + reasoning penuh: `docs/domain/accounts-receivable.md`.
