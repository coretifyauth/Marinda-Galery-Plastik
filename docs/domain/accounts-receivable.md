# Accounts Receivable — Nagih Piutang Termin

## Masalah yang diselesaikan

Fase 2 (`general-ledger.md`) udah bisa nyatet piutang timbul (Debit Piutang Usaha) pas jual dengan termin. Tapi itu baru "kejadiannya kecatet" — belum ada mekanisme buat:

- Tau **siapa** yang berutang (customer identitasnya belum ada tabelnya sendiri, cuma nempel di `description` journal entry).
- Tau **kapan jatuh tempo** tiap piutang, dan **berapa termin** yang disepakati per customer.
- Nyatet pelunasan dan tau **piutang mana yang udah/belum lunas**, termasuk kalau pelunasannya nyicil atau digabung beberapa invoice sekaligus.
- Bikin **aging report** (piutang mana yang udah lewat jatuh tempo) buat nagih.

AR nutup gap ini: nambah lapisan "siapa berutang, berapa, kapan jatuh tempo, udah dibayar berapa" di atas General Ledger yang udah ada.

## Konsep Inti

- **Customer** — master data, entitas yang berutang ke CV Barokah (warung langganan). Punya `payment_term_days` default (misal net-7, net-14) yang dipakai buat ngitung jatuh tempo tiap invoice baru. Juga punya `credit_limit` (nullable, batas nominal piutang boleh nyangkut bersamaan) dan `overdue_threshold_days` (nullable, toleransi hari telat sebelum kena credit hold) — lihat "Credit Hold" di bawah. Bukan data transaksional — kalau terminnya berubah, di-`UPDATE` di baris yang sama, gak bikin row baru (lihat "Kenapa payment_term_days aman diubah" di bawah).
- **AR Invoice** — piutang timbul. 1 kejadian "kirim barang, belum dibayar" = 1 invoice. Tiap invoice bikin 1 journal entry: **Debit Piutang Usaha, Kredit Pendapatan**. `due_date` dihitung otomatis (`invoice_date + payment_term_days` milik customer itu) **pas invoice dibuat**, lalu disimpan permanen — gak dihitung ulang tiap kali dibaca.
- **AR Payment** — piutang berkurang, kejadian bayar beneran (bukan jadwal). 1 payment bikin 1 journal entry: **Debit Kas/Bank, Kredit Piutang Usaha**, sejumlah **total** yang dibayar — gak peduli itu nutup 1 atau banyak invoice.
- **AR Payment Allocation** — jembatan many-to-many antara payment dan invoice, nyimpen "payment ini nutup invoice mana, sejumlah berapa". Dibutuhin karena hubungan pembayaran-ke-invoice di dunia nyata jarang 1:1 (lihat Skenario di bawah).
- **Status invoice (lunas/sebagian/belum)** — **derived**, dihitung dari `SUM(allocations.amount)` invoice itu dibanding `invoice.amount`, bukan kolom manual. Konsisten sama pola `archived_at`/"published" yang udah dipakai di COA & Journal Entry (`memory/preferences/system/state-naming-convention.md`).
- **AR Credit Note (retur barang)** — barang yang udah diinvoice beneran dibalikin customer (rusak/gak laku/salah kirim), **bukan** koreksi salah input. Beda dari `cancel_ar_invoice` di 3 hal: (1) bisa **partial** (retur sebagian qty/nominal dari invoice, bukan all-or-nothing), (2) tetap bisa dibuat walau invoice udah ada payment/alokasi masuk (`cancel_ar_invoice` nolak keras di kondisi ini), (3) invoice asli **gak diedit/dibatalkan** — nilai `ar_invoices.amount` tetap penuh, retur dicatat sebagai baris/jurnal terpisah yang ngurangin outstanding-nya. Detail lengkap di bawah ("Retur Barang").
- **AR Deposit (uang muka/DP)** — customer bayar duluan sebelum invoice ada (misal pesanan custom). **Bukan** `AR Payment` — gak nyentuh Piutang Usaha sama sekali pas diterima, dicatat ke akun liability `Uang Muka Penjualan` dulu, baru direklasifikasi jadi pengurang Piutang Usaha begitu invoice-nya kebentuk (atau jadi Pendapatan Lain-lain kalau order-nya batal & DP-nya hangus). Detail lengkap di bawah ("Uang Muka / DP").
- **AR Customer Credit (kelebihan bayar)** — customer transfer lebih dari total invoice yang lagi dilunasin dalam 1 payment. Beda dari DP: piutangnya **udah ada** dan **udah kesentuh** (invoice ternutup penuh lewat alokasi normal), sisa lebihnya baru "jatuh" ke saldo kredit. Dicatat ke akun liability `Saldo Kredit Customer` (beda dari `Uang Muka Penjualan` walau sama-sama liability — asal jurnalnya beda, lihat "Kelebihan Bayar" di bawah).

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

## Credit Hold (Tahan Kredit Customer Telat Bayar)

Kalau piutang customer ke CV Barokah udah kelewat batas wajar — nominal kegedean atau kelamaan nunggak — sales berhenti kasih termin baru ke customer itu sampai piutang lama beres. Ini tindakan standar level ke-2 dari 4 tindakan penjual ke piutang telat (reminder → **credit hold** → renegosiasi cicilan → write-off).

Dua kondisi independen, **salah satu** kepenuhi langsung trigger hold (OR, bukan AND):

- **Nominal**: total piutang belum lunas customer (semua invoice open, bukan cuma yang overdue) > `customers.credit_limit`. NULL = gak ada batas nominal.
- **Waktu**: ada invoice open yang `due_date`-nya udah lewat lebih dari `customers.overdue_threshold_days` hari. NULL = gak ada batas waktu (customer itu gak pernah kena hold dari sisi ini).

Status hold **gak disimpan** — derived, dihitung ulang tiap kali `create_ar_invoice` dipanggil (query outstanding + cek overdue terlama), sama pola kayak status lunas/sebagian/belum. Kalau kena hold, `create_ar_invoice` nolak keras (invoice baru gak bisa dibuat via jalur AR).

Customer on-hold yang tetap mau dilayani **cash** (bukan termin) gak butuh perubahan apa pun di modul ini — itu jalan sebagai penjualan tunai biasa (Debit Kas, Kredit Pendapatan langsung), gak pernah masuk `ar_invoices` sama sekali karena gak ada piutang yang timbul.

`overdue_threshold_days` default di-prefill sama dengan `payment_term_days` customer itu pas dibuat (di form/UI, bukan hardcode di DB) — supaya tiap customer otomatis punya toleransi masuk akal, tapi tetap bisa diubah manual per customer sesuai profil risikonya.

## Retur Barang (Credit Note)

Warung ngembaliin barang yang udah diinvoice. Ini kejadian bisnis nyata (barang beneran balik ke Bu Nur), bukan koreksi "invoice salah dari awal" — makanya gak lewat `cancel_ar_invoice`, tapi RPC terpisah yang bikin jurnal kontra-revenue.

**Akun kontra baru**: `Retur & Potongan Penjualan` (`is_contra = true`, pasangan `Pendapatan Penjualan`, lihat `chart-of-accounts.md`). Dipakai biar "penjualan kotor" (nilai invoice asli) tetap keliatan utuh di histori, terpisah dari "berapa yang balik" — bukan langsung ngurangin `Pendapatan Penjualan`.

**Dua jalur, otomatis terdeteksi dari RPC** (user gak perlu milih):

1. **Financial-only** — invoice yang **gak** punya baris `goods_issues` nunjuk ke dia (dibuat lewat `create_ar_invoice` polos, misal invoice sebelum modul Inventory ada, atau item yang emang gak dilacak stoknya). Retur cuma bikin 1 jurnal:
   ```
   Debit Retur & Potongan Penjualan   [nominal retur]
     Kredit Piutang Usaha                    [nominal retur]
   ```
2. **Full (stok + HPP)** — invoice yang lahir dari `create_goods_issue` (barang jadi yang qty & HPP-nya udah dilacak lewat FIFO/Weighted Average). Retur bikin **2 jurnal sekaligus**:
   ```
   Debit Retur & Potongan Penjualan   [nominal retur = qty_returned x (invoice.amount / qty_issued)]
     Kredit Piutang Usaha                    [nominal retur]

   Debit Persediaan Barang Jadi       [cost retur = qty_returned x (goods_issue_lines.total_cost / qty_issued)]
     Kredit Harga Pokok Penjualan            [cost retur]
   ```
   Cost retur pakai **harga snapshot asli** dari `goods_issue_lines.total_cost` (harga pas barang itu keluar), bukan hitung ulang harga sekarang — biar konsisten sama biaya yang beneran diakui waktu itu. Barang yang balik masuk sebagai lot baru (FIFO, `source_type = SALES_RETURN`) atau nambah `inventory_balances` (Weighted Average).

**Independen dari status bayar** — retur tetap bisa dibuat baik invoice-nya belum dibayar, sebagian, maupun udah lunas penuh. Kalau invoice udah lunas, retur bikin outstanding jadi **negatif** (saldo kredit customer, Bu Nur "berutang" ke warung) — penanganan refund/pemakaian saldo kredit ini **di luar scope** fitur ini, lihat "Belum Termasuk".

**Guard "no over return"** — total retur (akumulasi) terhadap 1 invoice gak boleh ngelebihin `amount` invoice itu (jalur financial-only) atau `qty_issued` baris `goods_issue_lines`-nya (jalur full), pola sama `ar_payment_allocations_no_over_allocation`.

**Batas waktu retur** — barang fisik (apalagi roti, gampang basi) gak masuk akal diretur bertahun-tahun kemudian. Dua lapis beda yang sengaja gak digabung:
- **Kebijakan window retur** — `items.return_window_days` (nullable, default `NULL` = gak dibatasi). Ditaro **per item**, bukan per customer atau global, karena yang nentuin "boleh diretur sampai berapa lama" itu sifat fisik barangnya (roti tawar cepat basi vs kue kering awet), bukan hubungan dagang ke customer tertentu — beda axis dari `customers.credit_limit`/`overdue_threshold_days`. RPC `create_ar_credit_note` cek tiap baris: kalau item itu punya `return_window_days` dan `credit_note_date - invoice_date` ngelewatin itu → `raise exception`, tolak sebelum jurnal dibuat. Cuma berlaku buat jalur full (retur yang nunjuk `item_id` lewat `goods_issue_lines`) — jalur financial-only gak ada `item_id` buat dicek ke situ.
- **Batasan period closing** — retur gak boleh dicatat ke periode yang udah ditutup (`period_closings`). Ini **udah otomatis kepegang** oleh trigger `journal_entries_block_retroactive_into_closed_period` yang di-reuse lewat `create_journal_entry`, gak butuh constraint baru. Beda dari window retur di atas: ini soal integritas pembukuan (gak boleh ubah periode yang udah dikunci), bukan kebijakan toko.

**Bukan penggantian barang** — retur cuma "barang balik", gak otomatis bikin barang pengganti keluar lagi. Penggantian barang gratis (tukar barang rusak dengan barang baru tanpa nagih ulang) butuh RPC beda — lihat "Penggantian Barang Gratis Pasca-Retur" di bawah.

## Penggantian Barang Gratis Pasca-Retur

Customer balikin barang rusak (garansi kualitas) DAN minta barang pengganti — **tanpa nagih ulang**, karena ini kompensasi garansi, bukan penjualan baru. Beda dari retur biasa di atas: retur cuma "barang balik, tagihan berkurang", ini "barang balik, DAN ada barang baru keluar gratis buat gantiin".

**Kenapa gak lewat `create_goods_issue` biasa** — `create_goods_issue` selalu bikin invoice baru (Debit Piutang Usaha, Kredit Pendapatan). Penggantian gratis gak nagih customer lagi, jadi kalau dipaksa lewat situ, piutang customer numpuk palsu dan Pendapatan Penjualan kegedean padahal bukan penjualan beneran. Jurnal yang bener cuma:
```
Debit Harga Pokok Penjualan (HPP)   [cost barang pengganti]
  Kredit Persediaan Barang Jadi            [cost barang pengganti]
```
Gak nyentuh Piutang Usaha atau Pendapatan sama sekali — invoice asli & retur yang udah ada tetap gak berubah.

**Wajib referensi ke AR Credit Note yang udah ada** (jalur full, retur yang punya `inventory_returns` — bukti barang emang balik ke gudang) — gak bisa berdiri sendiri tanpa retur formal duluan. Alasan bisnis:
- **Audit trail** — tanpa bukti retur, penggantian gratis gampang disalahgunakan (klaim "rusak" tanpa bukti barang balik).
- **Traceability** (Core Invariant project ini) — pengeluaran stok gratis harus nunjuk ke dokumen sumber jelas, biar gak disalahartikan kebocoran/pencurian stok.
- **Matching principle** — biaya penggantian itu beban garansi yang berasal dari penjualan yang udah diakui sebelumnya, harus terhubung ke transaksi asalnya.

**Batas kuantitas** — total qty yang diganti (akumulasi, bisa lebih dari 1 kali penggantian per credit note) gak boleh ngelebihin qty yang beneran diretur di credit note itu (per item) — pola sama no-over-return. Barang pengganti diambil dari stok **fresh** yang aktif (FIFO/Weighted Average biasa) — **bukan** dari lot `SALES_RETURN` yang baru masuk dari retur (barang rusak yang balik itu gak dijual/dipakai ganti lagi, lot-nya kepisah).

## Uang Muka / DP (Deposit)

Customer bayar duluan sebelum ada invoice — biasanya buat pesanan custom (misal kue ulang tahun) yang belum dikerjain. Ini beda dari `ar_payment` biasa: `ar_payment` selalu mengasumsikan ada piutang yang mau dilunasin (invoice-nya udah ada), sementara DP diterima **sebelum** piutang itu ada sama sekali.

**Kenapa gak langsung dicatat sebagai pengurang Piutang Usaha** kayak pembayaran biasa: karena piutangnya belum ada. Prinsip pengakuan pendapatan (matching principle) bilang pendapatan diakui pas barang/jasa diserahkan, bukan pas duit diterima — jadi DP itu bukan pendapatan Bu Nur, itu **kewajiban** (Bu Nur "berutang" kue atau uang balik ke customer sampai kuenya jadi). Dicatat ke akun liability baru: **Uang Muka Penjualan**.

**Tiga kejadian, tiga jurnal berbeda:**

1. **DP diterima** — Debit Kas/Bank, Kredit Uang Muka Penjualan. Belum nyentuh Piutang Usaha atau Pendapatan sama sekali.
2. **DP diterapkan ke invoice** (begitu barang jadi & invoice diterbitkan penuh) — Debit Uang Muka Penjualan, Kredit Piutang Usaha. Ini reklasifikasi, bukan pembayaran baru — ngurangin outstanding invoice itu.
3. **DP hangus** (order dibatalin SEBELUM invoice ada, kebijakan Bu Nur: DP gak dikembaliin karena bahan khusus udah kadung dibeli) — Debit Uang Muka Penjualan, Kredit **Pendapatan Lain-lain** (BUKAN Pendapatan Penjualan — ini bukan hasil jual roti, jadi harus kepisah biar Laba Rugi gak nyampur "penjualan beneran" sama "DP hangus").

Status 1 deposit (belum dipakai / diterapkan / hangus) **derived**, bukan kolom — sama pola kayak status invoice. Satu deposit cuma boleh punya **satu** disposisi aktif (diterapkan ATAU hangus), ditegakkan trigger.

**Interaksi sama pembatalan invoice**: kalau invoice yang DP-nya udah diterapkan ternyata perlu dibatalin (misal salah input), `cancel_ar_invoice` **ikut membalikkan jurnal DP-application-nya juga** (reversing entry kedua, bukan cuma jurnal invoice-nya doang) — biar DP-nya otomatis balik jadi "belum dipakai" lagi (siap dipakai ulang/dihanguskan), bukan nyangkut jadi piutang minus yang gak jelas asalnya. Tanpa ini, cuma nolak pembatalan (kayak guard `ar_payment_allocations`) gak nyelesain apa-apa — orangnya cuma kejebak, DP-nya tetep nyangkut gak jelas statusnya.

## Kelebihan Bayar (Overpayment) jadi Saldo Kredit Customer

Customer transfer lebih dari yang seharusnya buat nutup invoice yang lagi dibayar (salah nominal, pembulatan, atau sengaja "biar gak minus lagi" nanti). 1 payment event (1 bukti transfer bank = 1 source document) yang jumlahnya lebih besar dari total alokasi ke invoice yang bisa nampung.

**Kenapa bukan `AR Deposit`**: DP diterima **sebelum** piutang ada sama sekali. Overpayment terjadi **setelah** piutang ada dan lagi dilunasin — invoice yang dituju tetap ternutup penuh lewat alokasi normal (Debit Kas, Kredit Piutang Usaha, sejumlah nominal invoice), sisa lebihnya yang gak punya invoice buat nyantol. Dua kejadian yang keliatan mirip hasil akhirnya (sama-sama liability "utang ke customer") tapi beda total asal-usul jurnalnya.

**Kenapa 1 payment event, bukan 2 payment terpisah**: satu bukti transfer bank cuma 1 kejadian nyata (Core Invariant — traceability ke 1 source document). Splitnya (porsi nutup invoice vs porsi jadi kredit) terjadi **di dalam** 1 journal entry yang sama, bukan 2 payment record beda tanggal/sumber.

Jurnal pas payment diterima (kalau ada excess):
```
Debit Kas/Bank                [total transfer]
  Kredit Piutang Usaha              [porsi yang teralokasi ke invoice]
  Kredit Saldo Kredit Customer      [sisa excess]
```

**Dua disposisi excess, boleh dipakai sebagian-sebagian / berkali-kali** (beda dari DP yang cuma 1 disposisi aktif) — karena saldo kredit ini sifatnya kayak "dompet" customer, bukan terikat ke 1 pesanan spesifik:

1. **Dipakai motong invoice lain** (kapan aja ke depan, gak harus invoice berikutnya langsung) — Debit Saldo Kredit Customer, Kredit Piutang Usaha, sejumlah yang dipakai.
2. **Direfund tunai** (customer minta balik, bukan dipakai) — Debit Saldo Kredit Customer, Kredit Kas/Bank.

Total (dipakai + direfund) gak boleh ngelebihin nominal kredit awal — pola sama no-over-allocation.

## Skenario (lihat detail angka lengkap di `docs/story/accounts-receivable.md`)

1. Invoice lunas tepat waktu — kasus paling sederhana, 1 payment = 1 invoice, alokasi penuh.
2. Bayar sebagian (cicil) — 1 invoice, 2+ payment, tiap payment 1 baris alokasi ke invoice yang sama.
3. 1 payment nutup banyak invoice sekaligus — 1 payment, alokasi pecah ke beberapa invoice, tapi tetap cuma 1 journal entry (GL gak peduli breakdown per-invoice).
4. Telat bayar — query aging (`due_date < now()` dan belum lunas), read-side doang, gak butuh kolom/job tambahan.
5. Invoice dibatalkan (salah input, belum ada payment) — reversing entry via RPC `cancel_ar_invoice`, bukan hapus, sama kayak koreksi journal entry biasa. Ditolak kalau invoice udah punya alokasi payment (constraint #5).
6. Invoice baru ditolak karena credit hold — customer kelampaui `credit_limit` ATAU ada invoice overdue lebih dari `overdue_threshold_days`-nya, `create_ar_invoice` nolak sebelum sempat bikin journal entry.
7. Retur barang, invoice financial-only, belum lunas — outstanding turun langsung dari nominal retur.
8. Retur barang, invoice via goods issue, udah lunas — 2 jurnal (kontra-revenue + reversal HPP), stok masuk lagi, outstanding jadi negatif (saldo kredit).
9. DP diterima lalu diterapkan penuh ke invoice — 3 jurnal terpisah (terima DP, terbitkan invoice, terapkan DP), outstanding invoice berkurang sejumlah DP.
10. DP hangus — order dibatalin sebelum invoice ada, DP jadi Pendapatan Lain-lain, gak ada invoice yang pernah dibuat sama sekali.
11. Invoice yang DP-nya udah diterapkan ternyata dibatalin (salah input) — pembatalan otomatis ikut membalikkan jurnal DP-application, DP balik jadi belum dipakai.
12. Penggantian barang gratis pasca-retur (jalur full) — 1 jurnal (HPP/Persediaan Barang Jadi), gak nyentuh Piutang/Pendapatan, referensi ke credit note yang udah ada.
13. Overpayment — payment nutup 1 invoice penuh + sisa jadi saldo kredit, dalam 1 journal entry (3 baris: Kas, Piutang Usaha, Saldo Kredit Customer).
14. Saldo kredit dipakai motong invoice lain — Debit Saldo Kredit Customer, Kredit Piutang Usaha, partial-capable.
15. Saldo kredit direfund tunai — Debit Saldo Kredit Customer, Kredit Kas.

## Common Mistakes

- Nyimpen `due_date` sebagai kolom yang dihitung ulang tiap baca dari `payment_term_days` customer saat ini — bikin invoice lama ikut geser kalau termin customer berubah. Harus snapshot pas insert.
- Nyimpen status "lunas/belum" sebagai kolom manual yang harus di-`UPDATE` tiap ada payment — resiko gak sinkron kalau ada bug/lupa update. Harus derived dari alokasi.
- Payment langsung `invoice_id` tanpa tabel alokasi — gak bisa nampung pembayaran gabungan/cicilan/overpay parsial.
- Invoice/payment insert langsung ke tabel AR tanpa lewat RPC yang juga bikin journal entry — piutang tercatat di AR tapi GL gak ke-update, dua sumber angka jadi gak sinkron.
- Alokasi ngelebihin amount invoice atau amount payment — duit "nutup" lebih dari yang sebenarnya ada.
- Batalin invoice yang udah ada payment/alokasi tanpa mikirin nasib pembayarannya — reversing entry doang bikin GL balance, tapi duit customer yang udah masuk jadi "nyantol" gak jelas. Harus ditolak di level RPC, bukan cuma diingetin di UI.
- Cek credit hold cuma di UI (warning yang bisa di-skip) — harus hard-reject di RPC `create_ar_invoice`, gak boleh bergantung ke frontend buat invariant bisnis ini.
- Nyimpen status "on hold" sebagai kolom manual di `customers` — harus derived tiap invoice baru dicek, biar gak ada resiko status basi (customer udah bayar tapi kolom belum di-update).
- Retur mereduksi `Pendapatan Penjualan` langsung (bukan lewat akun kontra `Retur & Potongan Penjualan`) — bikin nilai "penjualan kotor" asli gak keliatan lagi di histori.
- Retur jalur full pakai harga **sekarang** buat reversal HPP/nilai stok balik (bukan `goods_issue_lines.total_cost` snapshot asli) — bikin nilai stok gak konsisten kalau harga bahan baku/produksi udah berubah sejak barang itu keluar.
- Retur nolak invoice yang udah lunas/ada alokasi — retur harus tetap bisa jalan justru karena beda dari `cancel_ar_invoice`, hasilnya boleh aja bikin saldo kredit.
- Batas waktu retur ditaro per customer atau global (bukan per item) — window retur soal sifat fisik barang, bukan hubungan dagang.
- Bikin constraint baru buat "gak boleh retur ke periode tertutup" — udah otomatis kepegang trigger period-closing existing, jangan duplikat logic.
- Mengakui DP sebagai Pendapatan (atau langsung ngurangin Piutang Usaha) pas diterima — piutangnya belum ada, dan barang/jasanya belum diserahkan. Harus lewat akun liability `Uang Muka Penjualan` dulu.
- DP hangus dicatat ke `Pendapatan Penjualan` biasa — harus ke `Pendapatan Lain-lain`, biar gak nyampur sama hasil jualan beneran.
- Batalin invoice yang DP-nya udah diterapkan tanpa ikut membalikkan jurnal DP-application-nya — Piutang Usaha customer itu bakal nyasar jadi minus, dan DP-nya nyangkut gak jelas statusnya.
- Penggantian barang gratis lewat `create_goods_issue` biasa (bikin invoice lagi) — piutang & pendapatan numpuk palsu padahal gak ada penjualan baru.
- Penggantian barang gratis tanpa referensi ke credit note yang udah ada — kehilangan audit trail, pengeluaran stok gratis jadi gak bisa dipertanggungjawabkan.
- Barang pengganti diambil dari lot `SALES_RETURN` (barang rusak yang balik dari retur) — harusnya dari stok fresh, barang rusak gak dipakai ganti lagi.
- Overpayment dicatat sebagai 2 payment terpisah (1 nutup invoice, 1 lagi "nyimpen" kelebihan) — harus 1 payment event, 1 journal entry, biar traceable ke 1 bukti transfer.
- Excess overpayment dicatat langsung ke `Uang Muka Penjualan` (nyamain sama DP) — beda akun, karena beda asal-usul (piutang udah ada & udah dilunasin vs piutang belum ada sama sekali).
- Saldo kredit dipakai/refund ngelebihin nominal awal — pola sama no-over-allocation, harus ditolak trigger.

## Belum Termasuk (di luar scope fase ini)

- **Retur yang bikin outstanding invoice negatif** (lihat "Retur Barang") — beda mekanisme dari overpayment payment (yang sekarang udah di-scope di atas): retur ngurangin `amount` piutang lewat kontra-revenue, bukan lewat kelebihan pembayaran kas. Penanganan saldo kredit dari retur-negatif ini masih belum didesain.
