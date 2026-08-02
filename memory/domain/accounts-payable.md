# Accounts Payable — AI Context

AP = kebalikan AR: CV Barokah berutang ke supplier, bukan piutang dari customer. Struktur tabel mirror persis AR (`memory/domain/accounts-receivable.md`), cuma beda 1 hal konteks bisnis: **di AR, kita nentuin `payment_term_days` buat customer; di AP, supplier yang nentuin termin buat kita.** Kolomnya tetap sama, cuma maknanya kebalik.

## Entitas

- **supplier** — master data. `payment_term_days` = syarat dari supplier (bukan kita yang set).
- **ap_bill** — utang timbul. Jurnal: Debit Persediaan/Beban (tergantung jenis pembelian, dipilih manual pas input — gak di-hardcode), Kredit Utang Usaha. `due_date = bill_date + supplier.payment_term_days`, snapshot pas insert.
- **ap_payment** — utang berkurang, kejadian bayar nyata. Jurnal: Debit Utang Usaha, Kredit Kas/Bank, sejumlah total payment.
- **ap_payment_allocation** — jembatan many-to-many payment↔bill, sama pola AR.
- **Status bill** (lunas/sebagian/belum/dibatalkan) — derived dari alokasi + cek reversal, sama pola AR.

## Constraints (wajib ditegakkan di implementasi)

- **Journal-backed**: tiap `ap_bill`/`ap_payment` wajib `journal_entry_id` valid, dibuat via RPC yang manggil `create_journal_entry`.
- **Immutability**: RLS default-deny + trigger jaring kedua, sama pola `journal_entries`/`ar_invoices`.
- **No over-allocation**: sama constraint AR, arah kebalik.
- **`due_date` snapshot**: dari `payment_term_days` supplier pas insert, gak retroaktif.
- **Cancellation guard**: `cancel_ap_bill` nolak kalau `ap_payment_allocations` bill itu udah ≥1 baris — **diterapkan dari awal** (beda dari AR yang nambah guard ini belakangan setelah kebukti perlu).

## Skenario referensi (detail angka: `docs/story/accounts-payable.md`)

| # | Kasus | Beda dari AR |
|---|---|---|
| 1 | Lunas tepat waktu | Identik |
| 2 | Cicil | Identik |
| 3 | Bayar gabungan ke 1 supplier | Identik |
| 4 | Telat bayar (aging) | **Arah kebalik** — yang telat itu kita, resikonya supplier setop kirim, bukan piutang macet |
| 5 | Bill dibatalkan (belum ada payment) | Identik |

## Common mistakes to guard against

Sama semua yang di AR (`memory/domain/accounts-receivable.md`), arah kebalik. Tambahan khusus AP: salah pilih akun debit bill (Persediaan vs Beban) — RPC generik terima parameter, gak dicegah sistem.

## Belum termasuk (di luar scope fase ini)

Detail: `memory/scope-debt/ap-retur-barang.md`, `ap-diskon-bayar-cepat.md` (gak ada padanan di AR), `ap-uang-muka-dp.md`, `ap-bill-compound.md`.

## Glossary

- **Supplier**: master data pihak yang CV Barokah berutang (2 supplier bahan baku).
- **AP Bill**: utang timbul dari 1 kejadian ambil barang/jasa dengan termin dari supplier.
- **AP Payment**: 1 kejadian bayar nyata ke supplier.
- **AP Payment Allocation**: pemetaan payment ke bill yang dia lunasi.

Naratif lengkap + reasoning penuh: `docs/domain/accounts-payable.md`.
