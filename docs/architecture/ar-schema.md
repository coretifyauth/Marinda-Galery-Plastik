# Accounts Receivable — Struktur Data

Fase 3. Konsep bisnisnya ada di `docs/domain/accounts-receivable.md`. Skenario nyata: `docs/story/accounts-receivable.md`. Detail teknis: `memory/architecture/data/ar-schema.md`.

## Peta Data (ERD)

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `customers` | Master data pelanggan (nama, kontak, termin pembayaran, batas kredit, toleransi telat) | — |
| `ar_invoices` | Tagihan yang diterbitkan ke pelanggan | `customers`, dan ke transaksi jurnal yang otomatis dibuat |
| `ar_payments` | Pembayaran yang diterima dari pelanggan | `customers`, dan ke transaksi jurnal yang otomatis dibuat |
| `ar_payment_allocations` | Jembatan: "pembayaran X melunasi invoice Y sejumlah Z" | Menghubungkan `ar_payments` ↔ `ar_invoices` |
| `ar_credit_notes` | Retur barang — kejadian nyata barang balik, bukan koreksi salah input | `ar_invoices` (1 invoice bisa punya banyak retur), dan ke transaksi jurnal kontra-revenue yang otomatis dibuat |
| `inventory_returns` + `inventory_return_lines` | Sisi stok/HPP retur — cuma ada kalau invoicenya lahir dari Goods Issue (barang jadi yang stoknya dilacak) | `ar_credit_notes` (1 pasangan tiap retur fisik), `goods_issues`, dan ke transaksi jurnal reversal HPP |
| `ar_deposits` | Uang muka/DP diterima sebelum invoice ada | `customers`, dan ke transaksi jurnal (Kas → Uang Muka Penjualan) yang otomatis dibuat |
| `ar_deposit_applications` | DP diterapkan ke invoice yang udah diterbitkan | Menghubungkan `ar_deposits` ↔ `ar_invoices`, dan ke transaksi jurnal reklasifikasi |
| `ar_deposit_forfeitures` | DP hangus — order dibatalin sebelum invoice pernah ada | `ar_deposits`, dan ke transaksi jurnal (Uang Muka Penjualan → Pendapatan Lain-lain) |
| `warranty_replacements` + `warranty_replacement_lines` | Penggantian barang gratis pasca-retur — barang keluar gratis, tanpa invoice/piutang baru | `ar_credit_notes` (wajib retur fisik yang sudah ada dulu), dan ke transaksi jurnal (HPP → Persediaan Barang Jadi) |
| `ar_customer_credits` | Kelebihan bayar — pelanggan transfer lebih dari yang dialokasikan ke invoice dalam satu pembayaran | `customers`, `ar_payments` (sumbernya), dan ke transaksi jurnal pembayaran yang sama |
| `ar_customer_credit_applications` | Saldo kredit dipakai memotong invoice lain | Menghubungkan `ar_customer_credits` ↔ `ar_invoices`, dan ke transaksi jurnal reklasifikasi |
| `ar_customer_credit_refunds` | Saldo kredit dikembalikan tunai ke pelanggan | `ar_customer_credits`, dan ke transaksi jurnal (Saldo Kredit Customer → Kas) |
| `ar_bad_debt_writeoffs` | Piutang yang benar-benar tidak akan tertagih, dihapusbukukan | `ar_invoices` (1 invoice bisa punya lebih dari satu write-off parsial), dan ke transaksi jurnal (Beban Piutang Tak Tertagih → Piutang Usaha) |

Kenapa perlu tabel jembatan (`ar_payment_allocations`) — bukan cukup satu invoice satu pembayaran: satu pembayaran bisa melunasi beberapa invoice sekaligus (bayar gabungan), dan satu invoice bisa dilunasi lewat beberapa pembayaran (dicicil). Hubungannya banyak-ke-banyak, jadi butuh tabel sendiri yang mencatat tiap pasangan pembayaran-invoice beserta jumlahnya.

**Struktur `ar_invoices`:**

| Kolom | Isinya | Catatan |
|---|---|---|
| pelanggan | Siapa yang berutang | |
| tanggal invoice, jatuh tempo | Kapan diterbitkan, kapan harus lunas | Jatuh tempo dihitung sekali dari termin pelanggan **saat invoice dibuat**, lalu disimpan permanen — kalau termin pelanggan berubah belakangan, invoice lama tidak ikut berubah |
| jumlah | Nilai tagihan | |
| status (lunas/sebagian/belum/dibatalkan) | — | **Tidak disimpan**, selalu dihitung ulang dari total pembayaran yang sudah dialokasikan dibanding nilai invoice |

## Aturan Otomatis yang Dijaga Sistem

1. **Alokasi pembayaran tidak boleh melebihi yang tersedia.** Sistem menolak alokasi yang membuat total pelunasan sebuah invoice melebihi nilai invoice itu, atau yang membuat total penggunaan sebuah pembayaran melebihi jumlah uang yang diterima.
2. **Invoice dan pembayaran tidak pernah bisa diedit atau dihapus** — sama seperti transaksi jurnal biasa (dua lapis pengamanan). Data pelanggan sendiri (nama, kontak, termin) boleh diubah kapan saja karena itu bukan catatan transaksi, cuma master data.
3. **Invoice hanya bisa dibatalkan kalau belum ada pembayaran yang mengalokasikan ke situ.** Kalau sudah ada pelunasan (meski sebagian), pembatalan lewat jalur biasa ditolak — harus ditangani lewat proses yang lebih hati-hati (di luar cakupan saat ini). **Kalau invoice itu punya uang muka atau saldo kredit yang sudah diterapkan**, pembatalan tetap diizinkan — sistem otomatis membalik transaksi jurnal uang muka/saldo kredit itu juga, bukan cuma jurnal invoice-nya, supaya uang muka/saldo kreditnya kembali berstatus "belum dipakai" (lihat "Uang Muka / DP" dan "Kelebihan Bayar" di bawah).
4. **Setiap invoice dan pembayaran otomatis membuat transaksi jurnal yang sepadan** — tidak mungkin ada invoice tanpa jurnal Piutang/Pendapatan, atau pembayaran tanpa jurnal Kas/Piutang. Ini dijamin karena satu-satunya cara membuat invoice/pembayaran adalah lewat proses gabungan yang disebut di bawah.
5. **Invoice baru ditolak kalau pelanggan kena "credit hold".** Dicek dua hal, cukup salah satu terpenuhi: total piutang belum lunas pelanggan (ditambah invoice baru ini) melebihi batas kreditnya, atau ada piutang lama yang telatnya sudah melebihi toleransi hari yang diizinkan buat pelanggan itu. Kalau batas kredit atau toleransi telatnya tidak diisi (kosong), pelanggan itu tidak pernah kena hold dari sisi itu. Pelanggan yang kena hold tetap bisa dilayani asal bayar tunai langsung — itu dicatat sebagai penjualan tunai biasa, bukan lewat invoice.
6. **Retur tidak boleh melebihi nilai invoice, dan (kalau retur fisik) tidak boleh melebihi qty yang pernah terjual maupun batas waktu retur item itu.** Retur boleh dibuat kapan pun terlepas status bayar invoice — kalau invoicenya sudah lunas, retur membuat saldo pelanggan jadi negatif (kelebihan bayar), yang penanganannya di luar cakupan saat ini.
7. **Satu uang muka cuma boleh punya satu nasib akhir** — diterapkan ke invoice, atau dihanguskan. Sistem menolak kalau uang muka yang sudah dihanguskan dicoba diterapkan, atau sebaliknya. Jumlah yang diterapkan juga tidak boleh melebihi sisa uang muka maupun nilai invoice tujuannya.
8. **Penggantian barang gratis wajib nunjuk retur yang sudah ada, dan jumlahnya dibatasi.** Tidak bisa dibuat berdiri sendiri — harus terhubung ke retur fisik yang sudah tercatat. Total yang diganti tidak boleh melebihi jumlah yang benar-benar diretur untuk item itu.
9. **Kelebihan bayar otomatis jadi saldo kredit, dalam pembayaran yang sama.** Kalau nominal yang dibayar melebihi total yang dialokasikan ke invoice, selisihnya langsung tercatat sebagai saldo kredit pelanggan — bukan pembayaran terpisah, tapi bagian dari transaksi jurnal pembayaran itu juga (satu bukti transfer, satu transaksi).
10. **Saldo kredit boleh dipakai atau dikembalikan sebagian-sebagian, berkali-kali** — beda dari uang muka yang cuma boleh punya satu nasib akhir. Total yang dipakai + dikembalikan tidak boleh melebihi nominal saldo kredit awalnya, dan pemakaiannya ikut dihitung bareng alokasi pembayaran + penerapan uang muka supaya satu invoice tidak bisa "kelunasan" dari gabungan tiga jalur itu.
11. **Write-off tidak boleh melebihi sisa piutang yang benar-benar masih outstanding.** Beda dari retur (yang boleh bikin saldo negatif) — write-off ikut menghitung SEMUA pengurang lain yang sudah ada buat invoice itu (pembayaran, retur, uang muka, saldo kredit), supaya tidak "menghapus" uang yang sebenarnya sudah lunas/diretur/dikreditkan lewat jalur lain. Invoice yang sudah punya write-off tidak bisa dibatalkan lewat jalur biasa — sama seperti invoice yang sudah ada pembayarannya.

## Cara Kerja "Buat Invoice", "Catat Pembayaran", dan "Batalkan Invoice"

- **Buat invoice** — sistem menghitung tanggal jatuh tempo dari termin pelanggan, membuat transaksi jurnal (Debit Piutang Usaha, Kredit Pendapatan), lalu mencatat invoice yang menunjuk ke transaksi jurnal itu — semua sebagai satu langkah gabungan.
- **Catat pembayaran** — sistem membuat transaksi jurnal (Debit Kas/Bank, Kredit Piutang Usaha) untuk total yang dibayar, mencatat pembayarannya, lalu mengalokasikan jumlah itu ke satu atau beberapa invoice sekaligus (bisa bayar gabungan atau cicilan) — semua dalam satu langkah gabungan.
- **Batalkan invoice** — sistem memeriksa dulu apakah invoice sudah punya pelunasan; kalau belum, sistem membuat transaksi pembalik (debit/kredit ditukar) memakai akun yang sama persis dengan invoice aslinya. Kalau invoice itu punya uang muka yang sudah diterapkan, transaksi jurnal uang muka itu ikut dibalik juga dalam langkah yang sama. Invoice aslinya sendiri tidak diubah sama sekali — status "dibatalkan" murni dibaca dari keberadaan transaksi pembalik itu.
- **Catat retur barang** — sistem mendeteksi sendiri invoicenya lahir dari Goods Issue (ada stok yang dilacak) atau tidak. Kalau tidak, cukup satu transaksi jurnal (mengurangi piutang lewat akun kontra "Retur & Potongan Penjualan"). Kalau iya, ada dua transaksi jurnal sekaligus — satu buat mengurangi piutang, satu lagi membalik sebagian biaya pokok penjualan yang sudah diakui — plus barangnya dikembalikan ke catatan stok. Invoice aslinya tetap tidak diubah, retur selalu berupa catatan tambahan.
- **Catat penggantian barang gratis** — hanya bisa dilakukan kalau retur fisiknya sudah ada (barang beneran balik ke gudang). Sistem membuat satu transaksi jurnal (Debit HPP, Kredit Persediaan Barang Jadi) dan mengeluarkan barang pengganti dari stok yang aktif — tidak ada invoice atau piutang baru sama sekali. Jumlah yang diganti (ditotal, bisa lebih dari satu kali) tidak boleh melebihi jumlah yang benar-benar diretur.

## Uang Muka / DP

Pelanggan kadang bayar duluan sebelum ada invoice — biasanya buat pesanan custom yang belum dikerjakan (misal kue ulang tahun). Ini beda dari pembayaran biasa: pembayaran biasa selalu melunasi invoice yang sudah ada, sementara uang muka diterima **sebelum** piutangnya ada sama sekali.

Karena piutangnya belum ada dan barang/jasanya belum diserahkan, uang muka **bukan pendapatan** — itu kewajiban (CV Barokah "berutang" barang atau uang itu balik ke pelanggan), dicatat ke akun baru "Uang Muka Penjualan" (bukan mengurangi Piutang Usaha, dan bukan menambah Pendapatan).

Tiga kejadian yang bisa terjadi ke satu uang muka:

1. **Diterima** — transaksi jurnal Debit Kas/Bank, Kredit Uang Muka Penjualan. Piutang dan Pendapatan sama sekali belum tersentuh.
2. **Diterapkan ke invoice** — begitu barang/jasanya jadi dan invoice diterbitkan penuh, uang mukanya direklasifikasi: Debit Uang Muka Penjualan, Kredit Piutang Usaha. Ini mengurangi tagihan yang masih harus dibayar pelanggan.
3. **Dihanguskan** — kalau pesanannya dibatalkan **sebelum** invoice pernah dibuat, dan kebijakan tokonya uang muka tidak dikembalikan (karena bahan khusus sudah kadung dibeli): Debit Uang Muka Penjualan, Kredit **Pendapatan Lain-lain** — sengaja bukan akun Pendapatan Penjualan biasa, karena ini bukan hasil jualan, supaya laporan laba rugi tidak bercampur antara "hasil jualan beneran" dan "uang muka hangus".

Status satu uang muka (belum dipakai / diterapkan / hangus) tidak disimpan sebagai kolom — selalu dihitung ulang dari ada-tidaknya catatan "diterapkan" atau "dihangus" yang terkait dengannya, sama seperti status invoice.

## Kelebihan Bayar (Saldo Kredit Pelanggan)

Pelanggan kadang transfer lebih besar dari yang seharusnya untuk melunasi invoice (salah nominal, pembulatan). Beda dari uang muka: piutangnya **sudah ada** dan **sudah dilunasi** (invoice yang dituju tetap tertutup penuh lewat alokasi normal) — sisa lebihnya yang tidak punya invoice untuk "nempel".

Kelebihan ini tercatat **dalam pembayaran yang sama** (satu bukti transfer bank = satu transaksi jurnal), bukan pembayaran kedua yang terpisah — transaksi jurnalnya jadi tiga baris: Debit Kas/Bank (total transfer), Kredit Piutang Usaha (porsi yang melunasi invoice), Kredit Saldo Kredit Customer (sisanya).

Dua cara saldo kredit ini "dihabiskan", boleh sebagian-sebagian dan berkali-kali:

1. **Dipakai memotong invoice lain** (kapan pun ke depannya, tidak harus invoice berikutnya langsung) — Debit Saldo Kredit Customer, Kredit Piutang Usaha.
2. **Dikembalikan tunai** (pelanggan minta balik, bukan dipakai) — Debit Saldo Kredit Customer, Kredit Kas/Bank.

Sisa saldo kredit tidak disimpan sebagai kolom — dihitung dari nominal awal dikurangi total yang sudah dipakai dan dikembalikan, sama pola dengan status invoice/uang muka.

Kalau invoice yang sudah dipotong saldo kredit ternyata dibatalkan (aturan #3 di atas), transaksi jurnal pemakaian saldo kreditnya ikut dibalik otomatis — saldo kreditnya kembali tersedia buat dipakai/dikembalikan lagi, bukan hilang percuma.

## Piutang Tak Tertagih (Write-off)

Kadang piutang pelanggan benar-benar tidak akan pernah tertagih — bukan cuma telat, tapi customer-nya menghilang atau tutup usaha. Ini beda dari pembatalan invoice: penjualannya beneran terjadi dan Pendapatan yang sudah diakui **tidak dibalik** — yang terjadi cuma pengakuan kerugian baru di periode saat ketauan macetnya, lewat akun beban baru "Beban Piutang Tak Tertagih" (bukan akun kontra, langsung mengurangi Piutang Usaha).

Sistem ini pakai metode **langsung dihapuskan** (bukan metode mencadangkan dulu sebagian piutang tiap tutup buku) — cocok buat skala usaha yang piutang macetnya jarang dan tidak ada pola historis buat diestimasi, dan juga satu-satunya metode yang diakui pajak buat badan usaha umum di Indonesia (bukan lembaga keuangan).

Write-off boleh sebagian (tidak wajib menghapus penuh nilai outstanding invoice), tapi jumlahnya dibatasi sisa piutang yang benar-benar masih outstanding (lihat aturan #11 di atas). Invoice yang sudah punya write-off, statusnya jadi "dihapusbukukan" — beda dari "lunas" (piutang ini tidak pernah benar-benar dibayar, cuma diakui hilang).

**Belum termasuk**: kalau piutang yang sudah di-write-off ternyata akhirnya kebayar juga (pemulihan) — metode langsung dihapuskan tidak punya akun cadangan penyangga buat menangani ini dengan mulus, penanganannya belum dirancang.

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat pelanggan, invoice, pembayaran, uang muka | Semua user yang sudah login |
| Menambah pelanggan baru, mengubah data pelanggan | Role `admin` atau `accountant` |
| Membuat invoice, mencatat pembayaran, mencatat/menerapkan/menghanguskan uang muka, mencatat write-off | Role `admin` atau `accountant` |
| Mengedit atau menghapus invoice/pembayaran/retur/uang muka/write-off | **Tidak ada seorang pun** — hanya pembatalan/retur lewat jalur resmi yang diizinkan |
| Menghapus data pelanggan secara permanen | **Tidak ada seorang pun** — hanya bisa diarsipkan |

## Belum Termasuk

- **Retur yang membuat saldo invoice negatif** — beda mekanisme dari kelebihan bayar pembayaran (yang sudah di atas): retur mengurangi nilai invoice lewat akun kontra-pendapatan, bukan lewat kelebihan kas pembayaran. Penanganan saldo kreditnya masih belum dirancang.
- **Laporan umur piutang (aging) / dashboard invoice jatuh tempo** — ini laporan baca-saja dari data yang sudah ada, akan dibangun bersama tampilan UI-nya, tidak butuh perubahan struktur data.
- **Pemulihan piutang yang sudah di-write-off** — lihat "Piutang Tak Tertagih" di atas, belum dirancang.
