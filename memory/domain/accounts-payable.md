# Accounts Payable — AI Context

AP = kebalikan AR: CV Barokah berutang ke supplier, bukan piutang dari customer. Struktur tabel mirror persis AR (`memory/domain/accounts-receivable.md`), cuma beda 1 hal konteks bisnis: **di AR, kita nentuin `payment_term_days` buat customer; di AP, supplier yang nentuin termin buat kita.** Kolomnya tetap sama, cuma maknanya kebalik.

## Entitas

- **supplier** — master data. `payment_term_days` = syarat dari supplier (bukan kita yang set).
- **ap_bill** — utang timbul. Jurnal: Debit Persediaan/Beban (tergantung jenis pembelian, dipilih manual pas input — gak di-hardcode), Kredit Utang Usaha. `due_date = bill_date + supplier.payment_term_days`, snapshot pas insert.
- **ap_payment** — utang berkurang, kejadian bayar nyata. Jurnal: Debit Utang Usaha, Kredit Kas/Bank, sejumlah total payment.
- **ap_payment_allocation** — jembatan many-to-many payment↔bill, sama pola AR.
- **Status bill** (lunas/sebagian/belum/dibatalkan) — derived dari alokasi + cek reversal, sama pola AR.
- **ap_credit_note** — retur barang ke supplier (kebalikan `ar_credit_note`). Auto-detect jalur full/financial-only dari ada-gaknya `goods_receipt_notes.bill_id`, sama pola AR. **Beda mendasar dari AR**: ada 2 resolusi yang independen dari status bayar bill, dipilih manual sama orang yang input (pola sama milih `p_debit_account_id` di `create_ap_bill` — keputusan bisnis manusia, bukan hasil deteksi sistem):
  - **Opsi A — Kurangi Utang** (`create_ap_credit_note`) — Debit Utang Usaha / Kredit Persediaan Bahan Baku, **gak pakai akun kontra** (beda dari AR yang kontra-revenue) karena Persediaan itu akun neraca, boleh langsung dikurangi:
    - Bill belum lunas/sebagian → utang beneran berkurang.
    - Bill udah lunas penuh (atau retur ngelebihin sisa outstanding) → jurnal yang sama tetap jalan dulu (outstanding jadi minus) → excess-nya **otomatis** direklasifikasi jadi `ap_return_credits` (pola sama `ar_return_credits`, arah aset kebalik).
  - **Opsi B — Tukar Barang** (`create_purchase_replacement`) — **berdiri sendiri, gak lewat `ap_credit_notes` sama sekali** (beda dari AR `warranty_replacement` yang wajib nunjuk credit note dulu — AP sengaja gak niru pola itu karena kalau Opsi A dan B jalan bareng jadi kompensasi ganda dari sisi supplier). Berlaku sama persis di semua status bayar — Utang Usaha **gak pernah kesentuh**. Jurnal: Debit Persediaan Bahan Baku (barang baru) / Kredit Persediaan Bahan Baku (barang rusak) — net zero, murni reklasifikasi fisik.
  - **Cuma nanganin item Weighted Average** — bukan lagi "sementara", FIFO sudah dihapus total dari sistem (migration `0038_remove_fifo_costing.sql`), jadi Weighted Average satu-satunya jalur yang ada. Retur/tukar barang kurangin `inventory_balances.qty_on_hand` langsung (reuse pola `consume_weighted_average`), pakai `avg_cost` **saat itu** (bukan harga asal GRN — WA emang gak nyimpen asal-usul per lot).
- **ap_return_credits** — asset **"Piutang Retur Supplier"** (akun baru `1350`), mirror `ar_return_credits` tapi arah kebalik (di AR itu liability kita ke customer; di sini asset kita ke supplier — supplier "berutang" balik ke kita). **Sengaja akun terpisah dari rencana `Uang Muka Pembelian`** (`memory/scope-debt/ap-uang-muka-dp.md`) walau sekilas sama-sama "nilai kita di supplier" — beda asal jurnal (DP = bayar duluan sebelum barang datang; return credit = kelebihan setelah retur pada bill yang udah lunas), harus bisa ditelusuri balik terpisah. Partial-capable, 2 disposisi (mirror `ar_customer_credit`/`ar_return_credit`):
  - **ap_return_credit_applications** — dipakai motong bill lain: Debit Utang Usaha / Kredit Piutang Retur Supplier.
  - **ap_return_credit_refunds** — dicairkan tunai: Debit Kas/Bank / Kredit Piutang Retur Supplier.
  - Guard no-over-use: `SUM(applications.amount) + SUM(refunds.amount)` per `ap_return_credits` ≤ `amount`, pola sama `ar_customer_credits`.

## Constraints (wajib ditegakkan di implementasi)

- **Journal-backed**: tiap `ap_bill`/`ap_payment` wajib `journal_entry_id` valid, dibuat via RPC yang manggil `create_journal_entry`.
- **Immutability**: RLS default-deny + trigger jaring kedua, sama pola `journal_entries`/`ar_invoices`.
- **No over-allocation**: sama constraint AR, arah kebalik.
- **`due_date` snapshot**: dari `payment_term_days` supplier pas insert, gak retroaktif.
- **Cancellation guard**: `cancel_ap_bill` nolak kalau `ap_payment_allocations` bill itu udah ≥1 baris — **diterapkan dari awal** (beda dari AR yang nambah guard ini belakangan setelah kebukti perlu).
- **No over-return (kombinasi Opsi A + B)**: total qty retur (`purchase_return_lines`, jalur Opsi A full) + total qty tukar (`purchase_replacement_lines`, Opsi B) per item per bill gak boleh ngelebihin `goods_receipt_lines.qty_received` bill itu — guard trigger baru (checks gabungan 2 tabel), karena item Weighted Average gak punya proteksi otomatis per-lot (beda dari zaman FIFO masih ada, `inventory_lot_consumptions_no_over_consumption` sudah dihapus bareng FIFO di migration `0038`).
- **No over-use `ap_return_credits`**: `SUM(ap_return_credit_applications.amount) + SUM(ap_return_credit_refunds.amount)` per `ap_return_credits` ≤ `amount`.

## Skenario referensi (detail angka: `docs/story/accounts-payable.md`)

| # | Kasus | Beda dari AR |
|---|---|---|
| 1 | Lunas tepat waktu | Identik |
| 2 | Cicil | Identik |
| 3 | Bayar gabungan ke 1 supplier | Identik |
| 4 | Telat bayar (aging) | **Arah kebalik** — yang telat itu kita, resikonya supplier setop kirim, bukan piutang macet |
| 5 | Bill dibatalkan (belum ada payment) | Identik |
| 6 | Retur (Opsi A), bill belum lunas | Debit Utang Usaha / Kredit Persediaan, utang beneran berkurang |
| 7 | Retur (Opsi A), bill udah lunas | Jurnal sama + reklas excess ke `ap_return_credits` (Piutang Retur Supplier) |
| 8 | Retur (Opsi B) — tukar barang | Berdiri sendiri, Utang Usaha gak kesentuh, independen dari status bayar |
| 9 | Piutang Retur Supplier dipakai motong bill lain | Debit Utang Usaha / Kredit Piutang Retur Supplier |
| 10 | Piutang Retur Supplier dicairkan tunai | Debit Kas/Bank / Kredit Piutang Retur Supplier |

## Common mistakes to guard against

Sama semua yang di AR (`memory/domain/accounts-receivable.md`), arah kebalik. Tambahan khusus AP:
- Salah pilih akun debit bill (Persediaan vs Beban) — RPC generik terima parameter, gak dicegah sistem.
- Opsi A dan Opsi B (retur) dianggap bisa jalan bareng buat 1 kejadian retur yang sama — itu kompensasi ganda dari sisi supplier, harus pilih SALAH SATU.
- Excess dari retur (Opsi A pada bill lunas) dianggap otomatis berarti barang harus diganti (Opsi B) — dua-duanya independen, pilihan resolusi bukan konsekuensi status bayar.
- Barang rusak yang gak dapat kompensasi sama sekali (supplier nolak ganti/kurangi utang) dicatat lewat jalur retur — itu kasus terpisah (write-off/spoilage), lihat `memory/scope-debt/kerugian-barang-rusak.md`.

## Belum termasuk (di luar scope fase ini)

Detail: `memory/scope-debt/ap-diskon-bayar-cepat.md` (gak ada padanan di AR), `memory/scope-debt/ap-uang-muka-dp.md`, `memory/scope-debt/ap-bill-compound.md`, `memory/scope-debt/kerugian-barang-rusak.md` (barang rusak tanpa kompensasi dari supplier — lintas modul AR & AP). Batas waktu retur (mirror `return_window_days` AR) sengaja gak dimasukkan ke fitur ini dan gak akan digarap.

## Glossary

- **Supplier**: master data pihak yang CV Barokah berutang (2 supplier bahan baku).
- **AP Bill**: utang timbul dari 1 kejadian ambil barang/jasa dengan termin dari supplier.
- **AP Payment**: 1 kejadian bayar nyata ke supplier.
- **AP Payment Allocation**: pemetaan payment ke bill yang dia lunasi.
- **AP Credit Note**: retur barang ke supplier — 2 jalur resolusi independen (Opsi A kurangi utang, Opsi B tukar barang), beda dari AR yang cuma 1 jalur (+ replacement sebagai tambahan, bukan alternatif).
- **Piutang Retur Supplier**: asset baru (`1350`), saldo yang supplier "berutang" ke kita dari retur pada bill yang udah lunas — partial-capable, bisa dipakai motong bill lain atau dicairkan tunai.
- **Purchase Replacement**: tukar barang rusak dengan barang baik dari supplier, gak nyentuh Utang Usaha sama sekali — berdiri sendiri, gak butuh credit note.

Naratif lengkap + reasoning penuh: `docs/domain/accounts-payable.md`.
