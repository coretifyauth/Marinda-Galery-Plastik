# Accounts Receivable — Nagih Piutang Termin

## Masalah yang diselesaikan

Fase 2 (`general-ledger.md`) udah bisa nyatet piutang timbul (Debit Piutang Usaha) pas jual dengan termin. Tapi itu baru "kejadiannya kecatet" — belum ada mekanisme buat:

- Tau **siapa** yang berutang (customer identitasnya belum ada tabelnya sendiri, cuma nempel di `description` journal entry).
- Tau **kapan jatuh tempo** tiap piutang, dan **berapa termin** yang disepakati per customer.
- Nyatet pelunasan dan tau **piutang mana yang udah/belum lunas**, termasuk kalau pelunasannya nyicil atau digabung beberapa invoice sekaligus.
- Bikin **aging report** (piutang mana yang udah lewat jatuh tempo) buat nagih.

AR nutup gap ini: nambah lapisan "siapa berutang, berapa, kapan jatuh tempo, udah dibayar berapa" di atas General Ledger yang udah ada.

## Konsep Inti

- **Customer** — master data, entitas yang berutang ke CV Barokah (warung langganan). Punya `payment_term_days` default (misal net-7, net-14) yang dipakai buat ngitung jatuh tempo tiap invoice baru. Juga punya `credit_limit` (nullable, batas nominal piutang boleh nyangkut bersamaan), `overdue_threshold_days` (nullable, toleransi hari telat sebelum kena credit hold — lihat "Credit Hold" di bawah), dan `return_window_days` (nullable, toleransi hari buat customer ini ngajuin retur — lihat "Retur Barang" bagian "Batas waktu retur"). Bukan data transaksional — kalau terminnya berubah, di-`UPDATE` di baris yang sama, gak bikin row baru (lihat "Kenapa payment_term_days aman diubah" di bawah).
- **AR Invoice** — piutang timbul. 1 kejadian "kirim barang, belum dibayar" = 1 invoice. Tiap invoice bikin 1 journal entry: **Debit Piutang Usaha, Kredit Pendapatan**. `due_date` dihitung otomatis (`invoice_date + payment_term_days` milik customer itu) **pas invoice dibuat**, lalu disimpan permanen — gak dihitung ulang tiap kali dibaca.
- **AR Payment** — piutang berkurang, kejadian bayar beneran (bukan jadwal). 1 payment bikin 1 journal entry: **Debit Kas/Bank, Kredit Piutang Usaha**, sejumlah **total** yang dibayar — gak peduli itu nutup 1 atau banyak invoice.
- **AR Payment Allocation** — jembatan many-to-many antara payment dan invoice, nyimpen "payment ini nutup invoice mana, sejumlah berapa". Dibutuhin karena hubungan pembayaran-ke-invoice di dunia nyata jarang 1:1 (lihat Skenario di bawah).
- **Status invoice (lunas/sebagian/belum)** — **derived**, dihitung dari `SUM(allocations.amount)` invoice itu dibanding `invoice.amount`, bukan kolom manual. Konsisten sama pola `archived_at`/"published" yang udah dipakai di COA & Journal Entry (`memory/preferences/system/state-naming-convention.md`).
- **AR Credit Note (retur barang)** — barang yang udah diinvoice beneran dibalikin customer (rusak/gak laku/salah kirim), **bukan** koreksi salah input. Beda dari `cancel_ar_invoice` di 3 hal: (1) bisa **partial** (retur sebagian qty/nominal dari invoice, bukan all-or-nothing), (2) tetap bisa dibuat walau invoice udah ada payment/alokasi masuk (`cancel_ar_invoice` nolak keras di kondisi ini), (3) invoice asli **gak diedit/dibatalkan** — nilai `ar_invoices.amount` tetap penuh, retur dicatat sebagai baris/jurnal terpisah yang ngurangin outstanding-nya. Detail lengkap di bawah ("Retur Barang").
- **AR Deposit (uang muka/DP)** — customer bayar duluan sebelum invoice ada (misal pesanan custom). **Bukan** `AR Payment` — gak nyentuh Piutang Usaha sama sekali pas diterima, dicatat ke akun liability `Uang Muka Penjualan` dulu, baru direklasifikasi jadi pengurang Piutang Usaha begitu invoice-nya kebentuk (atau jadi Pendapatan Lain-lain kalau order-nya batal & DP-nya hangus). Detail lengkap di bawah ("Uang Muka / DP").
- **AR Customer Credit (kelebihan bayar)** — customer transfer lebih dari total invoice yang lagi dilunasin dalam 1 payment. Beda dari DP: piutangnya **udah ada** dan **udah kesentuh** (invoice ternutup penuh lewat alokasi normal), sisa lebihnya baru "jatuh" ke saldo kredit. Dicatat ke akun liability `Saldo Kredit Customer` (beda dari `Uang Muka Penjualan` walau sama-sama liability — asal jurnalnya beda, lihat "Kelebihan Bayar" di bawah).
- **AR Bad Debt Write-off (piutang tak tertagih)** — piutang yang **benar-benar** gak akan pernah tertagih (customer menghilang/tutup usaha), diakui sebagai kerugian. Beda dari `cancel_ar_invoice`: transaksinya valid, Pendapatan yang udah diakui **gak dibalik** — cuma piutangnya yang dihapusbukukan lewat beban baru di periode saat ketauan macetnya. Metode **direct write-off** (bukan allowance/provisi) — lihat "Piutang Tak Tertagih" di bawah buat rasional lengkap.
- **AR Return Credit (saldo kredit dari retur)** — retur barang yang kejadian **setelah** invoice-nya udah lunas bikin outstanding jadi negatif (lihat "Retur Barang"). Sisa negatifnya otomatis "dicairkan" jadi saldo resmi milik customer — pola sama persis AR Customer Credit (overpayment), tapi dicatat ke akun liability terpisah (`Saldo Kredit Retur Customer`) karena beda asal jurnal (retur, bukan kelebihan kas). Lihat "Saldo Kredit dari Retur" di bawah.

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

**Batas waktu retur** — barang fisik (apalagi roti, gampang basi) gak masuk akal diretur bertahun-tahun kemudian. **Tiga** lapis beda yang sengaja gak digabung jadi satu:
- **Kebijakan window retur per item** — `items.return_window_days` (nullable, default `NULL` = gak dibatasi). Ditaro **per item**, karena yang nentuin "boleh diretur sampai berapa lama" itu sifat fisik barangnya (roti tawar cepat basi vs kue kering awet) — axis ini gak berubah siapa pun pembelinya. RPC `create_ar_credit_note` cek tiap baris: kalau item itu punya `return_window_days` dan `credit_note_date - invoice_date` ngelewatin itu → `raise exception`, tolak sebelum jurnal dibuat. Cuma berlaku buat jalur full (retur yang nunjuk `item_id` lewat `goods_issue_lines`) — jalur financial-only gak ada `item_id` buat dicek ke situ.
- **Toleransi retur per customer (trade term)** — `customers.return_window_days` (nullable, default `NULL` = gak dibatasi), **snapshot** ke `ar_invoices.return_window_days` pas invoice dibuat (pola identik `due_date` dari `payment_term_days` — perubahan `customers.return_window_days` belakangan gak retroaktif ngubah invoice lama). Beda axis dari window per item: ini soal **toleransi dagang yang disepakati ke customer tertentu** (sama kelompoknya sama `payment_term_days`/`credit_limit`/`overdue_threshold_days`), bukan soal sifat fisik barang. RPC `create_ar_credit_note` cek ini **paling awal**, sebelum jurnal apa pun dibuat — kalau `ar_invoices.return_window_days` invoice itu gak null dan `credit_note_date - invoice_date` ngelewatin itu, `raise exception`. **Berlaku ke SEMUA jalur** (full maupun financial-only) — beda dari window per item yang cuma nyampe jalur full, ini yang nutup gap "financial-only gak ada batas waktu sama sekali".
  - **Dua window ini COEXIST, bukan saling gantiin** — buat retur jalur full yang nunjuk 1 item spesifik, DUA-duanya dicek independen, dan retur ditolak kalau **salah satu** kelampaui (pola OR-to-reject, sama persis logika Credit Hold di atas). Analoginya: batas kecepatan jalan umum vs zona sekolah — 2 rambu beda sumber, yang lebih ketat yang berlaku, bukan saling menganulir. Contoh: item Roti Tawar window 3 hari, customer window 15 hari, retur diajukan hari ke-10 → tetap **ditolak** (item exceeded), walau customer window-nya masih longgar.
- **Batasan period closing** — retur gak boleh dicatat ke periode yang udah ditutup (`period_closings`). Ini **udah otomatis kepegang** oleh trigger `journal_entries_block_retroactive_into_closed_period` yang di-reuse lewat `create_journal_entry`, gak butuh constraint baru. Beda dari 2 window di atas: ini soal integritas pembukuan (gak boleh ubah periode yang udah dikunci), bukan kebijakan toko.

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

## Piutang Tak Tertagih (Bad Debt Write-off)

Piutang yang udah kelewat batas wajar (credit hold, reminder, dst) tapi tetap gak kunjung dibayar, sampai akhirnya jelas customer-nya gak akan pernah bisa/mau bayar (menghilang, tutup usaha, dsb). Ini level tindakan ke-4 (paling ekstrem) dari 4 tindakan penjual ke piutang telat (reminder → credit hold → renegosiasi cicilan → **write-off**).

**Kenapa bukan `cancel_ar_invoice`**: invoice-nya **benar** dari awal — barang/jasa beneran diserahkan, Pendapatan yang diakui waktu itu **valid dan tetap berdiri**. Membalikkan Pendapatan (lewat reversing entry `cancel_ar_invoice`) akan salah merepresentasikan histori — penjualannya beneran kejadian, yang berubah cuma keyakinan piutangnya bisa dicairkan. Write-off mengakui **kerugian baru** di periode saat ketauan macetnya, bukan mengoreksi periode penjualan yang lama (termasuk kalau periode penjualan itu udah ditutup lewat `close_period` — write-off gak pernah butuh "membuka" jurnal lama, karena `Piutang Usaha` itu akun permanen yang gak ikut di-nol-in periode closing, cuma `Beban`/`Pendapatan` yang di-reset).

**Metode: Direct write-off** (bukan allowance/provisi method), dipilih karena:
- **Gak ada data historis buat estimasi kredibel** — belum pernah ada write-off sebelumnya di CV Roti Barokah, jadi persentase cadangan cuma bakal jadi tebakan.
- **Volume & materialitas kecil** — piutang macet sifatnya jarang/satuan (bukan pola berulang skala besar yang butuh diagregat statistik).
- **Sesuai praktik pajak Indonesia** — piutang tak tertagih buat badan usaha umum (bukan lembaga keuangan/bank/leasing) cuma diakui fiskus lewat metode **langsung dihapuskan**, bukan metode cadangan (yang dibatasi ke sektor tertentu oleh aturan Menteri Keuangan).
- **Konsisten sama pola RPC AR lain** — semua reaktif ke 1 kejadian konkret (`cancel_ar_invoice`, credit note, DP, customer credit), bukan proses estimasi periodik yang gak punya padanan pola di modul ini.

**Akun baru**: `Beban Piutang Tak Tertagih` (kategori expense biasa, **bukan** akun kontra — beda dari `Retur & Potongan Penjualan`/`Akumulasi Penyusutan` yang kontra-aset/kontra-revenue, karena di direct write-off gak ada akun "cadangan" perantara, Piutang Usaha langsung dikurangin).

**Jurnal** (1 kejadian = 1 jurnal, gak ada tahap estimasi terpisah):
```
Debit Beban Piutang Tak Tertagih   [nominal write-off]
  Kredit Piutang Usaha                    [nominal write-off]
```

**Partial-capable** — nominal write-off gak wajib penuh sejumlah outstanding invoice (bisa aja cuma sebagian dianggap macet), tapi gak boleh ngelebihin **sisa outstanding riil** invoice itu (`amount` dikurangi SEMUA reducer lain yang udah ada: alokasi payment, retur, DP-application, customer-credit-application) — beda dari guard retur yang sengaja independen/boleh bikin outstanding negatif, write-off gak masuk akal "menghapus" uang yang udah lunas/diretur/dikreditkan duluan lewat mekanisme lain.

**Interaksi sama mekanisme lain**:
- **Guard reducer lain ikut diperluas** — `ar_payment_allocations`, `ar_deposit_applications`, `ar_customer_credit_applications` guard-nya masing-masing ikut ngurangin write-off aktif dari "sisa ruang" invoice, biar gak ada jalur yang over-collect ke invoice yang udah (sebagian) di-write-off. Pola sama persis tiap kali reducer baru ditambah ke AR (lihat riwayat `ar-schema.md` bagian AR Deposit & AR Customer Credit).
- **Credit hold** (`create_ar_invoice`) — outstanding calc ikut ngurangin write-off aktif, biar piutang yang udah dihapusbukukan gak masih keitung sebagai exposure customer itu.
- **`cancel_ar_invoice`** — ditolak kalau invoice udah punya write-off (sama alasan guard payment yang udah ada: piutang ini udah "kesentuh" keputusan bisnis lain, gak bisa dianggap "gak pernah terjadi" lewat jalur salah-input).
- **Period closing** — otomatis kepegang trigger existing (`journal_entries_block_retroactive_into_closed_period`), gak butuh constraint baru. Kalau tanggal write-off jatuh di periode tertutup, dicatat pakai tanggal periode berjalan (sama pola semua RPC lain yang manggil `create_journal_entry`).

**Di luar scope fitur ini — recovery** (piutang yang udah di-write-off ternyata akhirnya kebayar juga). Direct write-off gak punya akun "cadangan" penyangga buat nampung kasus ini dengan mulus (beda dari allowance method) — kalau nanti beneran kejadian di cerita, butuh desain terpisah (kandidat: `Debit Kas / Kredit Pendapatan Lain-lain`, gak reinstate `Piutang Usaha` lagi, biar gak perlu "membuka" balik histori invoice lama).

## Saldo Kredit dari Retur (AR Return Credit)

Retur barang (lihat "Retur Barang" di atas) sengaja **independen** dari status bayar invoice — boleh tetap dibuat walau invoice-nya udah lunas penuh, dan itu bikin outstanding invoice itu jadi **negatif**. Secara bisnis, angka negatif itu artinya: CV Roti Barokah sekarang "berutang" ke customer sejumlah itu (customer udah kadung bayar lebih dari yang seharusnya, karena sebagian barangnya cacat).

**Kenapa butuh mekanisme sendiri, bukan cuma dibiarkan sebagai angka minus**: tanpa ini, gak ada cara resmi buat customer mencairkan haknya — gak ada tombol "pakai buat motong tagihan berikutnya" atau "refund tunai", padahal secara bisnis dia berhak dapat salah satunya. Ini persis masalah yang sudah diselesaikan buat kelebihan bayar (`AR Customer Credit`) — bedanya cuma **asal kejadian**: satu dari kelebihan transfer kas, satu dari barang yang balik setelah lunas. Karena beda asal jurnal, dicatat ke akun liability terpisah: `Saldo Kredit Retur Customer` (bukan `Saldo Kredit Customer` yang dipakai overpayment) — biar riwayatnya tetap bisa ditelusuri balik ke retur mana yang jadi sumbernya, konsisten sama prinsip "beda asal jurnal → beda akun" yang udah dipegang sepanjang modul ini (DP vs Customer Credit vs Write-off).

**Kapan ini terjadi**: dideteksi otomatis oleh `create_ar_credit_note` — begitu 1 retur bikin outstanding invoice itu turun di bawah nol, bagian yang "kelebihan" (bukan seluruh nominal retur, cuma porsi yang gak ketampung sisa outstanding yang ada) langsung dicairkan jadi saldo resmi lewat jurnal reklasifikasi:
```
Debit Piutang Usaha              [excess]
  Kredit Saldo Kredit Retur Customer   [excess]
```
Nominal `excess` = nominal retur dikurangi sisa outstanding yang masih ada sebelum retur ini (kalau sisanya udah negatif dari retur sebelumnya, seluruh nominal retur baru ini jadi excess).

**Dua disposisi, partial-capable & berulang** (pola sama `AR Customer Credit`, bukan disposisi tunggal kayak DP):
1. **Dipakai** motong invoice lain customer yang sama, kapan aja — Debit Saldo Kredit Retur Customer / Kredit Piutang Usaha.
2. **Direfund tunai** — Debit Saldo Kredit Retur Customer / Kredit Kas/Bank.

**Interaksi sama `cancel_ar_invoice`**: kalau invoice yang udah dipotong saldo kredit retur ternyata dibatalkan, RPC ikut membalikkan jurnal penerapannya juga (auto-unwind, pola sama DP & Customer Credit — bukan ditolak keras kayak write-off, karena ini reklasifikasi sederhana yang aman dibalik).

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
16. Piutang tak tertagih (write-off) — pesanan custom yang customernya menghilang, Debit Beban Piutang Tak Tertagih, Kredit Piutang Usaha, Pendapatan asli gak dibalik.
17. Saldo kredit dari retur — retur setelah invoice lunas bikin outstanding negatif, excess-nya otomatis dicairkan jadi saldo resmi (Debit Piutang Usaha, Kredit Saldo Kredit Retur Customer), bisa dipakai/direfund kayak overpayment.
18. Batas retur per customer — retur ditolak kalau ngelewatin `customers.return_window_days` (snapshot ke invoice), berlaku ke jalur full maupun financial-only, independen dari batas per item.

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
- Anggap batas retur per item dan per customer saling gantiin (cukup salah satu) — dua-duanya axis yang beda (sifat fisik barang vs toleransi dagang), harus tetap coexist dan dicek independen, bukan salah satu didrop karena "udah kecover" yang lain.
- `customers.return_window_days` dihitung ulang dari nilai TERKINI tiap kali retur dicek (bukan snapshot ke invoice) — bikin invoice lama ikut kena batas baru kalau toleransi customer diubah belakangan, sama kelas masalahnya kayak `due_date`.
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
- Write-off lewat `cancel_ar_invoice` (membalikkan Pendapatan) — penjualannya beneran kejadian, gak boleh dianggap "gak pernah ada". Harus RPC terpisah yang cuma ngurangin Piutang Usaha lewat beban baru.
- Write-off ngelebihin sisa outstanding riil invoice (gak ngitung reducer lain kayak payment/retur/DP/customer-credit yang udah ada) — bisa "menghapus" uang yang sebenarnya udah lunas/diretur/dikreditkan duluan.
- Pakai allowance/provisi method buat CV skala UMKM tanpa data historis kerugian — estimasinya cuma tebakan, dan gak diakui fiskus buat badan usaha umum di Indonesia.
- Excess dari retur negatif dicatat ke `Saldo Kredit Customer` (akun overpayment) — harus akun terpisah (`Saldo Kredit Retur Customer`), beda asal jurnal.
- Excess dari retur dihitung dari seluruh nominal retur (bukan cuma bagian yang ngelebihin sisa outstanding) — bikin dobel hitung kalau sisa outstanding-nya masih ada sebagian.

## Belum Termasuk (di luar scope fase ini)

- **Recovery piutang yang udah di-write-off** (lihat "Piutang Tak Tertagih") — direct write-off gak punya akun cadangan penyangga, penanganannya kalau ternyata kebayar lagi belum didesain.
- **Barang rusak yang di-retur masuk lagi sebagai stok bernilai** — penggantian barang gratis pasca-retur masukin barang balik ke inventory seolah layak jual, padahal kalau alasannya rusak harusnya diakui sebagai kerugian (Beban Kerugian Barang Rusak), bukan stok. Detail: `memory/scope-debt/kerugian-barang-rusak.md`.
- **BUG diketahui: penggantian barang gratis (warranty replacement) kasih kompensasi ganda** — customer bisa dapat diskon dari retur DAN barang pengganti gratis sekaligus untuk 1 kejadian cacat yang sama (contoh konkret: Pak Budi, `docs/story/accounts-receivable.md` Skenario 6+6b). Harusnya cuma pilih salah satu. Detail: `memory/scope-debt/ar-warranty-replacement-kompensasi-ganda.md`.
