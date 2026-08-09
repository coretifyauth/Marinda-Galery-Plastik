# Accounts Payable — AI Context

AP = kebalikan AR: CV Barokah berutang ke supplier, bukan piutang dari customer. Struktur tabel mirror persis AR (`memory/domain/accounts-receivable.md`), cuma beda 1 hal konteks bisnis: **di AR, kita nentuin `payment_term_days` buat customer; di AP, supplier yang nentuin termin buat kita.** Kolomnya tetap sama, cuma maknanya kebalik.

Naratif lengkap + reasoning penuh: `docs/domain/accounts-payable.md`. Struktur module → submodule di file ini SAMA urutannya dengan padanan naratif itu dan dengan `memory/architecture/data/ap-schema.md` (lihat `AGENTS.md` > "Format Baku: Struktur Module → Submodule").

## Konsep Inti

**Entitas & Jurnal**
- **supplier** — master data. `payment_term_days` = syarat dari supplier (bukan kita yang set).
- **ap_bill** — utang timbul. Jurnal: Debit Persediaan/Beban (tergantung jenis pembelian, dipilih manual pas input — gak di-hardcode), Kredit Utang Usaha. `due_date = bill_date + supplier.payment_term_days`, snapshot pas insert. **Catatan terbuka**: RPC pembuatan bill cuma nampung 1 akun debit per panggilan — nota supplier yang isinya campuran kategori (misal barang + ongkos kirim dalam 1 nota fisik) belum tertampung, ref `memory/scope-debt/ap-bill-compound.md`.
- **ap_payment** — utang berkurang, kejadian bayar nyata. Selalu nutup 1 bill spesifik (`bill_id` FK langsung, gak lewat tabel jembatan lagi sejak migration `0011_ap_payment_single_bill.sql`), boleh cicil (gak `unique`, 1 bill boleh punya banyak baris payment), gak boleh overpay. Jurnal: Debit Utang Usaha, Kredit Kas/Bank, sejumlah yang beneran dibayar. **Sebelum `0011`**, AP justru lebih longgar dari AR pasca-`0010` — ada tabel jembatan `ap_payment_allocations` (many-to-many) yang ngizinin 1 payment dipecah ke banyak bill sekaligus ("bayar gabungan"). `0011` mencabut itu total demi selaras filosofi AR: payment boleh cicil ke 1 bill, tapi gak boleh disebar ke banyak obligasi dalam 1 transaksi.
- **Status bill** (lunas/sebagian/belum/dibatalkan) — derived dari `SUM(ap_payments.amount)` + cek reversal, sama pola AR.

**Constraints**
- **Journal-backed**: tiap `ap_bill`/`ap_payment` wajib `journal_entry_id` valid, dibuat via RPC yang manggil `create_journal_entry`.
- **Immutability**: RLS default-deny + trigger jaring kedua, sama pola `journal_entries`/`ar_invoices`.
- **No overpay, boleh cicil**: `record_ap_payment` nolak kalau `p_amount > ap_bill_remaining(p_bill_id)` — sama constraint AR pasca-`0010`.
- **`due_date` snapshot**: dari `payment_term_days` supplier pas insert, gak retroaktif.
- **Cancellation guard**: `cancel_ap_bill` nolak kalau `ap_payments` bill itu udah ≥1 baris — **diterapkan dari awal** (beda dari AR yang nambah guard ini belakangan setelah kebukti perlu).
- **Bayar gabungan gak didukung**: `record_ap_payment` cuma nerima 1 `p_bill_id` — gak ada lagi jalur "1 payment nutup beberapa bill sekaligus" sejak `0011`.

**Skenario referensi** (detail angka: `docs/story/accounts-payable.md`)

| # | Kasus | Beda dari AR |
|---|---|---|
| 1 | Lunas tepat waktu | Identik |
| 2 | Cicil (`0010`/`0011`) | Identik |
| 3 | Payment ditolak — overpay atau coba bayar gabungan | Identik — `p_bill_id` tunggal, gak ada lagi "bayar gabungan" sejak `0011` |
| 4 | Telat bayar (aging) | **Arah kebalik** — yang telat itu kita, resikonya supplier setop kirim, bukan piutang macet |
| 5 | Bill dibatalkan (belum ada payment) | Identik |

**Common Mistakes**
- Sama semua common mistake di AR (`memory/domain/accounts-receivable.md`), arah kebalik: due_date dihitung ulang dinamis (harusnya snapshot), status disimpan manual (harusnya derived), insert AP tanpa lewat RPC yang juga bikin journal entry, payment ngelebihin sisa outstanding bill (overpay — kurang/cicil boleh, itu bukan mistake), batalin bill yang udah ada payment tanpa guard.
- Salah pilih akun debit bill (Persediaan vs Beban) — RPC generik terima parameter, gak dicegah sistem.

## Retur Barang ke Supplier

**Entitas & Jurnal**
- **ap_credit_note** — retur barang ke supplier (kebalikan `ar_credit_note`). Auto-detect jalur full/financial-only dari ada-gaknya `goods_receipt_notes.bill_id`, sama pola AR. **Beda mendasar dari AR**: ada 2 resolusi yang independen dari status bayar bill, dipilih manual sama orang yang input (pola sama milih `p_debit_account_id` di `create_ap_bill` — keputusan bisnis manusia, bukan hasil deteksi sistem):
  - **Opsi A — Kurangi Utang** (`create_ap_credit_note`) — Debit Utang Usaha / Kredit Persediaan Bahan Baku, **gak pakai akun kontra** (beda dari AR yang kontra-revenue) karena Persediaan itu akun neraca, boleh langsung dikurangi:
    - Bill belum lunas/sebagian → utang beneran berkurang.
    - Bill udah lunas penuh (atau retur ngelebihin sisa outstanding) → jurnal yang sama tetap jalan dulu (outstanding jadi minus) → excess-nya **otomatis** direklasifikasi jadi `ap_return_credits` (pola sama `ar_return_credits`, arah aset kebalik).
  - **Opsi B — Tukar Barang** (`create_purchase_replacement`) — **berdiri sendiri, gak lewat `ap_credit_notes` sama sekali** (beda dari AR `warranty_replacement` yang wajib nunjuk credit note dulu — AP sengaja gak niru pola itu karena kalau Opsi A dan B jalan bareng jadi kompensasi ganda dari sisi supplier). Berlaku sama persis di semua status bayar — Utang Usaha **gak pernah kesentuh**. Jurnal: Debit Persediaan Bahan Baku (barang baru) / Kredit Persediaan Bahan Baku (barang rusak) — net zero, murni reklasifikasi fisik.
  - **Cuma nanganin item Weighted Average** — bukan lagi "sementara", FIFO sudah dihapus total dari sistem (migration `0038_remove_fifo_costing.sql`), jadi Weighted Average satu-satunya jalur yang ada. Retur/tukar barang kurangin `inventory_balances.qty_on_hand` langsung (reuse pola `consume_weighted_average`), pakai `avg_cost` **saat itu** (bukan harga asal GRN — WA emang gak nyimpen asal-usul per lot).
  - **Batas waktu retur** sengaja gak dimasukkan dan gak akan digarap (bukan scope-debt, keputusan final) — AR sendiri sempat punya validasi serupa (`return_window_days`) tapi udah dicabut total (migration `0039`), jadi gak ada lagi padanan buat di-mirror.
  - **Opsi C — Tulis-jadi-Beban / Write-off** (`create_purchase_writeoff`) — supplier **nolak kompensasi sama sekali** (gak kurangin utang, gak kirim pengganti). Beda dari Opsi A: Utang Usaha **gak pernah kesentuh**. Beda dari Opsi B: bukan reklasifikasi net-nol, barangnya beneran hilang nilainya. Berdiri sendiri (gak lewat `ap_credit_notes`), sama pola Opsi B. Jurnal: Debit **Beban Kerugian Barang Rusak** (akun baru, expense) / Kredit Persediaan Bahan Baku.
- **ap_return_credits** — asset **"Piutang Retur Supplier"** (akun baru `1350`), mirror `ar_return_credits` tapi arah kebalik (di AR itu liability kita ke customer; di sini asset kita ke supplier — supplier "berutang" balik ke kita). **Sengaja akun terpisah dari `Uang Muka Pembelian`** (akun `1360`, lihat `ap_deposit` di submodule "Uang Muka / DP ke Supplier") walau sekilas sama-sama "nilai kita di supplier" — beda asal jurnal (DP = bayar duluan sebelum barang datang; return credit = kelebihan setelah retur pada bill yang udah lunas), harus bisa ditelusuri balik terpisah. Partial-capable, **1 disposisi**:
  - **ap_return_credit_refunds** — dicairkan tunai: Debit Kas/Bank / Kredit Piutang Retur Supplier.
  - Guard no-over-use: `SUM(refunds.amount)` per `ap_return_credits` ≤ `amount`.
  - Sempat ada disposisi kedua ("dipakai motong bill lain", `ap_return_credit_applications`) — dicabut migration `0009_ap_remove_return_credit_apply.sql`, keputusan bisnis (2026-08-08): bukan fondasi AP, saldo tetap tertelusuri lewat refund tunai.

**Constraints**
- **No over-return (kombinasi Opsi A + B + C)**: total qty retur (`purchase_return_lines`, Opsi A full) + total qty tukar (`purchase_replacement_lines`, Opsi B) + total qty write-off (`purchase_writeoff_lines`, Opsi C) per item per bill gak boleh ngelebihin `goods_receipt_lines.qty_received` bill itu — guard trigger (`purchase_returned_qty()`, sekarang jumlahin dari 3 tabel bukan 2), karena item Weighted Average gak punya proteksi otomatis per-lot (beda dari zaman FIFO masih ada, `inventory_lot_consumptions_no_over_consumption` sudah dihapus bareng FIFO di migration `0038`). Batasnya di level fisik (qty diterima), bukan per-mekanisme — makanya 1 bill boleh dipecah campuran antara ketiga opsi, otomatis partial-capable tanpa butuh fungsi `*_remaining()` terpisah kayak `ap_deposit_remaining()`.
- **No over-use `ap_return_credits`**: `SUM(ap_return_credit_refunds.amount)` per `ap_return_credits` ≤ `amount`.
- Opsi A dan Opsi B saling eksklusif **per unit barang yang sama** — 1 porsi qty yang sama gak bisa diklaim lewat lebih dari 1 opsi (otomatis terjaga karena qty gabungan dibatasi `purchase_returned_qty()` di atas), tapi beda porsi qty dalam 1 bill yang sama boleh dipecah ke opsi berbeda-beda (misal 4kg lewat Opsi A, 2kg lewat Opsi C, sisanya gak diklaim sama sekali).
- Retur ke periode tertutup ditolak otomatis (reuse aturan umum GL, bukan constraint khusus retur).

**Skenario referensi**

| # | Kasus | Beda dari AR |
|---|---|---|
| 6 | Retur (Opsi A), bill belum lunas | Debit Utang Usaha / Kredit Persediaan, utang beneran berkurang |
| 7 | Retur (Opsi A), bill udah lunas | Jurnal sama + reklas excess ke `ap_return_credits` (Piutang Retur Supplier) |
| 8 | Retur (Opsi B) — tukar barang | Berdiri sendiri, Utang Usaha gak kesentuh, independen dari status bayar |
| 9 | Piutang Retur Supplier dicairkan tunai | Debit Kas/Bank / Kredit Piutang Retur Supplier |
| 11 | Kerugian Barang Rusak (Opsi C) — supplier nolak ganti | **Gak ada padanan AR yang sama persis** (padanan terdekat: baris "rusak" di AR Credit Note, tapi itu tetap ada kontra-revenue vs Piutang; di sini Utang Usaha gak kesentuh sama sekali) |

**Common Mistakes**
- Opsi A dan Opsi B (retur) dianggap bisa jalan bareng buat porsi qty yang sama — itu kompensasi ganda dari sisi supplier, harus pilih SALAH SATU per unit barang.
- Excess dari retur (Opsi A pada bill lunas) dianggap otomatis berarti barang harus diganti (Opsi B) — dua-duanya independen, pilihan resolusi bukan konsekuensi status bayar.
- Barang rusak yang gak dapat kompensasi sama sekali (supplier nolak ganti/kurangi utang) dicatat lewat jalur retur Opsi A — Utang Usaha gak boleh dikurangi kalau supplier gak beneran ngasih kompensasi apa pun, harus lewat Opsi C (write-off, gak nyentuh Utang Usaha).

## Uang Muka / DP ke Supplier

**Entitas & Jurnal**
- **ap_deposit** — uang muka/DP dibayar ke supplier sebelum bill ada (migration `0013_ap_deposits_schema.sql`). Mirror `ar_deposit` tapi arah kebalik: **asset** `Uang Muka Pembelian` (akun baru), bukan liability — supplier yang berutang balik ke kita, bukan sebaliknya. Jurnal: Debit Uang Muka Pembelian / Kredit Kas. 4 kejadian turunan, **partial-capable dari awal** (beda dari AR yang baru partial-capable belakangan lewat `0012`):
  - **ap_deposit_application** — DP diterapkan ke bill. Jurnal: Debit Utang Usaha / Kredit Uang Muka Pembelian.
  - **ap_deposit_refund** — DP dibalikin tunai (supplier yang mutusin, bukan kita — beda dari AR di mana KITA yang nentuin kebijakan ke customer). Jurnal: Debit Kas/Bank / Kredit Uang Muka Pembelian — gak ada dampak Laba Rugi.
  - **ap_deposit_forfeiture** — DP hangus (supplier gak mau balikin). Jurnal: Debit **Beban Kerugian Uang Muka** (akun baru, expense) / Kredit Uang Muka Pembelian — ada dampak Laba Rugi.
  - Guard terpusat `ap_deposit_remaining(deposit_id) = amount − SUM(applications) − SUM(refunds) − SUM(forfeitures)`, dipakai di ketiga tabel transaksional sekaligus — gak ada aturan "1 disposisi aktif", bisa campur kombinasi ketiganya.
  - **`ap_bill_remaining()` diperluas** — reducer ke-3 (`ap_deposit_applications`), mirror `ar_invoice_remaining()`. **`cancel_ap_bill` diperluas** — auto-unwind `ap_deposit_applications` aktif, mirror `cancel_ar_invoice`.

**Constraints**
- **No over-use `ap_deposits`**: `SUM(applications) + SUM(refunds) + SUM(forfeitures)` per `ap_deposits` ≤ `amount`, dijaga `ap_deposit_remaining()`.

**Skenario referensi**

| # | Kasus | Beda dari AR |
|---|---|---|
| 10 | DP dibayar lalu diterapkan ke bill | **Arah kebalik** — Debit Uang Muka Pembelian (asset) bukan liability |
| 11 | DP dibatalkan, direfund tunai | **Gak ada padanan AR** (AR gak punya refund sampai `0012`) — supplier yang mutusin refund, bukan kita |
| 12 | DP dibatalkan, hangus | Identik konsep, arah kebalik — Beban Kerugian Uang Muka (expense) bukan Pendapatan Lain-lain (revenue) |
| 13 | DP diselesaikan campuran (partial: applied+refund+forfeiture) | Identik — partial-capable dari awal di AP, baru partial-capable belakangan di AR (`0012`) |

**Common Mistakes**
- DP refund dicatat lewat forfeiture (atau sebaliknya) — beda dampak Laba Rugi, harus lewat tabel yang tepat.

## Glossary

- **Supplier**: master data pihak yang CV Barokah berutang (2 supplier bahan baku).
- **AP Bill**: utang timbul dari 1 kejadian ambil barang/jasa dengan termin dari supplier.
- **AP Payment**: 1 kejadian bayar nyata ke supplier, selalu nutup 1 bill spesifik, boleh cicil tapi gak boleh overpay (`bill_id` gak unique sejak `0011`).
- **AP Credit Note**: retur barang ke supplier — 2 jalur resolusi independen (Opsi A kurangi utang, Opsi B tukar barang), beda dari AR yang cuma 1 jalur (+ replacement sebagai tambahan, bukan alternatif).
- **Piutang Retur Supplier**: asset baru (`1350`), saldo yang supplier "berutang" ke kita dari retur pada bill yang udah lunas — partial-capable, dicairkan tunai.
- **Purchase Replacement**: tukar barang rusak dengan barang baik dari supplier, gak nyentuh Utang Usaha sama sekali — berdiri sendiri, gak butuh credit note.
- **Purchase Writeoff (Opsi C)**: barang rusak yang supplier tolak kompensasi sama sekali — Debit Beban Kerugian Barang Rusak / Kredit Persediaan Bahan Baku, Utang Usaha gak pernah kesentuh. Berbagi batas qty fisik yang sama dengan Opsi A/B lewat `purchase_returned_qty()`.
- **Beban Kerugian Barang Rusak**: akun expense baru, dipakai bareng sisi AR (baris "rusak" di AR Credit Note) dan AP (Opsi C write-off) — kerugian barang yang gak layak jual lagi dan gak dapat kompensasi penuh dari counterparty.
- **AP Deposit**: uang muka yang KITA bayar ke supplier sebelum bill ada — asset `Uang Muka Pembelian`, mirror `AR Deposit` arah kebalik. Diselesaikan lewat 3 jalur partial-capable: diterapkan ke bill, refund tunai, atau hangus.
- **Uang Muka Pembelian**: akun asset baru, DP yang kita bayar ke supplier — sengaja terpisah dari `Piutang Retur Supplier` (`1350`) walau sekilas mirip, beda asal jurnal (DP = bayar duluan sebelum barang datang; return credit = kelebihan setelah retur pada bill yang udah lunas).

Naratif lengkap + reasoning penuh: `docs/domain/accounts-payable.md`.
