# Accounts Receivable — Nagih Piutang Termin

## Masalah yang diselesaikan

Fase 2 (`general-ledger.md`) udah bisa nyatet piutang timbul (Debit Piutang Usaha) pas jual dengan termin. Tapi itu baru "kejadiannya kecatet" — belum ada mekanisme buat:

- Tau **siapa** yang berutang (customer identitasnya belum ada tabelnya sendiri, cuma nempel di `description` journal entry).
- Tau **kapan jatuh tempo** tiap piutang, dan **berapa termin** yang disepakati per customer.
- Nyatet pelunasan dan tau **piutang mana yang udah/belum lunas**, termasuk kalau pelunasannya nyicil atau digabung beberapa invoice sekaligus.
- Bikin **aging report** (piutang mana yang udah lewat jatuh tempo) buat nagih.

AR nutup gap ini: nambah lapisan "siapa berutang, berapa, kapan jatuh tempo, udah dibayar berapa" di atas General Ledger yang udah ada.

## Konsep Inti

- **Customer** — master data, entitas yang berutang ke perusahaan (customer B2B yang beli pakai termin). Punya `payment_term_days` default (misal net-7, net-14) yang dipakai buat ngitung jatuh tempo tiap invoice baru. Juga punya `credit_limit` (nullable, batas nominal piutang boleh nyangkut bersamaan) dan `overdue_threshold_days` (nullable, toleransi hari telat sebelum kena credit hold — lihat "Credit Hold" di bawah). Bukan data transaksional — kalau terminnya berubah, di-`UPDATE` di baris yang sama, gak bikin row baru (lihat "Kenapa payment_term_days aman diubah" di bawah).
- **AR Invoice** — piutang timbul. 1 kejadian "kirim barang, belum dibayar" = 1 invoice. Tiap invoice bikin 1 journal entry: **Debit Piutang Usaha, Kredit Pendapatan**. `due_date` dihitung otomatis (`invoice_date + payment_term_days` milik customer itu) **pas invoice dibuat**, lalu disimpan permanen — gak dihitung ulang tiap kali dibaca.
- **AR Payment** — piutang berkurang, kejadian bayar beneran (bukan jadwal). Selalu nutup **1 invoice spesifik** (gak ada gabung beberapa invoice dalam 1 payment), boleh **cicil** (kurang dari sisa outstanding, 1 invoice boleh punya banyak baris payment dari waktu ke waktu), tapi gak boleh **overpay** (kelebihan bayar yang "nyantol" jadi saldo tetap gak didukung). Tiap baris payment bikin 1 journal entry: **Debit Kas/Bank, Kredit Piutang Usaha**, sejumlah yang beneran dibayar — `record_ar_payment` `raise exception` cuma kalau nominalnya melebihi sisa. Lihat "Kenapa Payment Boleh Cicil Tapi Gak Boleh Overpay" di bawah buat alasan bisnisnya.
- **Status invoice (lunas/sebagian/belum)** — **derived**, dihitung dari `SUM(ar_payments.amount)` buat invoice itu dibanding `invoice.amount`, bukan kolom manual. Konsisten sama pola `archived_at`/"published" yang udah dipakai di COA & Journal Entry (`memory/preferences/system/state-naming-convention.md`).
- **AR Credit Note (retur barang)** — barang yang udah diinvoice beneran dibalikin customer (rusak/gak laku/salah kirim), **bukan** koreksi salah input. Beda dari `cancel_ar_invoice` di 3 hal: (1) bisa **partial** (retur sebagian qty/nominal dari invoice, bukan all-or-nothing), (2) tetap bisa dibuat walau invoice udah ada payment masuk (`cancel_ar_invoice` nolak keras di kondisi ini), (3) invoice asli **gak diedit/dibatalkan** — nilai `ar_invoices.amount` tetap penuh, retur dicatat sebagai baris/jurnal terpisah yang ngurangin outstanding-nya. Detail lengkap di bawah ("Retur Barang").
- **AR Deposit (uang muka/DP)** — customer bayar duluan sebelum invoice ada (misal pesanan custom). **Bukan** `AR Payment` — gak nyentuh Piutang Usaha sama sekali pas diterima, dicatat ke akun liability `Uang Muka Penjualan` dulu, baru direklasifikasi jadi pengurang Piutang Usaha begitu invoice-nya kebentuk (atau jadi Pendapatan Lain-lain kalau order-nya batal & DP-nya hangus). Detail lengkap di bawah ("Uang Muka / DP").
- **AR Bad Debt Write-off (piutang tak tertagih)** — piutang yang **benar-benar** gak akan pernah tertagih (customer menghilang/tutup usaha), diakui sebagai kerugian. Beda dari `cancel_ar_invoice`: transaksinya valid, Pendapatan yang udah diakui **gak dibalik** — cuma piutangnya yang dihapusbukukan lewat beban baru di periode saat ketauan macetnya. Metode **direct write-off** (bukan allowance/provisi) — lihat "Piutang Tak Tertagih" di bawah buat rasional lengkap.
- **AR Return Credit (saldo kredit dari retur)** — retur barang yang kejadian **setelah** invoice-nya udah lunas bikin outstanding jadi negatif (lihat "Retur Barang"). Sisa negatifnya otomatis "dicairkan" jadi saldo resmi milik customer, dicatat ke akun liability `Saldo Kredit Retur Customer`. Lihat "Saldo Kredit dari Retur" di bawah.

## Kenapa payment_term_days aman diubah di tempat (bukan versioned)

`due_date` invoice dihitung dan **disimpan** sekali pas invoice dibuat, bukan formula yang dihitung ulang tiap baca. Jadi kalau `customers.payment_term_days` diubah nanti (misal warung langganan lama dipercaya, dari net-7 jadi net-14), itu cuma ngaruh ke invoice **baru** ke depan — invoice lama yang udah punya `due_date` gak ikut geser. Beda kasus sama `accounts.code/category` yang dikunci setelah dipakai jurnal (`coa-schema.md`) — itu dikunci karena field itu identitas akuntansi yang gak boleh geser retroaktif; `payment_term_days` cuma default kalkulasi, gak ada resiko serupa.

## Kenapa Payment Boleh Cicil Tapi Gak Boleh Overpay

Desain awal modul ini (lihat riwayat di `memory/architecture/data/ar-schema.md`) sengaja mendukung fleksibilitas pembayaran dunia nyata lewat tabel jembatan `ar_payment_allocations` (payment_id, invoice_id, amount): 1 payment bisa nutup banyak invoice sekaligus (bayar gabungan), 1 invoice bisa dilunasi lewat beberapa payment (cicilan), dan kelebihan bayar diserap jadi saldo kredit customer buat dipakai belakangan.

**Keputusan bisnis (migration `0040`) sempat membalikkan semua itu sekaligus**: `ar_payments.invoice_id` jadi kolom langsung unique (1 invoice paling banyak 1 payment), dan `record_ar_payment` `raise exception` keras kalau nominalnya gak persis sama sisa outstanding — gak boleh kurang (cicil) MAUPUN lebih (overpay).

**Koreksi belakangan (2026-08-08, migration `0010_ar_allow_partial_payment.sql`)**: ternyata `0040` kelewat ketat. Maksud aslinya cuma soal **overpay yang jadi saldo ngambang** — customer bayar lebih dari yang ditagih, kelebihannya "nyantol" jadi saldo kredit yang bisa dipakai kapan aja ke invoice mana aja (mekanisme `ar_customer_credits` yang sekarang, itu yang dianggap "seenaknya"). **Cicilan bukan masalahnya** — customer bayar sebagian dari 1 invoice yang sama, tetap taat ke invoice itu, itu praktik dagang yang wajar dan perlu bisa dicatat.

Jadi sekarang: **cicil boleh** (`record_ar_payment` cuma nolak kalau `p_amount > ar_invoice_remaining(p_invoice_id)`), **overpay tetap ditolak keras** (gak dibalikin, `ar_customer_credits` TETAP dicabut permanen), dan **1 payment tetap cuma nutup 1 invoice spesifik** (gak ada bayar gabungan lintas invoice — itu beda dari cicilan, dan gak diminta lagi). `ar_payments.invoice_id` gak unique lagi — 1 invoice sekarang boleh punya banyak baris payment dari waktu ke waktu.

## Constraint Wajib

**1. Invoice & Payment tetap masuk General Ledger lewat jalur yang sama**
Gak ada jalur pencatatan piutang yang bypass `journal_entries`/`journal_lines` — AR cuma "lapisan tambahan" di atas GL, bukan sistem pencatatan paralel. Tiap invoice/payment wajib punya `journal_entry_id` yang nunjuk ke entry yang beneran balance (via RPC yang sama prinsipnya kayak `create_journal_entry`).

**2. Immutability sama kayak Journal Entry**
Invoice/payment gak boleh diedit/dihapus setelah dibuat. Invoice salah = reversing entry (jurnal pembalik) + invoice asli tetap ada di histori, bukan invoice-nya dihapus. Ini konsisten sama constraint #4 di `general-ledger.md`.

**3. Amount payment gak boleh melebihi sisa outstanding invoice**
Boleh kurang (partial/cicilan), gak boleh lebih (overpay) — `record_ar_payment` `raise exception` kalau `p_amount > ar_invoice_remaining(p_invoice_id)` (lihat "Kenapa Payment Boleh Cicil Tapi Gak Boleh Overpay").

**4. `due_date` dihitung sekali pas insert, bukan generated column dinamis**
Beda dari `accounts.normal_balance` (generated always as, dihitung ulang tiap baca) — `due_date` harus **snapshot** nilai `payment_term_days` customer pas invoice dibuat, biar perubahan termin customer gak retroaktif ngubah invoice lama.

**5. Invoice salah input cuma boleh dibatalkan kalau BELUM ada payment masuk**
Koreksi "salah input" pakai reversing entry (constraint #2), tapi ada syarat tambahan: begitu ada `ar_payments` yang nunjuk ke invoice itu, pembatalan via jalur ini **ditolak**. Alasannya: piutang itu udah "kesentuh" transaksi lain — udah ada duit customer beneran masuk, jadi gak bisa dianggap "invoice ini gak pernah terjadi" lagi tanpa mikirin nasib pembayaran yang udah diterima (itu keputusan bisnis terpisah, belum di-scope). Invoice yang berhasil dibatalkan otomatis keluar dari daftar outstanding/aging — statusnya derived dari cek "apakah journal entry-nya punya reversal", bukan kolom manual (konsisten sama prinsip status lunas/sebagian/belum).

## Credit Hold (Tahan Kredit Customer Telat Bayar)

Kalau piutang customer ke perusahaan udah kelewat batas wajar — nominal kegedean atau kelamaan nunggak — sales berhenti kasih termin baru ke customer itu sampai piutang lama beres. Ini tindakan standar level ke-2 dari 4 tindakan penjual ke piutang telat (reminder → **credit hold** → renegosiasi cicilan → write-off).

Dua kondisi independen, **salah satu** kepenuhi langsung trigger hold (OR, bukan AND):

- **Nominal**: total piutang belum lunas customer (semua invoice open, bukan cuma yang overdue) > `customers.credit_limit`. NULL = gak ada batas nominal.
- **Waktu**: ada invoice open yang `due_date`-nya udah lewat lebih dari `customers.overdue_threshold_days` hari. NULL = gak ada batas waktu (customer itu gak pernah kena hold dari sisi ini).

Status hold **gak disimpan** — derived, dihitung ulang tiap kali `create_ar_invoice` dipanggil (query outstanding + cek overdue terlama), sama pola kayak status lunas/sebagian/belum. Kalau kena hold, `create_ar_invoice` nolak keras (invoice baru gak bisa dibuat via jalur AR).

Customer on-hold yang tetap mau dilayani **cash** (bukan termin) gak butuh perubahan apa pun di modul ini — itu jalan sebagai penjualan tunai biasa (Debit Kas, Kredit Pendapatan langsung), gak pernah masuk `ar_invoices` sama sekali karena gak ada piutang yang timbul.

`overdue_threshold_days` default di-prefill sama dengan `payment_term_days` customer itu pas dibuat (di form/UI, bukan hardcode di DB) — supaya tiap customer otomatis punya toleransi masuk akal, tapi tetap bisa diubah manual per customer sesuai profil risikonya.

## Retur Barang (Credit Note)

Customer ngembaliin barang yang udah diinvoice. Ini kejadian bisnis nyata (barang beneran balik ke perusahaan), bukan koreksi "invoice salah dari awal" — makanya gak lewat `cancel_ar_invoice`, tapi RPC terpisah yang bikin jurnal kontra-revenue.

**Akun kontra baru**: `Retur & Potongan Penjualan` (`is_contra = true`, pasangan `Pendapatan Penjualan`, lihat `chart-of-accounts.md`). Dipakai biar "penjualan kotor" (nilai invoice asli) tetap keliatan utuh di histori, terpisah dari "berapa yang balik" — bukan langsung ngurangin `Pendapatan Penjualan`.

**Dua jalur, otomatis terdeteksi dari RPC** (user gak perlu milih):

1. **Financial-only** — invoice yang **gak** punya baris `goods_issues` nunjuk ke dia (dibuat lewat `create_ar_invoice` polos, misal invoice sebelum modul Inventory ada, atau item yang emang gak dilacak stoknya). Retur cuma bikin 1 jurnal:
   ```
   Debit Retur & Potongan Penjualan   [nominal retur]
     Kredit Piutang Usaha                    [nominal retur]
   ```
2. **Full (stok + HPP)** — invoice yang lahir dari `create_goods_issue` (barang jadi yang qty & HPP-nya udah dilacak lewat Weighted Average). Retur bikin **2 jurnal sekaligus**:
   ```
   Debit Retur & Potongan Penjualan   [nominal retur = qty_returned x (invoice.amount / qty_issued)]
     Kredit Piutang Usaha                    [nominal retur]

   Debit Persediaan Barang Jadi       [cost retur = qty_returned x (goods_issue_lines.total_cost / qty_issued)]
     Kredit Harga Pokok Penjualan            [cost retur]
   ```
   Cost retur pakai **harga snapshot asli** dari `goods_issue_lines.total_cost` (harga pas barang itu keluar), bukan hitung ulang harga sekarang — biar konsisten sama biaya yang beneran diakui waktu itu. Barang yang balik masuk nambah `inventory_balances` (Weighted Average) — metode costing satu-satunya di sistem ini sejak FIFO dihapus total (migration `0038`, dulu item FIFO masuk sebagai lot baru terpisah `source_type = SALES_RETURN`, sekarang gak ada lagi segregasi kayak gitu, semua item lewat pool `inventory_balances` yang sama).

**Independen dari status bayar** — retur tetap bisa dibuat baik invoice-nya belum dibayar, sebagian, maupun udah lunas penuh. Kalau invoice udah lunas, retur bikin outstanding jadi **negatif** (saldo kredit customer, perusahaan "berutang" ke customer) — penanganan refund/pemakaian saldo kredit ini **di luar scope** fitur ini, lihat "Belum Termasuk".

**Guard "no over return"** — total retur (akumulasi) terhadap 1 invoice gak boleh ngelebihin `amount` invoice itu (jalur financial-only) atau `qty_issued` baris `goods_issue_lines`-nya (jalur full).

**Batas waktu retur** — sengaja **gak ada** validasi sistem soal umur invoice vs tanggal retur. Sebelumnya sistem ini sempat punya 2 lapis (window per item berdasar sifat fisik barang, window per customer berdasar trade term) yang hard-reject di RPC — dicabut total (migration `0039_ar_remove_return_window.sql`) karena angkanya gak pernah punya dasar/justifikasi yang kuat selain tebakan. Retur diterima/ditolak sekarang murni **keputusan manual** owner/staff di luar sistem — satu-satunya batasan yang tetap otomatis dijaga sistem adalah period closing di bawah.

**Batasan period closing** — retur gak boleh dicatat ke periode yang udah ditutup (`period_closings`). Ini **udah otomatis kepegang** oleh trigger `journal_entries_block_retroactive_into_closed_period` yang di-reuse lewat `create_journal_entry`, gak butuh constraint baru — ini soal integritas pembukuan (gak boleh ubah periode yang udah dikunci), bukan kebijakan toko.

**Bukan penukaran barang** — retur cuma "barang balik", gak otomatis bikin barang pengganti keluar lagi. Penukaran barang pasca-retur (tukar barang rusak dengan barang baru) butuh RPC beda — lihat "Penukaran Barang Pasca-Retur (Garansi)" di bawah.

## Penukaran Barang Pasca-Retur (Garansi)

Customer balikin barang rusak (garansi kualitas) DAN minta barang pengganti — **bukan hadiah/cuma-cuma**, customer memang berhak dapat barang yang layak jual sebagai ganti barang cacat. Bedanya sama retur biasa di atas: retur murni "barang balik, tagihan berkurang lewat diskon"; ini "barang cacat ditukar barang baik" — secara net customer tetap harus bayar penuh nilai barang yang akhirnya dia terima, cuma **gak ada penerbitan piutang/invoice baru** buat barang pengganti itu (piutangnya udah tercakup di invoice/retur yang sudah ada, lihat pembalikan diskon di bawah).

**Kenapa gak lewat `create_goods_issue` biasa** — `create_goods_issue` selalu bikin invoice baru (Debit Piutang Usaha, Kredit Pendapatan). Barang pengganti bukan penjualan baru, jadi kalau dipaksa lewat situ, piutang customer numpuk palsu dan Pendapatan Penjualan kegedean padahal bukan penjualan beneran. Jurnal cost-nya:
```
Debit Harga Pokok Penjualan (HPP)   [cost barang pengganti]
  Kredit Persediaan Barang Jadi            [cost barang pengganti]
```

**Wajib membalikkan diskon retur yang udah diberikan** (fix `0037`, ditemukan lewat `docs/story/accounts-receivable.md` Skenario 6/6b) — retur (`create_ar_credit_note`) udah kasih diskon (Debit Retur & Potongan Penjualan, Kredit Piutang Usaha) buat barang yang sama. Kalau penukaran barang dibiarin nempel di atas diskon itu tanpa dibalik, customer dapat kompensasi **dobel** (diskon DAN barang pengganti) buat 1 kejadian cacat yang sama — perusahaan rugi ekstra. Jadi tiap `create_warranty_replacement` juga bikin jurnal kedua yang membalikkan diskon **secara proporsional** ke qty yang ditukar (bukan seluruh credit note — bisa ditukar bertahap):
```
Debit Piutang Usaha                          [porsi diskon dibalik]
  Kredit Retur & Potongan Penjualan               [porsi diskon dibalik]
```
Porsi dihitung dari rasio cost baris retur asli (`inventory_return_lines.total_cost`) terhadap total cost retur di credit note itu, dikali `ar_credit_notes.amount` — proxy nilai, karena credit note cuma nyimpen 1 `amount` total per retur (gak per baris item). Net-nya: customer yang akhirnya ditukar barangnya bayar penuh (gak dapat diskon lagi) — piutang kami ke customer gak berkurang gara-gara penukaran ini. Total reversal ditegakkan gak boleh ngelebihin diskon aslinya (trigger `warranty_replacements_no_over_reverse`, akumulasi lintas semua penukaran di credit note itu).

**Kalau credit note ini juga punya saldo kredit retur aktif (lihat "Saldo Kredit dari Retur" di bawah) — otomatis ikut diselesaikan pakai barang, bukan cuma diskon yang dibalik.** Ini kasus khusus: invoice udah lunas SEBELUM retur terjadi, jadi diskon retur yang dibalik di atas gak ada lagi Piutang Usaha buat "nampung" — kelebihannya udah kadung dicairkan jadi liability `Saldo Kredit Retur Customer`. Begitu barang pengganti keluar, liability itu ikut disettle sejumlah persis porsi diskon yang dibalik, jurnal ketiga:
```
Debit Saldo Kredit Retur Customer   [porsi disettle]
  Kredit Piutang Usaha                    [porsi disettle]
```
Jurnal ini sengaja pasangan kebalikan dari pembalikan diskon di atas (yang men-debit Piutang Usaha) — net efeknya ke Piutang Usaha invoice itu jadi **nol** (invoice tetap keliatan "lunas", gak muncul jadi berutang lagi), sementara liability-nya berkurang beneran. Disimpan di 2 kolom baru `warranty_replacements.return_credit_settled_amount`/`return_credit_settlement_journal_entry_id` (pola persis `discount_reversed_amount`/`discount_reversal_journal_entry_id` di atas), bukan tabel baru — 1 baris `warranty_replacements` = 1 fakta "penukaran ini nyettle segini". Total settlement (akumulasi lintas semua penukaran di credit note itu) gak boleh ngelebihin saldo kredit retur yang tersisa (trigger `warranty_replacements_no_over_settle_return_credit`).

**Kalau porsi diskon yang mau dibalik ternyata lebih besar dari sisa saldo kredit retur — RPC `raise exception`, bukan diam-diam dipotong.** Ini bisa kejadian kalau sebagian saldo kredit retur itu udah kadung direfund tunai duluan (lihat "Saldo Kredit dari Retur" di bawah) sebelum penukaran barang ini diajukan. Ditolak keras karena kalau dibiarkan lolos dengan porsi yang dipotong diam-diam, sisa reversal yang gak ketampung bakal jadi debit Piutang Usaha yang nambah tanpa invoice manapun yang nyerap — saldo "menggantung" yang bahkan gak bisa dilunasin lewat pembayaran biasa (payment cuma bisa nutup 1 invoice spesifik yang beneran ada, gak ada invoice buat nampung saldo menggantung ini — lihat "Kenapa Payment Boleh Cicil Tapi Gak Boleh Overpay").

**Wajib referensi ke AR Credit Note yang udah ada** (jalur full, retur yang punya `inventory_returns` — bukti barang emang balik ke gudang) — gak bisa berdiri sendiri tanpa retur formal duluan. Alasan bisnis:
- **Audit trail** — tanpa bukti retur, penukaran barang gampang disalahgunakan (klaim "rusak" tanpa bukti barang balik).
- **Traceability** (Core Invariant project ini) — pengeluaran stok buat penukaran harus nunjuk ke dokumen sumber jelas, biar gak disalahartikan kebocoran/pencurian stok.
- **Matching principle** — biaya penukaran itu beban garansi yang berasal dari penjualan yang udah diakui sebelumnya, harus terhubung ke transaksi asalnya.

**Batas kuantitas** — total qty yang ditukar (akumulasi, bisa lebih dari 1 kali penukaran per credit note) gak boleh ngelebihin qty yang beneran diretur di credit note itu (per item) — pola sama no-over-return. Barang pengganti diambil dari stok **fresh** yang aktif (`inventory_balances`, Weighted Average). Sebelum FIFO dihapus (migration `0038`), barang pengganti sengaja **bukan** diambil dari lot `SALES_RETURN` yang baru masuk dari retur (barang rusak yang balik itu gak dijual/dipakai ganti lagi, lot-nya kepisah) — sekarang tabel lot itu sudah gak ada, jadi segregasi itu juga sudah gak ada (barang retur & barang fresh campur di pool yang sama, catatan terbuka soal ini ada di "Belum Termasuk").

## Uang Muka / DP (Deposit)

Customer bayar duluan sebelum ada invoice — biasanya buat pesanan/produk custom made-to-order yang belum dikerjain. Ini beda dari `ar_payment` biasa: `ar_payment` selalu mengasumsikan ada piutang yang mau dilunasin (invoice-nya udah ada), sementara DP diterima **sebelum** piutang itu ada sama sekali.

**Kenapa gak langsung dicatat sebagai pengurang Piutang Usaha** kayak pembayaran biasa: karena piutangnya belum ada. Prinsip pengakuan pendapatan (matching principle) bilang pendapatan diakui pas barang/jasa diserahkan, bukan pas duit diterima — jadi DP itu bukan pendapatan perusahaan, itu **kewajiban** (perusahaan "berutang" barang/jasa atau uang balik ke customer sampai pesanannya jadi). Dicatat ke akun liability baru: **Uang Muka Penjualan**.

**Tiga kejadian, tiga jurnal berbeda:**

1. **DP diterima** — Debit Kas/Bank, Kredit Uang Muka Penjualan. Belum nyentuh Piutang Usaha atau Pendapatan sama sekali.
2. **DP diterapkan ke invoice** (begitu barang jadi & invoice diterbitkan penuh) — Debit Uang Muka Penjualan, Kredit Piutang Usaha. Ini reklasifikasi, bukan pembayaran baru — ngurangin outstanding invoice itu.
3. **DP hangus** (order dibatalin SEBELUM invoice ada, kebijakan non-refundable deposit — umum dipakai kalau ada biaya yang udah kadung dikeluarkan buat penuhin pesanan custom itu) — Debit Uang Muka Penjualan, Kredit **Pendapatan Lain-lain** (BUKAN Pendapatan Penjualan — ini bukan hasil jual roti, jadi harus kepisah biar Laba Rugi gak nyampur "penjualan beneran" sama "DP hangus").

Status 1 deposit (belum dipakai / diterapkan / hangus) **derived**, bukan kolom — sama pola kayak status invoice. Satu deposit cuma boleh punya **satu** disposisi aktif (diterapkan ATAU hangus), ditegakkan trigger.

**Interaksi sama pembatalan invoice**: kalau invoice yang DP-nya udah diterapkan ternyata perlu dibatalin (misal salah input), `cancel_ar_invoice` **ikut membalikkan jurnal DP-application-nya juga** (reversing entry kedua, bukan cuma jurnal invoice-nya doang) — biar DP-nya otomatis balik jadi "belum dipakai" lagi (siap dipakai ulang/dihanguskan), bukan nyangkut jadi piutang minus yang gak jelas asalnya. Tanpa ini, cuma nolak pembatalan (kayak guard yang hard-reject kalau invoice udah ada payment) gak nyelesain apa-apa — orangnya cuma kejebak, DP-nya tetep nyangkut gak jelas statusnya.

*(Catatan: sistem sempat punya mekanisme "Kelebihan Bayar jadi Saldo Kredit Customer" — kalau payment melebihi invoice yang dituju, excess-nya dicairkan jadi saldo `Saldo Kredit Customer` yang bisa dipakai/direfund. Dicabut total lewat migration `0040_ar_payment_strict_invoice_match.sql` — sekarang payment yang gak persis sama sisa outstanding langsung `raise exception`, gak ada lagi jalur buat kelebihan bayar "nyantol".)*

## Piutang Tak Tertagih (Bad Debt Write-off)

Piutang yang udah kelewat batas wajar (credit hold, reminder, dst) tapi tetap gak kunjung dibayar, sampai akhirnya jelas customer-nya gak akan pernah bisa/mau bayar (menghilang, tutup usaha, dsb). Ini level tindakan ke-4 (paling ekstrem) dari 4 tindakan penjual ke piutang telat (reminder → credit hold → renegosiasi cicilan → **write-off**).

**Kenapa bukan `cancel_ar_invoice`**: invoice-nya **benar** dari awal — barang/jasa beneran diserahkan, Pendapatan yang diakui waktu itu **valid dan tetap berdiri**. Membalikkan Pendapatan (lewat reversing entry `cancel_ar_invoice`) akan salah merepresentasikan histori — penjualannya beneran kejadian, yang berubah cuma keyakinan piutangnya bisa dicairkan. Write-off mengakui **kerugian baru** di periode saat ketauan macetnya, bukan mengoreksi periode penjualan yang lama (termasuk kalau periode penjualan itu udah ditutup lewat `close_period` — write-off gak pernah butuh "membuka" jurnal lama, karena `Piutang Usaha` itu akun permanen yang gak ikut di-nol-in periode closing, cuma `Beban`/`Pendapatan` yang di-reset).

**Metode: Direct write-off** (bukan allowance/provisi method), dipilih karena:
- **Gak ada data historis buat estimasi kredibel** — usaha skala kecil/baru biasanya belum punya riwayat write-off yang cukup buat dasar estimasi, jadi persentase cadangan cuma bakal jadi tebakan.
- **Volume & materialitas kecil** — piutang macet sifatnya jarang/satuan (bukan pola berulang skala besar yang butuh diagregat statistik).
- **Sesuai praktik pajak Indonesia** — piutang tak tertagih buat badan usaha umum (bukan lembaga keuangan/bank/leasing) cuma diakui fiskus lewat metode **langsung dihapuskan**, bukan metode cadangan (yang dibatasi ke sektor tertentu oleh aturan Menteri Keuangan).
- **Konsisten sama pola RPC AR lain** — semua reaktif ke 1 kejadian konkret (`cancel_ar_invoice`, credit note, DP), bukan proses estimasi periodik yang gak punya padanan pola di modul ini.

**Akun baru**: `Beban Piutang Tak Tertagih` (kategori expense biasa, **bukan** akun kontra — beda dari `Retur & Potongan Penjualan`/`Akumulasi Penyusutan` yang kontra-aset/kontra-revenue, karena di direct write-off gak ada akun "cadangan" perantara, Piutang Usaha langsung dikurangin).

**Jurnal** (1 kejadian = 1 jurnal, gak ada tahap estimasi terpisah):
```
Debit Beban Piutang Tak Tertagih   [nominal write-off]
  Kredit Piutang Usaha                    [nominal write-off]
```

**Partial-capable** — nominal write-off gak wajib penuh sejumlah outstanding invoice (bisa aja cuma sebagian dianggap macet), tapi gak boleh ngelebihin **sisa outstanding riil** invoice itu (`amount` dikurangi SEMUA reducer lain yang udah ada: payment, retur, DP-application) — beda dari guard retur yang sengaja independen/boleh bikin outstanding negatif, write-off gak masuk akal "menghapus" uang yang udah lunas/diretur/dikreditkan duluan lewat mekanisme lain.

**Interaksi sama mekanisme lain**:
- **Guard reducer lain ikut diperluas** — `ar_deposit_applications` guard-nya ikut ngurangin write-off aktif dari "sisa ruang" invoice, biar gak ada jalur yang over-collect ke invoice yang udah (sebagian) di-write-off. Pola sama persis tiap kali reducer baru ditambah ke AR (lihat riwayat `ar-schema.md` bagian AR Deposit).
- **Credit hold** (`create_ar_invoice`) — outstanding calc ikut ngurangin write-off aktif, biar piutang yang udah dihapusbukukan gak masih keitung sebagai exposure customer itu.
- **`cancel_ar_invoice`** — ditolak kalau invoice udah punya write-off (sama alasan guard payment yang udah ada: piutang ini udah "kesentuh" keputusan bisnis lain, gak bisa dianggap "gak pernah terjadi" lewat jalur salah-input).
- **Period closing** — otomatis kepegang trigger existing (`journal_entries_block_retroactive_into_closed_period`), gak butuh constraint baru. Kalau tanggal write-off jatuh di periode tertutup, dicatat pakai tanggal periode berjalan (sama pola semua RPC lain yang manggil `create_journal_entry`).

**Di luar scope fitur ini — recovery** (piutang yang udah di-write-off ternyata akhirnya kebayar juga). Direct write-off gak punya akun "cadangan" penyangga buat nampung kasus ini dengan mulus (beda dari allowance method) — kalau nanti beneran kejadian di cerita, butuh desain terpisah (kandidat: `Debit Kas / Kredit Pendapatan Lain-lain`, gak reinstate `Piutang Usaha` lagi, biar gak perlu "membuka" balik histori invoice lama).

## Saldo Kredit dari Retur (AR Return Credit)

Retur barang (lihat "Retur Barang" di atas) sengaja **independen** dari status bayar invoice — boleh tetap dibuat walau invoice-nya udah lunas penuh, dan itu bikin outstanding invoice itu jadi **negatif**. Secara bisnis, angka negatif itu artinya: perusahaan sekarang "berutang" ke customer sejumlah itu (customer udah kadung bayar lebih dari yang seharusnya, karena sebagian barangnya cacat).

**Kenapa butuh mekanisme sendiri, bukan cuma dibiarkan sebagai angka minus**: tanpa ini, gak ada cara resmi buat customer mencairkan haknya — gak ada tombol "refund tunai" atau "ganti barang", padahal secara bisnis dia berhak dapat salah satunya. Dicatat ke akun liability terpisah: `Saldo Kredit Retur Customer` — biar riwayatnya tetap bisa ditelusuri balik ke retur mana yang jadi sumbernya, konsisten sama prinsip "beda asal jurnal → beda akun" yang udah dipegang sepanjang modul ini (DP vs Write-off vs Return Credit).

**Kapan ini terjadi**: dideteksi otomatis oleh `create_ar_credit_note` — begitu 1 retur bikin outstanding invoice itu turun di bawah nol, bagian yang "kelebihan" (bukan seluruh nominal retur, cuma porsi yang gak ketampung sisa outstanding yang ada) langsung dicairkan jadi saldo resmi lewat jurnal reklasifikasi:
```
Debit Piutang Usaha              [excess]
  Kredit Saldo Kredit Retur Customer   [excess]
```
Nominal `excess` = nominal retur dikurangi sisa outstanding yang masih ada sebelum retur ini (kalau sisanya udah negatif dari retur sebelumnya, seluruh nominal retur baru ini jadi excess).

**Cuma DUA cara nyelesaiin saldo ini** (keputusan bisnis, migration `0041_ar_return_credit_resolution.sql`) — **TIDAK BOLEH** "dititip"/dipakai motong invoice lain lagi, beda dari desain awal yang sempat ada:
1. **Direfund tunai** — Debit Saldo Kredit Retur Customer / Kredit Kas/Bank (`refund_ar_return_credit`, gak berubah).
2. **Diselesaikan lewat ganti barang** — kalau retur ini nanti diselesaikan pakai `warranty_replacement` (lihat "Penukaran Barang Pasca-Retur (Garansi)" di atas), sebagian/seluruh saldo ini otomatis ikut "terbayar" pakai barang, bukan kas. Ini nutup gap yang sebelumnya ada: dulu `warranty_replacement` berdiri sendiri, gak pernah nyentuh saldo kredit retur — kalau retur diselesaikan lewat barang, saldo ini tetap "kebuka" selamanya padahal customer udah gak berhak nagih apa-apa lagi (laporan piutang jadi salah, keliatan masih berutang padahal udah lunas via barang).

**Kenapa opsi "dipakai motong invoice lain" dicabut**: sama alasan larangan overpay-jadi-saldo-ngambang (lihat "Kenapa Payment Boleh Cicil Tapi Gak Boleh Overpay") — kebijakan ini gak ikut dilonggarkan pas cicilan dibalikin (`0010`), tetap gak mau ada saldo yang "ngambang" bisa dipakai kapan aja ke invoice mana aja.

**Interaksi sama `cancel_ar_invoice`**: saldo kredit retur sendiri **gak** auto-unwind lagi kalau invoice sumbernya dibatalkan (dulu ada logic ini buat "penerapan ke invoice lain" yang sekarang gak ada lagi) — refund/settlement tetap berdiri independen dari status invoice sumbernya.

## Skenario (lihat detail angka lengkap di `docs/story/accounts-receivable.md`)

1. Invoice lunas tepat waktu — kasus paling sederhana, 1 payment nutup 1 invoice penuh sekaligus.
2. Telat bayar — query aging (`due_date < now()` dan belum lunas), read-side doang, gak butuh kolom/job tambahan.
3. Invoice dibatalkan (salah input, belum ada payment) — reversing entry via RPC `cancel_ar_invoice`, bukan hapus, sama kayak koreksi journal entry biasa. Ditolak kalau invoice udah punya payment (constraint #5).
4. Invoice baru ditolak karena credit hold — customer kelampaui `credit_limit` ATAU ada invoice overdue lebih dari `overdue_threshold_days`-nya, `create_ar_invoice` nolak sebelum sempat bikin journal entry.
5. Retur barang, invoice financial-only, belum lunas — outstanding turun langsung dari nominal retur.
6. Retur barang, invoice via goods issue, udah lunas — 2 jurnal (kontra-revenue + reversal HPP), stok masuk lagi, outstanding jadi negatif (saldo kredit).
7. DP diterima lalu diterapkan penuh ke invoice — 3 jurnal terpisah (terima DP, terbitkan invoice, terapkan DP), outstanding invoice berkurang sejumlah DP.
8. DP hangus — order dibatalin sebelum invoice ada, DP jadi Pendapatan Lain-lain, gak ada invoice yang pernah dibuat sama sekali.
9. Invoice yang DP-nya udah diterapkan ternyata dibatalin (salah input) — pembatalan otomatis ikut membalikkan jurnal DP-application, DP balik jadi belum dipakai.
10. Penukaran barang pasca-retur/garansi (jalur full) — 2 jurnal (HPP/Persediaan Barang Jadi + pembalikan diskon retur proporsional ke Piutang Usaha), gak nyentuh Pendapatan, referensi ke credit note yang udah ada.
11. Cicil — 2 payment ke invoice yang sama, masing-masing kurang dari total, invoice tetap "sebagian" sampai baris terakhir nutup sisa outstanding jadi nol.
12. Payment dengan nominal melebihi sisa outstanding ditolak (overpay) — `record_ar_payment` `raise exception` sebelum jurnal apa pun dibuat.
13. Piutang tak tertagih (write-off) — pesanan custom yang customernya menghilang, Debit Beban Piutang Tak Tertagih, Kredit Piutang Usaha, Pendapatan asli gak dibalik.
14. Saldo kredit dari retur, direfund tunai — retur setelah invoice lunas bikin outstanding negatif, excess-nya otomatis dicairkan jadi saldo resmi (Debit Piutang Usaha, Kredit Saldo Kredit Retur Customer), lalu direfund (Debit Saldo Kredit Retur Customer, Kredit Kas).
15. Saldo kredit dari retur, diselesaikan lewat ganti barang — retur yang bikin saldo kredit retur ternyata diselesaikan lewat `warranty_replacement`, bukan refund tunai — jurnal ketiga (Debit Saldo Kredit Retur Customer, Kredit Piutang Usaha) otomatis nyettle sebagian/seluruh saldo, dibatasi sisa saldo yang ada.

## Common Mistakes

- Nyimpen `due_date` sebagai kolom yang dihitung ulang tiap baca dari `payment_term_days` customer saat ini — bikin invoice lama ikut geser kalau termin customer berubah. Harus snapshot pas insert.
- Nyimpen status "lunas/belum" sebagai kolom manual yang harus di-`UPDATE` tiap ada payment — resiko gak sinkron kalau ada bug/lupa update. Harus derived dari `ar_payments`.
- Terima payment dengan nominal lebih (overpay) dari sisa outstanding invoice — `record_ar_payment` harus `raise exception` keras, bukan diterima terus disimpan sebagai "kelebihan" jadi saldo. Kurang dari sisa (cicil) boleh, itu bukan mistake.
- Invoice/payment insert langsung ke tabel AR tanpa lewat RPC yang juga bikin journal entry — piutang tercatat di AR tapi GL gak ke-update, dua sumber angka jadi gak sinkron.
- Batalin invoice yang udah ada payment tanpa mikirin nasib pembayarannya — reversing entry doang bikin GL balance, tapi duit customer yang udah masuk jadi "nyantol" gak jelas. Harus ditolak di level RPC, bukan cuma diingetin di UI.
- Cek credit hold cuma di UI (warning yang bisa di-skip) — harus hard-reject di RPC `create_ar_invoice`, gak boleh bergantung ke frontend buat invariant bisnis ini.
- Nyimpen status "on hold" sebagai kolom manual di `customers` — harus derived tiap invoice baru dicek, biar gak ada resiko status basi (customer udah bayar tapi kolom belum di-update).
- Retur mereduksi `Pendapatan Penjualan` langsung (bukan lewat akun kontra `Retur & Potongan Penjualan`) — bikin nilai "penjualan kotor" asli gak keliatan lagi di histori.
- Retur jalur full pakai harga **sekarang** buat reversal HPP/nilai stok balik (bukan `goods_issue_lines.total_cost` snapshot asli) — bikin nilai stok gak konsisten kalau harga bahan baku/produksi udah berubah sejak barang itu keluar.
- Retur nolak invoice yang udah lunas/ada alokasi — retur harus tetap bisa jalan justru karena beda dari `cancel_ar_invoice`, hasilnya boleh aja bikin saldo kredit.
- Bikin constraint baru buat "gak boleh retur ke periode tertutup" — udah otomatis kepegang trigger period-closing existing, jangan duplikat logic.
- Mengakui DP sebagai Pendapatan (atau langsung ngurangin Piutang Usaha) pas diterima — piutangnya belum ada, dan barang/jasanya belum diserahkan. Harus lewat akun liability `Uang Muka Penjualan` dulu.
- DP hangus dicatat ke `Pendapatan Penjualan` biasa — harus ke `Pendapatan Lain-lain`, biar gak nyampur sama hasil jualan beneran.
- Batalin invoice yang DP-nya udah diterapkan tanpa ikut membalikkan jurnal DP-application-nya — Piutang Usaha customer itu bakal nyasar jadi minus, dan DP-nya nyangkut gak jelas statusnya.
- Penukaran barang lewat `create_goods_issue` biasa (bikin invoice lagi) — piutang & pendapatan numpuk palsu padahal gak ada penjualan baru.
- Penukaran barang tanpa referensi ke credit note yang udah ada — kehilangan audit trail, pengeluaran stok buat penukaran jadi gak bisa dipertanggungjawabkan.
- Barang pengganti diambil dari lot `SALES_RETURN` (barang rusak yang balik dari retur) — harusnya dari stok fresh, barang rusak gak dipakai ganti lagi.
- Write-off lewat `cancel_ar_invoice` (membalikkan Pendapatan) — penjualannya beneran kejadian, gak boleh dianggap "gak pernah ada". Harus RPC terpisah yang cuma ngurangin Piutang Usaha lewat beban baru.
- Write-off ngelebihin sisa outstanding riil invoice (gak ngitung reducer lain kayak payment/retur/DP yang udah ada) — bisa "menghapus" uang yang sebenarnya udah lunas/diretur duluan.
- Pakai allowance/provisi method buat CV skala UMKM tanpa data historis kerugian — estimasinya cuma tebakan, dan gak diakui fiskus buat badan usaha umum di Indonesia.
- Excess dari retur negatif dicatat ke `Saldo Kredit Customer` (akun overpayment) — harus akun terpisah (`Saldo Kredit Retur Customer`), beda asal jurnal.
- Excess dari retur dihitung dari seluruh nominal retur (bukan cuma bagian yang ngelebihin sisa outstanding) — bikin dobel hitung kalau sisa outstanding-nya masih ada sebagian.
- Penukaran barang (`warranty_replacement`) gak nyentuh saldo kredit retur sama sekali walau credit note-nya punya saldo aktif — laporan piutang jadi salah, keliatan masih berutang padahal udah lunas via barang. Wajib otomatis nyettle sejumlah persis porsi diskon yang dibalik.
- Porsi diskon yang dibalik ngelebihin sisa saldo kredit retur (karena sebagian udah direfund tunai duluan) tapi tetap diloloskan dengan settlement yang dipotong diam-diam (`least()`) — sisa reversal yang gak ketampung jadi Piutang Usaha "menggantung" tanpa invoice. Harus `raise exception` fail-fast, bukan dipotong diam-diam.
- Kasih jalan lagi buat saldo kredit retur "dititip"/dipakai motong invoice lain — keputusan bisnis udah eksplisit cuma 2 cara (refund tunai, ganti barang), jangan bikin ulang tabel/RPC alokasi buat itu.

## Belum Termasuk (di luar scope fase ini)

- **Recovery piutang yang udah di-write-off** (lihat "Piutang Tak Tertagih") — direct write-off gak punya akun cadangan penyangga, penanganannya kalau ternyata kebayar lagi belum didesain.
- **Barang rusak yang di-retur masuk lagi sebagai stok bernilai** — penukaran barang pasca-retur masukin barang balik ke inventory seolah layak jual, padahal kalau alasannya rusak harusnya diakui sebagai kerugian (Beban Kerugian Barang Rusak), bukan stok. Detail: `memory/scope-debt/kerugian-barang-rusak.md`.
