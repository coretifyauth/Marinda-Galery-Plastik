# Accounts Receivable — AI Context

AR = lapisan tambahan di atas General Ledger buat nagih piutang termin: siapa berutang (customer), berapa/kapan jatuh tempo (invoice), udah dibayar berapa (payment). Tiap invoice/payment tetap wajib punya journal entry sendiri (Debit/Kredit sesuai kejadian) — AR gak bypass GL.

Naratif lengkap + reasoning penuh: `docs/domain/accounts-receivable.md`. Struktur module → submodule di file ini SAMA urutannya dengan padanan naratif itu dan dengan `memory/architecture/data/ar-schema.md` (lihat `AGENTS.md` > "Format Baku: Struktur Module → Submodule").

## Konsep Inti

**Entitas & Jurnal**
- **customer** — master data (bukan transaksional). Kolom kunci: `payment_term_days` (default termin, dipakai ngitung `due_date` invoice baru). Boleh di-`UPDATE` di tempat kalau termin berubah — gak ngaruh ke invoice lama karena `due_date` udah di-snapshot. (Kolom `credit_limit`/`overdue_threshold_days` — lihat submodule "Credit Hold".)
- **ar_invoice** — piutang timbul. Jurnal: Debit Piutang Usaha, Kredit Pendapatan (1 atau lebih kategori — lihat submodule "Kategori Campur & PPN"). `due_date = invoice_date + customer.payment_term_days`, dihitung & disimpan **sekali** pas insert (bukan generated column dinamis).
- **ar_payment** — piutang berkurang, kejadian bayar nyata (bukan jadwal terjadwal). Jurnal: Debit Kas/Bank, Kredit Piutang Usaha. `invoice_id` kolom langsung (migration `0040`, bukan tabel jembatan lagi) — 1 payment wajib nutup 1 invoice spesifik (gak ada gabung invoice), tapi sejak `0010` **gak lagi unique** — boleh cicil (kurang dari sisa), `record_ar_payment` `raise exception` cuma kalau `amount > ar_invoice_remaining(invoice_id)` (overpay). **Koreksi bisnis `0010`** (2026-08-08): larangan aslinya cuma soal overpay yang jadi saldo ngambang (lihat "AR Customer Credit — dicabut" di bawah), bukan cicilan — desain sebelum `0010` sempat mewajibkan exact-match (gak boleh kurang ATAUpun lebih), dilonggarkan lagi khusus buat sisi cicil.
- **Status invoice** (lunas/sebagian/belum) — derived dari `SUM(ar_payment.amount)` buat invoice itu (bisa banyak baris sejak `0010`) dibanding `invoice.amount`. Bukan kolom manual (pola sama kayak `archived_at`/"published" di modul lain).
- **ar_invoice_remaining(invoice_id)** — fungsi SQL terpusat, satu-satunya sumber kebenaran buat "sisa outstanding riil 1 invoice" (amount dikurangi 4 reducer: payment, retur, DP application aktif, write-off aktif). Menggantikan pola lama di mana beberapa fungsi beda-beda ngitung ulang sendiri-sendiri (duplikasi yang udah kebukti berulang jadi sumber bug — reducer baru/dihapus gampang kelewat gak diikutin di salah satu tempat, lihat riwayat `0024`/`0027`/`0041`). Semua guard/RPC yang butuh tau "sisa piutang invoice ini" sekarang manggil fungsi ini, bukan hitung ulang. Reducer ke-5 (return credit application) **dihapus di `0041`** bareng drop `ar_return_credit_applications` — return credit sekarang gak pernah lagi ngurangin outstanding invoice LAIN (lihat submodule "Retur Barang").
- **AR Customer Credit (Kelebihan Bayar) — dicabut total (migration `0040`).** Sempat ada mekanisme "customer transfer lebih dari total invoice, excess-nya jadi saldo kredit" (`ar_customer_credits`/`ar_customer_credit_applications`/`ar_customer_credit_refunds`, RPC `apply_ar_customer_credit`/`refund_ar_customer_credit`, akun `Saldo Kredit Customer`). Dicabut total begitu keputusan bisnis "payment gak boleh overpay" jalan. **Tetap dicabut permanen** setelah `0010` — cicil dibalikin, overpay-jadi-saldo-ngambang TIDAK dibalikin.

**Constraints**
- **Journal-backed**: tiap `ar_invoice`/`ar_payment` wajib punya `journal_entry_id` yang nunjuk entry balance beneran — dibuat via RPC atomik (pola sama kayak `create_journal_entry`), bukan insert AR + insert GL terpisah dari client.
- **Immutability**: invoice/payment gak bisa di-UPDATE/DELETE setelah dibuat (RLS default-deny + trigger jaring kedua, pola sama `journal_entries`/`journal_lines`). Koreksi = reversing entry, bukan edit.
- **Payment no-overpay (boleh cicil, `0010`)**: `record_ar_payment` `raise exception` kalau `p_amount > ar_invoice_remaining(p_invoice_id)` — kurang (cicilan) boleh, lebih (overpay) tetap ditolak. `ar_payments.invoice_id` gak lagi `unique` — 1 invoice boleh punya banyak baris payment.
- **`due_date` snapshot**: dihitung dari `payment_term_days` customer **pas invoice insert**, disimpan permanen. Perubahan `payment_term_days` customer setelahnya TIDAK boleh retroaktif ngubah `due_date` invoice lama.
- **Cancellation guard**: invoice cuma boleh dibatalkan (reversing entry via `cancel_ar_invoice`) kalau `ar_payments` buat invoice itu masih 0 baris. Begitu ada payment, pembatalan ditolak — piutang udah kesentuh transaksi lain, nasib pembayarannya jadi keputusan bisnis terpisah (belum di-scope).
- **Semua guard reducer manggil `ar_invoice_remaining()`** — bukan ngitung ulang manual per fungsi. Nambah reducer baru ke depan cuma perlu ubah 1 fungsi ini, bukan nyisir semua guard satu-satu.

**Skenario referensi**

| # | Kasus | Pola |
|---|---|---|
| 1 | Lunas tepat waktu | 1 payment → 1 invoice, penuh sekaligus |
| 2 | Telat bayar (aging) | Query read-side: `due_date < now()` dan belum lunas — gak butuh kolom/job baru |
| 3 | Invoice dibatalkan (belum ada payment) | Reversing entry via `cancel_ar_invoice`, invoice asli tetap ada di histori |
| 11 | Cicil (`0010`) | 2+ payment ke invoice yang sama, masing-masing < sisa outstanding, status "sebagian" sampai baris terakhir |
| 12 | Payment ditolak — overpay | `record_ar_payment` `raise exception` kalau `amount > ar_invoice_remaining` |

**Common Mistakes**
- `due_date` dihitung ulang tiap baca dari `payment_term_days` customer saat ini (bukan snapshot) — invoice lama ikut geser kalau termin berubah.
- Status lunas/belum sebagai kolom manual yang di-`UPDATE` tiap payment — resiko gak sinkron. Harus derived query.
- Terima payment dengan nominal lebih (overpay) dari sisa outstanding invoice — `record_ar_payment` harus `raise exception`. Kurang (cicil) boleh, itu bukan mistake sejak `0010`.
- Insert AR tanpa lewat RPC yang juga bikin journal entry — AR dan GL jadi dua sumber angka gak sinkron.
- Batalin invoice yang udah ada payment tanpa guard — GL balance tapi duit customer yang udah masuk jadi nyantol gak jelas.
- Nambah reducer baru ke `ar_invoices` tanpa nge-extend `ar_invoice_remaining()` (dan lewat situ otomatis semua guard yang manggilnya) — kelas bug yang udah kejadian berulang sebelum fungsi ini disentralisasi.
- Drop tabel yang jadi sumber reducer di `ar_invoice_remaining()`/fungsi `*_remaining()` lain tanpa ikut nge-update fungsi itu — persis kelas bug yang kejadian pas nulis `0041` (drop `ar_return_credit_applications` sempat lupa dibarengi update `ar_invoice_remaining`, yang bakal bikin HAMPIR SEMUA RPC AR gagal karena manggil fungsi itu). Selalu grep dulu tabel yang mau di-drop, pastiin semua fungsi yang nyebut itu ikut direvisi di migration yang sama.

## Credit Hold

**Entitas & Jurnal**
- Gak ada tabel baru. `customer.credit_limit` (nullable, batas nominal piutang open sebelum hold) dan `customer.overdue_threshold_days` (nullable, toleransi hari telat sebelum hold — default di-prefill = `payment_term_days` pas customer dibuat, tapi kolom independen) ditambah `0020_ar_credit_hold.sql`.

**Constraints**
- `create_ar_invoice` hard-reject kalau customer kelampaui `credit_limit` (total outstanding open, prospektif — termasuk invoice baru yang mau dibuat) ATAU ada invoice open yang overdue lebih dari `overdue_threshold_days`-nya (OR, bukan AND). Status hold gak disimpan, derived tiap kali RPC dipanggil. NULL di salah satu kolom = batas itu gak berlaku buat customer itu. Cash sale ke customer on-hold gak lewat `ar_invoices` sama sekali (langsung jurnal Debit Kas/Kredit Pendapatan, di luar scope AR).

**Skenario referensi**

| # | Kasus | Pola |
|---|---|---|
| 4 | Credit hold | `create_ar_invoice` ditolak: outstanding > `credit_limit` ATAU overdue terlama > `overdue_threshold_days` |

**Common Mistakes**
- Cek credit hold cuma di UI (skippable) — harus hard-reject di RPC.
- Simpen status "on hold" sebagai kolom manual — harus derived tiap invoice baru dicek.

## Retur Barang (Credit Note)

**Entitas & Jurnal**
- **ar_credit_note** — retur barang (bukan koreksi salah input). Beda `cancel_ar_invoice`: partial-capable, tetap bisa dibuat walau invoice udah ada alokasi payment, invoice asli gak diedit/dibatalkan. Dua jalur, auto-detect dari ada-gaknya baris `goods_issues.invoice_id`:
  - **Financial-only** (invoice gak lewat `create_goods_issue`): 1 jurnal, Debit `Retur & Potongan Penjualan` (akun kontra-revenue baru, `is_contra=true`) / Kredit Piutang Usaha.
  - **Full** (invoice lewat `create_goods_issue`): 2 jurnal — kontra-revenue di atas + Debit Persediaan Barang Jadi / Kredit HPP sejumlah cost proporsional dari `goods_issue_lines.total_cost` snapshot asli (bukan harga sekarang). Barang balik masuk nambah `inventory_balances` (Weighted Average) — sebelum migration `0038`, item FIFO malah masuk lot baru terpisah (`source_type = SALES_RETURN`), sekarang FIFO sudah dihapus total jadi semua item lewat jalur `inventory_balances` yang sama, gak ada lagi segregasi lot retur.
  - **Klasifikasi kondisi per baris `p_lines`** — tiap baris `{item_id, qty_returned, condition}`, `condition` = `'RESALABLE'` (default) atau `'DAMAGED'`. `RESALABLE` → jurnal di atas apa adanya (restock ke `inventory_balances`). `DAMAGED` → **TIDAK** update `inventory_balances`, cost baris itu direklasifikasi ke `Beban Kerugian Barang Rusak` (akun expense baru) bukan `Persediaan Barang Jadi`:
    ```
    Baris DAMAGED:   Debit Beban Kerugian Barang Rusak / Kredit HPP
    Baris RESALABLE: Debit Persediaan Barang Jadi / Kredit HPP  (existing)
    ```
    Kontra-revenue (Debit Retur & Potongan Penjualan / Kredit Piutang Usaha) gak kepengaruh `condition` — jalan sama buat semua baris. `inventory_return_lines` tetap diisi buat SEMUA baris (audit trail + basis `warranty_replacement`) terlepas direstock atau ditulis-jadi-beban — cuma `inventory_balances` yang beda perlakuan. Menutup catatan terbuka lama — sebelumnya SEMUA baris retur otomatis direstock seolah layak jual, gak peduli kondisi fisiknya.
  - Independen dari status bayar invoice — kalau invoice udah lunas, retur bikin outstanding negatif → lihat **ar_return_credit** di bawah.
- **ar_return_credit** — retur yang kejadian SETELAH invoice lunas bikin outstanding negatif. Excess-nya otomatis dicairkan jadi saldo resmi lewat `create_ar_credit_note` (deteksi otomatis, bukan RPC terpisah buat "bikin" saldonya), dicatat ke akun liability `Saldo Kredit Retur Customer`. Jurnal reklasifikasi: Debit Piutang Usaha / Kredit Saldo Kredit Retur Customer, sejumlah `excess = greatest(0, nominal_retur - greatest(0, sisa_outstanding_sebelum_retur_ini))`. **(0041)** Cuma 2 cara diselesaikan — refund tunai (`refund_ar_return_credit`, gak berubah) atau (HISTORIS doang, lihat catatan `0057` di submodule "Penukaran Barang Pasca-Retur") otomatis disettle sebagian/seluruhnya begitu `warranty_replacement` dibuat buat credit note yang sama. Tabel `ar_return_credit_applications` ("dititip"/dipakai motong invoice lain) dan RPC `apply_ar_return_credit` **dicabut total** — `ar_return_credit_remaining(credit_id)` sekarang `amount - SUM(warranty_replacements.return_credit_settled_amount via credit_note_id) - SUM(refunds)`, bukan lagi ngurangin applications. `cancel_ar_invoice` gak lagi auto-unwind apa pun buat fitur ini. **Sejak `0057`**: refund tunai adalah SATU-SATUNYA cara aktif nyelesaiin saldo kredit retur ke depan (persis pola `ap_return_credits`) — jalur settlement via barang gak akan pernah ke-trigger lagi buat saldo BARU, karena `create_warranty_replacement` gak pernah menyentuh `ar_credit_notes`/`ar_return_credits` sama sekali lagi.

**Constraints**
- **No over-return**: total `ar_credit_note` (akumulasi) per invoice gak boleh ngelebihin `ar_invoice.amount` (jalur financial-only) atau `qty_issued` baris `goods_issue_lines`-nya (jalur full).
- **Gak ada validasi batas waktu retur**: dicabut total lewat migration `0039` (`items.return_window_days`, `customers.return_window_days`, `ar_invoices.return_window_days` di-drop, cek di `inventory_return_lines_guard`/`create_ar_credit_note` dihapus) — retur diterima/ditolak murni keputusan manual di luar sistem.
- **Period-closing tetap berlaku**: retur ke periode tertutup ditolak otomatis lewat `journal_entries_block_retroactive_into_closed_period` (reuse, gak ada constraint baru).
- **No over-use saldo kredit retur**: `SUM(warranty_replacements.return_credit_settled_amount via credit_note_id) + SUM(ar_return_credit_refunds.amount)` per `ar_return_credits` ≤ `ar_return_credits.amount`. Cuma 2 reducer ini (`0041`) — `ar_return_credit_applications` dicabut total, gak ada lagi jalur "dipakai motong invoice lain".
- **Belum ada cap gabungan lintas invoice/waktu** buat total saldo kredit retur 1 customer — per invoice udah ada batas alami (`ar_credit_notes_no_over_return` caps retur ≤ `amount` invoice), tapi belum ada cap akumulasi lintas invoice. Gak dirancang sekarang, belum ada bukti kebutuhan di cerita.

**Skenario referensi**

| # | Kasus | Pola |
|---|---|---|
| 5 | Retur, financial-only | 1 jurnal kontra-revenue, outstanding turun |
| 6 | Retur, full (via goods_issue), udah lunas | 2 jurnal (kontra-revenue + reversal HPP), stok balik, outstanding jadi negatif |
| 14 | Saldo kredit dari retur, direfund tunai | Retur setelah lunas bikin outstanding negatif, excess-nya otomatis jurnal Debit Piutang Usaha / Kredit Saldo Kredit Retur Customer, lalu Debit Saldo Kredit Retur Customer / Kredit Kas |
| 15 | Saldo kredit dari retur, diselesaikan via barang (HISTORIS — sejak `0057` gak bisa kejadian lagi buat saldo baru) | `create_warranty_replacement` buat credit note yang punya `ar_return_credits` aktif — jurnal ketiga Debit Saldo Kredit Retur Customer / Kredit Piutang Usaha sejumlah porsi diskon dibalik, `raise exception` kalau itu ngelebihin sisa saldo |

**Common Mistakes**
- Excess dari retur negatif dicatat ke akun overpayment (`Saldo Kredit Customer`) — harus akun terpisah, beda asal jurnal.
- Excess dari retur dihitung dari seluruh nominal retur, bukan cuma bagian yang ngelebihin sisa outstanding — dobel hitung.
- Baris `DAMAGED` ikut update `inventory_balances` (restock) — harus SKIP update stok, cost-nya masuk `Beban Kerugian Barang Rusak` bukan `Persediaan Barang Jadi`. Kontra-revenue-nya (piutang berkurang) tetap jalan normal terlepas `condition`.

## Penukaran Barang Pasca-Retur (Garansi)

**Restrukturisasi `0057` (2026-09-03, keputusan owner)**: dulu warranty replacement WAJIB nunjuk `credit_note` yang udah lebih dulu mencatat retur+diskon, lalu MEMBALIKKAN diskon itu proporsional biar gak dobel kompensasi ("izinkan lalu koreksi"). Sekarang **independen dari credit note sama sekali** — mirror `purchase_replacement` (AP), yang dari awal independen nunjuk bill langsung. Mutual exclusivity sekarang dicegah dari akarnya: 1 qty fisik yang terjual cuma boleh diklaim SATU jalur (retur-kredit ATAU ganti-barang), dijaga fungsi gabungan `sales_returned_qty()` yang dicek DUA ARAH (baik pas mau retur-kredit maupun pas mau ganti-barang) — bukan lagi "izinkan dua-duanya lalu balikin jurnal koreksi".

**Entitas & Jurnal**
- **warranty_replacement** — penukaran barang pasca-retur/garansi, BUKAN gratis/cuma-cuma. Nunjuk `invoice_id` langsung (butuh `goods_issue` — invoice financial-only gak punya barang fisik buat diganti). **Cuma 1 jurnal**: Debit HPP / Kredit Persediaan Barang Jadi — **gak nyentuh Piutang Usaha sama sekali** (beda dari versi lama yang wajib bikin jurnal reversal diskon kedua). Qty ditukar (akumulasi per item per invoice) ≤ `qty_issued` dikurangi total yang udah diklaim lintas SEMUA jalur (`sales_returned_qty`), bukan lagi ≤ qty yang diretur di 1 credit note tertentu. Barang pengganti tetap diambil dari stok fresh (`inventory_balances`, Weighted Average) — baris retur `DAMAGED` (submodule "Retur Barang") gak pernah masuk pool ini, jadi gak ada risiko barang cacat ikut kepakai jadi pengganti.
- **Kolom historis** (`credit_note_id`, `discount_reversed_amount`, `discount_reversal_journal_entry_id`, `return_credit_settled_amount`, `return_credit_settlement_journal_entry_id`) TETAP ada di tabel buat baris LAMA (sebelum `0057`) — RPC baru gak pernah ngisi, gak ada backfill mundur, kebijakan baru cuma berlaku transaksi baru.

**Constraints**
- **Mutual exclusivity 2 arah, via `sales_returned_qty(invoice_id, item_id)`** — fungsi tunggal yang menjumlah qty yang udah diklaim lintas retur-kredit (`inventory_return_lines`) DAN ganti-barang (`warranty_replacement_lines`) buat 1 item di 1 invoice. Dicek di KEDUA trigger: `inventory_return_lines_guard` (mau retur-kredit) dan `warranty_replacement_lines_no_over_replace` (mau ganti-barang) — keduanya baca fungsi yang sama, jadi urutan mana pun duluan (retur dulu baru ganti-barang, atau sebaliknya) tetap konsisten dicegah. Ini beda penting dari versi lama yang cuma ngecek 1 arah (ganti-barang doang) lalu "mengoreksi" lewat reversal — sekarang beneran dicegah dari 2 arah sebelum kejadian.
- **Invoice wajib punya `goods_issue`**: financial-only invoice gak bisa jadi dasar ganti barang (gak ada barang fisik yang terjual).

**Skenario referensi**

| # | Kasus | Pola |
|---|---|---|
| 10 | Penukaran barang pasca-retur/garansi | 1 jurnal (HPP/Persediaan Barang Jadi), qty dibatasi `sales_returned_qty()` gabungan, gak nyentuh Piutang Usaha/Pendapatan sama sekali |

**Common Mistakes**
- Penukaran barang lewat `create_goods_issue` biasa — bikin piutang/pendapatan palsu.
- Nganggep proteksi anti-klaim-dobel cukup dicek di 1 arah doang (misal cuma pas ganti-barang) — retur-kredit yang kejadian BELAKANGAN buat qty yang sama tetap harus dicegah juga, makanya `sales_returned_qty()` dicek di kedua trigger, bukan cuma 1 (bug nyata yang ketauan schema-reviewer pas migration `0057` direview — draft pertama cuma update 1 arah).
- Barang pengganti diambil dari lot `SALES_RETURN` — harusnya stok fresh (relevan sebelum migration `0038`, sekarang gak ada lot sama sekali).

## Uang Muka / DP (Deposit)

**Entitas & Jurnal**
- **ar_deposit** — uang muka/DP diterima sebelum invoice ada. **Bukan** `ar_payment` — jurnalnya Debit Kas / Kredit `Uang Muka Penjualan` (liability, akun `2300`), gak nyentuh Piutang Usaha sama sekali (piutangnya belum ada). 4 kejadian turunan (`ar_deposit_refunds` ditambah `0012`), masing-masing tabel anak sendiri (immutable, status deposit derived dari situ, bukan kolom):
  - **ar_deposit_application** — DP diterapkan ke invoice yang udah diterbitkan. Jurnal: Debit Uang Muka Penjualan / Kredit Piutang Usaha (reklasifikasi, ngurangin outstanding invoice).
  - **ar_deposit_forfeiture** — DP hangus, order dibatalin SEBELUM invoice ada (kebijakan default: DP gak direfund). Jurnal: Debit Uang Muka Penjualan / Kredit `Pendapatan Lain-lain` (akun `4300`, BUKAN `Pendapatan Penjualan`, biar gak nyampur sama hasil jualan beneran).
  - **ar_deposit_refund** *(baru, `0012_ar_deposit_refund_and_partial.sql`)* — DP dibalikin tunai (kasus khusus, kita yang putusin refund). Jurnal: Debit Uang Muka Penjualan / Kredit Kas/Bank — **gak ada dampak Laba Rugi**, murni reklasifikasi aset↔liability, beda dari forfeiture yang jadi Pendapatan Lain-lain.
  - **Partial-capable sejak `0012`** — sebelumnya "1 deposit cuma boleh 1 disposisi aktif" (diterapkan ATAU hangus, all-or-nothing, `forfeit_ar_deposit` gak nerima parameter nominal). Sekarang ketiganya (`applications`/`refunds`/`forfeitures`) bisa dicampur bertahap dalam nominal berapa pun, dijaga fungsi terpusat `ar_deposit_remaining(deposit_id) = amount − SUM(applications) − SUM(refunds) − SUM(forfeitures)` (mirror pola `ar_invoice_remaining()`).
  - **`cancel_ar_invoice` diperluas**: kalau invoice yang dibatalin punya `ar_deposit_applications`, RPC ikut manggil `reverse_journal_entry` buat jurnal application-nya juga (bukan cuma jurnal invoice) — DP-nya otomatis balik ke `ar_deposit_remaining()`-nya. Ini beda dari guard "invoice udah ada payment" (yang cuma nolak keras) — dipilih auto-unwind karena nolak doang gak nyelesaiin apa-apa buat kasus DP (duitnya nyangkut gak jelas kalau cuma diblok).

**Constraints**
- Semua 3 jalur (`applications`/`refunds`/`forfeitures`) dijaga fungsi terpusat `ar_deposit_remaining()` — total gak boleh ngelebihin `amount` DP awal, partial-capable dari awal.
- Outstanding buat credit hold ikut ngurangin `ar_deposit_applications` aktif (lihat submodule "Credit Hold").

**Skenario referensi**

| # | Kasus | Pola |
|---|---|---|
| 7 | DP diterima lalu diterapkan penuh ke invoice | 3 jurnal terpisah (terima DP, terbitkan invoice, terapkan DP) |
| 8 | DP hangus (order dibatalin sebelum invoice ada) | 1 jurnal, Uang Muka Penjualan → Pendapatan Lain-lain, gak pernah ada invoice |
| 9 | Invoice dengan DP-application dibatalkan | `cancel_ar_invoice` reverse jurnal invoice + jurnal application, DP balik "belum dipakai" |

**Common Mistakes**
- DP diterima langsung dicatat ngurangin Piutang Usaha atau jadi Pendapatan — piutangnya belum ada, barang/jasanya belum diserahkan. Harus lewat `Uang Muka Penjualan` (liability) dulu.
- DP hangus dicatat ke `Pendapatan Penjualan` — harus ke `Pendapatan Lain-lain`, biar gak nyampur sama pendapatan jualan beneran.
- DP refund dicatat lewat jalur `ar_deposit_forfeitures` (atau ke akun pendapatan mana pun) — refund itu murni uang balik ke customer, **gak ada dampak Laba Rugi**, harus lewat `ar_deposit_refunds` (Debit Uang Muka Penjualan / Kredit Kas). Kalau ketuker, seolah-olah ada "pendapatan" dari uang kita sendiri yang balik.
- `cancel_ar_invoice` cuma reverse jurnal invoice-nya doang tanpa ikut reverse jurnal `ar_deposit_applications` — Piutang Usaha customer itu nyasar jadi minus, DP-nya nyangkut gak jelas status.

## Piutang Tak Tertagih (Bad Debt Write-off)

**Entitas & Jurnal**
- **ar_bad_debt_writeoff** — piutang yang benar-benar gak akan tertagih (customer menghilang/tutup usaha), dihapusbukukan. **Metode direct write-off** (bukan allowance/provisi — gak ada data historis buat estimasi kredibel, gak diakui fiskus buat badan usaha umum di Indonesia, gak konsisten sama pola RPC AR lain yang reaktif per-kejadian). Beda dari `cancel_ar_invoice`: Pendapatan asli **gak dibalik** (penjualannya valid), cuma Piutang Usaha yang dihapus lewat beban baru **di periode sekarang** (bukan periode penjualan lama, walau periode itu udah ditutup — `Piutang Usaha` akun permanen, gak ikut di-reset closing). Jurnal: Debit `Beban Piutang Tak Tertagih` (expense biasa, **bukan** kontra) / Kredit Piutang Usaha. Partial-capable, dibatasi sisa outstanding riil (bukan cuma `amount` mentah kayak credit note — write-off ikut ngitung SEMUA reducer lain: payment, retur, DP). **Recovery** (piutang yang di-write-off ternyata kebayar lagi) **di luar scope** — direct write-off gak punya akun cadangan penyangga buat nampung kasus ini dengan mulus, belum didesain.

**Constraints**
- **No over-writeoff**: `SUM(ar_bad_debt_writeoffs.amount)` per invoice ≤ `ar_invoice_remaining(invoice_id)` (fungsi terpusat, lihat submodule "Konsep Inti").

**Skenario referensi**

| # | Kasus | Pola |
|---|---|---|
| 13 | Piutang tak tertagih (write-off) | 1 jurnal, Debit Beban Piutang Tak Tertagih / Kredit Piutang Usaha, Pendapatan asli gak dibalik |

**Common Mistakes**
- Write-off lewat `cancel_ar_invoice` — membalikkan Pendapatan yang valid, harusnya RPC terpisah yang cuma ngurangin Piutang Usaha.
- Write-off gak ngitung reducer lain (payment/retur/DP) — bisa "menghapus" uang yang udah lunas/diretur duluan.
- Allowance/provisi method buat UMKM tanpa data historis — estimasi jadi tebakan, gak diakui fiskus buat badan usaha umum.

## Kategori Campur & PPN (Compounding)

**Cara Kerja**
- Dulu `create_ar_invoice` cuma bisa 1 kategori pendapatan per invoice. Sekarang bisa dipecah beberapa kategori dalam **1 invoice yang sama** (mis. Pendapatan Penjualan Barang + Pendapatan Jasa Antar) — debit (Piutang Usaha) tetap 1 baris, cuma sisi kredit yang jadi array.
- Kategori dipilih dari katalog preset (`ar_invoice_charge_types`) yang disiapkan admin — nama + akun tujuan — bukan pilih akun COA mentah tiap transaksi. Nominal tetap diinput manual per invoice (gak ada nilai default).
- PPN Keluaran (kalau relevan) dihitung otomatis oleh sistem dari tarif yang diset admin, ditambahkan ke Piutang Usaha (customer ikut berutang pajaknya) — bukan diketik manual.
- Berlaku juga buat invoice yang lahir dari `create_goods_issue` (submodule "Penjualan & Pengakuan HPP" di `inventory.md`) — RPC itu manggil `create_ar_invoice` di dalamnya, jadi ikut dapat kemampuan yang sama.

**Aturan Bisnis**
- Kategori campur TIDAK mengubah Credit Hold — tetap dicek terhadap total invoice (subtotal kategori + PPN kalau ada), bukan per-kategori.

**Referensi:** `memory/architecture/data/ar-schema.md` submodule "Compounding & PPN" (di situ juga tabel `tax_settings` — pengaturan PPN dipakai bareng AP/AR/POS — didefinisikan penuh).

## Glossary

- **Customer**: master data pihak yang berutang ke perusahaan.
- **AR Invoice**: piutang timbul dari 1 kejadian kirim barang/jasa dengan termin.
- **AR Payment**: 1 kejadian bayar nyata dari customer, selalu nutup 1 invoice spesifik, boleh cicil (kurang dari sisa) tapi gak boleh overpay (`invoice_id` gak unik lagi sejak `0010`).
- **Credit Hold**: kondisi derived, customer ditolak bikin invoice baru karena outstanding/keterlambatan kelampaui batasnya.
- **Aging**: invoice yang `due_date`-nya udah lewat dan belum lunas.
- **AR Credit Note**: retur barang yang udah diinvoice — ngurangin outstanding invoice tanpa ubah `amount` asli, beda dari `cancel_ar_invoice`. Jalur full: tiap baris punya `condition` (`RESALABLE`/`DAMAGED`) yang nentuin cost-nya balik jadi stok atau jadi Beban Kerugian Barang Rusak.
- **Beban Kerugian Barang Rusak**: akun expense baru, dipakai barang retur `DAMAGED` (AR) dan write-off Opsi C (AP, `memory/domain/accounts-payable.md`) — kerugian barang yang gak layak jual lagi dan gak dapat kompensasi penuh dari counterparty.
- **AR Return Credit**: excess dari retur setelah invoice lunas, dicairkan otomatis jadi saldo resmi (liability `Saldo Kredit Retur Customer`) — beda akun karena beda asal jurnal (retur, bukan kelebihan kas). Sejak `0057`, cuma bisa diselesaikan refund tunai (jalur "otomatis via `warranty_replacement`" cuma berlaku data historis) — gak bisa dititip ke invoice lain.
- **Warranty Replacement**: penukaran barang pasca-retur/garansi (BUKAN gratis) — keluar stok+HPP tanpa invoice baru. Sejak `0057`, independen dari credit note (nunjuk `invoice_id` langsung, mirror `purchase_replacement` AP) dan gak nyentuh Piutang Usaha sama sekali — mutual exclusivity sama retur-kredit dijaga `sales_returned_qty()` (qty gabungan lintas jalur), bukan lagi via pembalikan diskon belakangan.
- **AR Deposit**: uang muka diterima sebelum invoice ada, dicatat ke liability `Uang Muka Penjualan` — beda dari `AR Payment` yang selalu terhadap invoice existing.
- **AR Bad Debt Write-off**: piutang yang beneran gak akan tertagih, dihapusbukukan lewat beban baru (direct write-off, bukan allowance) — Pendapatan asli gak dibalik, beda dari `cancel_ar_invoice`.
- **`ar_invoice_remaining()`**: fungsi terpusat, satu-satunya sumber kebenaran buat sisa outstanding riil 1 invoice — dipanggil semua guard/RPC AR yang butuh tau itu.
