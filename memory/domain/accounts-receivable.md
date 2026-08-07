# Accounts Receivable — AI Context

AR = lapisan tambahan di atas General Ledger buat nagih piutang termin: siapa berutang (customer), berapa/kapan jatuh tempo (invoice), udah dibayar berapa (payment). Tiap invoice/payment tetap wajib punya journal entry sendiri (Debit/Kredit sesuai kejadian) — AR gak bypass GL.

## Entitas

- **customer** — master data (bukan transaksional). Kolom kunci: `payment_term_days` (default termin, dipakai ngitung `due_date` invoice baru), `credit_limit` (nullable, batas nominal piutang open sebelum hold), `overdue_threshold_days` (nullable, toleransi hari telat sebelum hold — default di-prefill = `payment_term_days` pas customer dibuat, tapi kolom independen). Boleh di-`UPDATE` di tempat kalau termin/limit berubah — gak ngaruh ke invoice lama karena `due_date` udah di-snapshot.
- **ar_invoice** — piutang timbul. Jurnal: Debit Piutang Usaha, Kredit Pendapatan. `due_date = invoice_date + customer.payment_term_days`, dihitung & disimpan **sekali** pas insert (bukan generated column dinamis).
- **ar_payment** — piutang berkurang, kejadian bayar nyata (bukan jadwal terjadwal). Jurnal: Debit Kas/Bank, Kredit Piutang Usaha. `invoice_id` kolom langsung + `unique` (migration `0040`, bukan tabel jembatan lagi) — 1 payment wajib nutup **persis** 1 invoice, `record_ar_payment` `raise exception` kalau `amount` gak persis sama `ar_invoice_remaining(invoice_id)` (gak boleh kurang/cicilan, gak boleh lebih/overpay).
- **Status invoice** (lunas/sebagian/belum) — derived dari ada/gaknya baris `ar_payment` buat invoice itu (paling banyak 1) dibanding `invoice.amount`. Bukan kolom manual (pola sama kayak `archived_at`/"published" di modul lain).
- **ar_credit_note** — retur barang (bukan koreksi salah input). Beda `cancel_ar_invoice`: partial-capable, tetap bisa dibuat walau invoice udah ada alokasi payment, invoice asli gak diedit/dibatalkan. Dua jalur, auto-detect dari ada-gaknya baris `goods_issues.invoice_id`:
  - **Financial-only** (invoice gak lewat `create_goods_issue`): 1 jurnal, Debit `Retur & Potongan Penjualan` (akun kontra-revenue baru, `is_contra=true`) / Kredit Piutang Usaha.
  - **Full** (invoice lewat `create_goods_issue`): 2 jurnal — kontra-revenue di atas + Debit Persediaan Barang Jadi / Kredit HPP sejumlah cost proporsional dari `goods_issue_lines.total_cost` snapshot asli (bukan harga sekarang). Barang balik masuk nambah `inventory_balances` (Weighted Average) — sebelum migration `0038`, item FIFO malah masuk lot baru terpisah (`source_type = SALES_RETURN`), sekarang FIFO sudah dihapus total jadi semua item lewat jalur `inventory_balances` yang sama, gak ada lagi segregasi lot retur.
  - Independen dari status bayar invoice — kalau invoice udah lunas, retur bikin outstanding negatif (saldo kredit customer, penanganannya di luar scope, lihat "Belum termasuk").
- **warranty_replacement** — penukaran barang pasca-retur/garansi (jalur full), BUKAN gratis/cuma-cuma. Wajib referensi ke `ar_credit_note` yang punya `inventory_returns` (bukti barang emang balik). Jurnal cost: Debit HPP / Kredit Persediaan Barang Jadi. Qty ditukar (akumulasi) ≤ qty yang diretur di credit note itu (per item), pola no-over-return. Barang pengganti diambil dari stok fresh (`inventory_balances`, Weighted Average) — sebelum migration `0038` sengaja bukan dari lot `SALES_RETURN` (barang retur gak dipakai ganti lagi); sekarang tabel lot sudah gak ada, jadi segregasi itu juga sudah gak ada (lihat catatan di bawah soal `kerugian-barang-rusak.md`). **(fix `0037`)** Wajib juga membalikkan diskon retur yang udah diberikan `create_ar_credit_note` secara proporsional (Debit Piutang Usaha / Kredit Retur & Potongan Penjualan) — sebelumnya additive/kompensasi ganda, sekarang net-nya piutang kami ke customer gak berkurang gara-gara penukaran. **(0041)** Kalau credit note-nya juga punya `ar_return_credits` aktif, ikut nyettle saldo itu sejumlah persis porsi diskon yang dibalik — kolom `return_credit_settled_amount`/`return_credit_settlement_journal_entry_id` di tabel yang sama (pola persis `discount_reversed_amount`), jurnal ketiga Debit Saldo Kredit Retur Customer / Kredit Piutang Usaha — menetralkan sisi Piutang Usaha dari pembalikan diskon di atas, net efek ke Piutang Usaha invoice = 0. **Kalau porsi diskon dibalik > `ar_return_credit_remaining()`** (misal sebagian saldo udah direfund tunai duluan) — `raise exception` fail-fast, BUKAN di-`least()`-kan diam-diam (bug yang ketauan schema-reviewer: kalau dipotong diam-diam, sisa reversal yang gak ketampung jadi Piutang Usaha nambah tanpa invoice manapun yang nyerap).
- **ar_deposit** — uang muka/DP diterima sebelum invoice ada. **Bukan** `ar_payment` — jurnalnya Debit Kas / Kredit `Uang Muka Penjualan` (liability baru, akun `2300`), gak nyentuh Piutang Usaha sama sekali (piutangnya belum ada). 3 kejadian turunan, masing-masing tabel anak sendiri (immutable, status deposit derived dari situ, bukan kolom):
  - **ar_deposit_application** — DP diterapkan ke invoice yang udah diterbitkan penuh. Jurnal: Debit Uang Muka Penjualan / Kredit Piutang Usaha (reklasifikasi, ngurangin outstanding invoice).
  - **ar_deposit_forfei/ture** — DP hangus, order dibatalin SEBELUM invoice ada (kebijakan: DP gak direfund). Jurnal: Debit Uang Muka Penjualan / Kredit `Pendapatan Lain-lain` (akun `4300`, baru — BUKAN `Pendapatan Penjualan`, biar gak nyampur sama hasil jualan beneran).
  - 1 deposit cuma boleh punya **1 disposisi aktif** (diterapkan ATAU hangus, gak dua-duanya) — trigger jaga ini.
  - **`cancel_ar_invoice` diperluas**: kalau invoice yang dibatalin punya `ar_deposit_applications`, RPC ikut manggil `reverse_journal_entry` buat jurnal application-nya juga (bukan cuma jurnal invoice) — DP-nya otomatis balik status "belum dipakai". Ini beda dari guard "invoice udah ada payment" (yang cuma nolak keras) — dipilih auto-unwind karena nolak doang gak nyelesaiin apa-apa buat kasus DP (duitnya nyangkut gak jelas kalau cuma diblok).
- **ar_bad_debt_writeoff** — piutang yang benar-benar gak akan tertagih (customer menghilang/tutup usaha), dihapusbukukan. **Metode direct write-off** (bukan allowance/provisi — gak ada data historis buat estimasi kredibel, gak diakui fiskus buat badan usaha umum di Indonesia, gak konsisten sama pola RPC AR lain yang reaktif per-kejadian). Beda dari `cancel_ar_invoice`: Pendapatan asli **gak dibalik** (penjualannya valid), cuma Piutang Usaha yang dihapus lewat beban baru **di periode sekarang** (bukan periode penjualan lama, walau periode itu udah ditutup — `Piutang Usaha` akun permanen, gak ikut di-reset closing). Jurnal: Debit `Beban Piutang Tak Tertagih` (expense biasa, **bukan** kontra) / Kredit Piutang Usaha. Partial-capable, dibatasi sisa outstanding riil (bukan cuma `amount` mentah kayak credit note — write-off ikut ngitung SEMUA reducer lain: payment, retur, DP). Recovery (piutang yang di-write-off ternyata kebayar lagi) **di luar scope**.
- **ar_return_credit** — retur yang kejadian SETELAH invoice lunas bikin outstanding negatif (lihat "Retur Barang"). Excess-nya otomatis dicairkan jadi saldo resmi lewat `create_ar_credit_note` (deteksi otomatis, bukan RPC terpisah buat "bikin" saldonya), dicatat ke akun liability `Saldo Kredit Retur Customer`. Jurnal reklasifikasi: Debit Piutang Usaha / Kredit Saldo Kredit Retur Customer, sejumlah `excess = greatest(0, nominal_retur - greatest(0, sisa_outstanding_sebelum_retur_ini))`. **(0041)** Cuma 2 cara diselesaikan — refund tunai (`refund_ar_return_credit`, gak berubah) atau otomatis disettle sebagian/seluruhnya begitu `warranty_replacement` dibuat buat credit note yang sama (lihat entitas `warranty_replacement` di atas). Tabel `ar_return_credit_applications` ("dititip"/dipakai motong invoice lain) dan RPC `apply_ar_return_credit` **dicabut total** — `ar_return_credit_remaining(credit_id)` sekarang `amount - SUM(warranty_replacements.return_credit_settled_amount via credit_note_id) - SUM(refunds)`, bukan lagi ngurangin applications. `cancel_ar_invoice` gak lagi auto-unwind apa pun buat fitur ini (gak ada lagi application yang perlu di-unwind).
- **ar_invoice_remaining(invoice_id)** — fungsi SQL terpusat, satu-satunya sumber kebenaran buat "sisa outstanding riil 1 invoice" (amount dikurangi 4 reducer: payment, retur, DP application aktif, write-off aktif). Menggantikan pola lama di mana beberapa fungsi beda-beda ngitung ulang sendiri-sendiri (duplikasi yang udah kebukti berulang jadi sumber bug — reducer baru/dihapus gampang kelewat gak diikutin di salah satu tempat, lihat riwayat `0024`/`0027`/`0041`). Semua guard/RPC yang butuh tau "sisa piutang invoice ini" sekarang manggil fungsi ini, bukan hitung ulang. Reducer ke-5 (return credit application) **dihapus di `0041`** bareng drop `ar_return_credit_applications` — return credit sekarang gak pernah lagi ngurangin outstanding invoice LAIN.

## Constraints (wajib ditegakkan di implementasi)

- **Journal-backed**: tiap `ar_invoice`/`ar_payment` wajib punya `journal_entry_id` yang nunjuk entry balance beneran — dibuat via RPC atomik (pola sama kayak `create_journal_entry`), bukan insert AR + insert GL terpisah dari client.
- **Immutability**: invoice/payment gak bisa di-UPDATE/DELETE setelah dibuat (RLS default-deny + trigger jaring kedua, pola sama `journal_entries`/`journal_lines`). Koreksi = reversing entry, bukan edit.
- **Payment exact-match**: `record_ar_payment` `raise exception` kalau `p_amount != ar_invoice_remaining(p_invoice_id)` — gak boleh kurang (cicilan) atau lebih (overpay). `ar_payments.invoice_id` juga `unique` (hard guard tambahan di level kolom, bukan cuma dicek RPC).
- **`due_date` snapshot**: dihitung dari `payment_term_days` customer **pas invoice insert**, disimpan permanen. Perubahan `payment_term_days` customer setelahnya TIDAK boleh retroaktif ngubah `due_date` invoice lama.
- **Cancellation guard**: invoice cuma boleh dibatalkan (reversing entry via `cancel_ar_invoice`) kalau `ar_payments` buat invoice itu masih 0 baris. Begitu ada payment, pembatalan ditolak — piutang udah kesentuh transaksi lain, nasib pembayarannya jadi keputusan bisnis terpisah (belum di-scope).
- **Credit hold**: `create_ar_invoice` hard-reject kalau customer kelampaui `credit_limit` (total outstanding open) ATAU ada invoice open yang overdue lebih dari `overdue_threshold_days`-nya (OR, bukan AND). Status hold gak disimpan, derived tiap kali RPC dipanggil. NULL di salah satu kolom = batas itu gak berlaku buat customer itu. Cash sale ke customer on-hold gak lewat `ar_invoices` sama sekali (langsung jurnal Debit Kas/Kredit Pendapatan, di luar scope AR).
- **No over-return**: total `ar_credit_note` (akumulasi) per invoice gak boleh ngelebihin `ar_invoice.amount` (jalur financial-only) atau `qty_issued` baris `goods_issue_lines`-nya (jalur full).
- **Gak ada validasi batas waktu retur**: dicabut total lewat migration `0039` (`items.return_window_days`, `customers.return_window_days`, `ar_invoices.return_window_days` di-drop, cek di `inventory_return_lines_guard`/`create_ar_credit_note` dihapus) — retur diterima/ditolak murni keputusan manual di luar sistem.
- **Period-closing tetap berlaku**: retur ke periode tertutup ditolak otomatis lewat `journal_entries_block_retroactive_into_closed_period` (reuse, gak ada constraint baru).
- **Penukaran barang wajib nunjuk credit note jalur full**: `warranty_replacement.credit_note_id` harus punya baris `inventory_returns` yang match — kalau credit note-nya financial-only (gak ada retur fisik), RPC `raise exception`.
- **No over-replace**: `SUM(qty)` `warranty_replacement_lines` (akumulasi, per item, per credit note) ≤ `SUM(qty_returned)` `inventory_return_lines` item itu di credit note yang sama.
- **No over-reverse**: `SUM(discount_reversed_amount)` `warranty_replacements` (akumulasi per credit note) ≤ `ar_credit_notes.amount` credit note itu. Porsi reversal per pemanggilan dihitung dari rasio cost baris retur asli yang lagi diganti terhadap total cost retur di credit note itu, dikali `ar_credit_notes.amount`.
- **No over-writeoff**: `SUM(ar_bad_debt_writeoffs.amount)` per invoice ≤ `ar_invoice_remaining(invoice_id)` (fungsi terpusat, lihat di atas).
- **No over-use saldo kredit retur**: `SUM(warranty_replacements.return_credit_settled_amount via credit_note_id) + SUM(ar_return_credit_refunds.amount)` per `ar_return_credits` ≤ `ar_return_credits.amount`. Cuma 2 reducer ini (0041) — `ar_return_credit_applications` dicabut total, gak ada lagi jalur "dipakai motong invoice lain".
- **No over-settle return credit**: `SUM(return_credit_settled_amount)` `warranty_replacements` (akumulasi per credit note) ≤ `ar_return_credit_remaining()` credit note itu, pola sama no-over-reverse.
- **Semua guard reducer sekarang manggil `ar_invoice_remaining()`** — bukan ngitung ulang manual per fungsi. Nambah reducer baru ke depan cuma perlu ubah 1 fungsi ini, bukan nyisir semua guard satu-satu.

## Skenario referensi (detail angka: `docs/story/accounts-receivable.md`)

| # | Kasus | Pola |
|---|---|---|
| 1 | Lunas tepat waktu | 1 payment → 1 invoice, persis penuh |
| 2 | Telat bayar (aging) | Query read-side: `due_date < now()` dan belum lunas — gak butuh kolom/job baru |
| 3 | Invoice dibatalkan (belum ada payment) | Reversing entry via `cancel_ar_invoice`, invoice asli tetap ada di histori |
| 4 | Credit hold | `create_ar_invoice` ditolak: outstanding > `credit_limit` ATAU overdue terlama > `overdue_threshold_days` |
| 5 | Retur, financial-only | 1 jurnal kontra-revenue, outstanding turun |
| 6 | Retur, full (via goods_issue), udah lunas | 2 jurnal (kontra-revenue + reversal HPP), stok balik, outstanding jadi negatif |
| 7 | DP diterima lalu diterapkan penuh ke invoice | 3 jurnal terpisah (terima DP, terbitkan invoice, terapkan DP) |
| 8 | DP hangus (order dibatalin sebelum invoice ada) | 1 jurnal, Uang Muka Penjualan → Pendapatan Lain-lain, gak pernah ada invoice |
| 9 | Invoice dengan DP-application dibatalkan | `cancel_ar_invoice` reverse jurnal invoice + jurnal application, DP balik "belum dipakai" |
| 10 | Penukaran barang pasca-retur/garansi | 2 jurnal (HPP/Persediaan Barang Jadi + pembalikan diskon proporsional ke Piutang Usaha), referensi credit note jalur full, gak nyentuh Pendapatan |
| 11 | Payment ditolak — nominal gak persis sisa outstanding | `record_ar_payment` `raise exception`, baik kurang (cicil) maupun lebih (overpay) |
| 12 | Piutang tak tertagih (write-off) | 1 jurnal, Debit Beban Piutang Tak Tertagih / Kredit Piutang Usaha, Pendapatan asli gak dibalik |
| 13 | Saldo kredit dari retur, direfund tunai | Retur setelah lunas bikin outstanding negatif, excess-nya otomatis jurnal Debit Piutang Usaha / Kredit Saldo Kredit Retur Customer, lalu Debit Saldo Kredit Retur Customer / Kredit Kas |
| 14 | Saldo kredit dari retur, diselesaikan via barang | `create_warranty_replacement` buat credit note yang punya `ar_return_credits` aktif — jurnal ketiga Debit Saldo Kredit Retur Customer / Kredit Piutang Usaha sejumlah porsi diskon dibalik, `raise exception` kalau itu ngelebihin sisa saldo |

## Common mistakes to guard against

- `due_date` dihitung ulang tiap baca dari `payment_term_days` customer saat ini (bukan snapshot) — invoice lama ikut geser kalau termin berubah.
- Status lunas/belum sebagai kolom manual yang di-`UPDATE` tiap payment — resiko gak sinkron. Harus derived query.
- Terima payment dengan nominal kurang (partial) atau lebih (overpay) dari sisa outstanding invoice — kebijakan sekarang wajib persis, `record_ar_payment` harus `raise exception`.
- Insert AR tanpa lewat RPC yang juga bikin journal entry — AR dan GL jadi dua sumber angka gak sinkron.
- Batalin invoice yang udah ada payment tanpa guard — GL balance tapi duit customer yang udah masuk jadi nyantol gak jelas.
- Cek credit hold cuma di UI (skippable) — harus hard-reject di RPC.
- Simpen status "on hold" sebagai kolom manual — harus derived tiap invoice baru dicek.
- DP diterima langsung dicatat ngurangin Piutang Usaha atau jadi Pendapatan — piutangnya belum ada, barang/jasanya belum diserahkan. Harus lewat `Uang Muka Penjualan` (liability) dulu.
- DP hangus dicatat ke `Pendapatan Penjualan` — harus ke `Pendapatan Lain-lain`, biar gak nyampur sama pendapatan jualan beneran.
- `cancel_ar_invoice` cuma reverse jurnal invoice-nya doang tanpa ikut reverse jurnal `ar_deposit_applications` — Piutang Usaha customer itu nyasar jadi minus, DP-nya nyangkut gak jelas status.
- Penukaran barang lewat `create_goods_issue` biasa — bikin piutang/pendapatan palsu.
- Penukaran barang tanpa referensi ke credit note — kehilangan audit trail.
- Barang pengganti diambil dari lot `SALES_RETURN` — harusnya stok fresh.
- Write-off lewat `cancel_ar_invoice` — membalikkan Pendapatan yang valid, harusnya RPC terpisah yang cuma ngurangin Piutang Usaha.
- Write-off gak ngitung reducer lain (payment/retur/DP) — bisa "menghapus" uang yang udah lunas/diretur duluan.
- Allowance/provisi method buat UMKM tanpa data historis — estimasi jadi tebakan, gak diakui fiskus buat badan usaha umum.
- Excess dari retur negatif dicatat ke akun overpayment (`Saldo Kredit Customer`) — harus akun terpisah, beda asal jurnal.
- Excess dari retur dihitung dari seluruh nominal retur, bukan cuma bagian yang ngelebihin sisa outstanding — dobel hitung.
- Nambah reducer baru ke `ar_invoices` tanpa nge-extend `ar_invoice_remaining()` (dan lewat situ otomatis semua guard yang manggilnya) — kelas bug yang udah kejadian berulang sebelum fungsi ini disentralisasi.
- Drop tabel yang jadi sumber reducer di `ar_invoice_remaining()`/fungsi `*_remaining()` lain tanpa ikut nge-update fungsi itu — persis kelas bug yang kejadian pas nulis `0041` (drop `ar_return_credit_applications` sempat lupa dibarengi update `ar_invoice_remaining`, yang bakal bikin HAMPIR SEMUA RPC AR gagal karena manggil fungsi itu). Selalu grep dulu tabel yang mau di-drop, pastiin semua fungsi yang nyebut itu ikut direvisi di migration yang sama.
- `warranty_replacement` nge-`least()`-in settlement ke `ar_return_credit_remaining()` diam-diam pas porsi diskon yang dibalik lebih besar dari sisa saldo, tapi reversal journal-nya sendiri tetap jalan penuh gak ke-cap — selisihnya jadi Piutang Usaha nambah tanpa invoice manapun yang nyerap. Harus `raise exception` fail-fast SEBELUM bikin jurnal apa pun kalau reversal amount > sisa saldo, bukan dipotong diam-diam di sisi settlement doang (bug nyata yang ketauan schema-reviewer di `0041`, lihat riwayat migration itu).

## Belum termasuk (di luar scope fase ini)

- **Recovery piutang yang udah di-write-off** — direct write-off gak punya akun cadangan penyangga, belum didesain.
- **Barang rusak yang di-retur masuk lagi sebagai stok bernilai** — `warranty_replacement` (dan retur full pada umumnya) masukin barang balik ke `inventory_balances` seolah layak jual, padahal kalau alasannya rusak harusnya diakui Beban Kerugian Barang Rusak (write-off). Sejak migration `0038` (FIFO dihapus, `inventory_lots` juga ikut hilang), isu ini berlaku ke **semua item** — sebelumnya cuma item Weighted Average yang campur pool kayak gini, item FIFO masih tersegregasi lewat lot `SALES_RETURN`. Ref `memory/scope-debt/kerugian-barang-rusak.md`.

## Glossary

- **Customer**: master data pihak yang berutang ke perusahaan.
- **AR Invoice**: piutang timbul dari 1 kejadian kirim barang/jasa dengan termin.
- **AR Payment**: 1 kejadian bayar nyata dari customer, wajib persis nutup 1 invoice penuh (`invoice_id` unique di `ar_payments`).
- **Credit Hold**: kondisi derived, customer ditolak bikin invoice baru karena outstanding/keterlambatan kelampaui batasnya.
- **Aging**: invoice yang `due_date`-nya udah lewat dan belum lunas.
- **AR Credit Note**: retur barang yang udah diinvoice — ngurangin outstanding invoice tanpa ubah `amount` asli, beda dari `cancel_ar_invoice`.
- **AR Deposit**: uang muka diterima sebelum invoice ada, dicatat ke liability `Uang Muka Penjualan` — beda dari `AR Payment` yang selalu terhadap invoice existing.
- **Warranty Replacement**: penukaran barang pasca-retur/garansi (BUKAN gratis) — keluar stok+HPP tanpa invoice baru, wajib membalikkan diskon retur proporsional (piutang gak berkurang gara-gara penukaran), wajib referensi credit note jalur full.
- **AR Bad Debt Write-off**: piutang yang beneran gak akan tertagih, dihapusbukukan lewat beban baru (direct write-off, bukan allowance) — Pendapatan asli gak dibalik, beda dari `cancel_ar_invoice`.
- **AR Return Credit**: excess dari retur setelah invoice lunas, dicairkan otomatis jadi saldo resmi (liability `Saldo Kredit Retur Customer`) — beda akun karena beda asal jurnal (retur, bukan kelebihan kas). Cuma bisa diselesaikan refund tunai atau otomatis via `warranty_replacement`, gak bisa dititip ke invoice lain.
- **`ar_invoice_remaining()`**: fungsi terpusat, satu-satunya sumber kebenaran buat sisa outstanding riil 1 invoice — dipanggil semua guard/RPC AR yang butuh tau itu.

Naratif lengkap + reasoning penuh: `docs/domain/accounts-receivable.md`.
