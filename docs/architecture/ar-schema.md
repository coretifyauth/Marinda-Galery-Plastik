# Accounts Receivable — Struktur Data

Fase 3. Konsep bisnisnya ada di `docs/domain/accounts-receivable.md`. Skenario nyata: `docs/story/accounts-receivable.md`. Detail teknis: `memory/architecture/data/ar-schema.md`.

## Peta Data (ERD)

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `customers` | Master data pelanggan (nama, kontak, termin pembayaran, batas kredit, toleransi telat) | — |
| `ar_invoices` | Tagihan yang diterbitkan ke pelanggan | `customers`, dan ke transaksi jurnal yang otomatis dibuat |
| `ar_payments` | Pembayaran yang diterima dari pelanggan — selalu menunjuk 1 invoice spesifik (`invoice_id` langsung, bukan tabel jembatan), boleh cicil (1 invoice bisa punya banyak pembayaran), gak boleh kelebihan bayar | `customers`, `ar_invoices` (banyak-ke-satu), dan ke transaksi jurnal yang otomatis dibuat |
| `ar_credit_notes` | Retur barang — kejadian nyata barang balik, bukan koreksi salah input | `ar_invoices` (1 invoice bisa punya banyak retur), dan ke transaksi jurnal kontra-revenue yang otomatis dibuat |
| `inventory_returns` + `inventory_return_lines` | Sisi stok/HPP retur — cuma ada kalau invoicenya lahir dari Goods Issue (barang jadi yang stoknya dilacak) | `ar_credit_notes` (1 pasangan tiap retur fisik), `goods_issues`, dan ke transaksi jurnal reversal HPP |
| `ar_deposits` | Uang muka/DP diterima sebelum invoice ada | `customers`, dan ke transaksi jurnal (Kas → Uang Muka Penjualan) yang otomatis dibuat |
| `ar_deposit_applications` | DP diterapkan ke invoice yang udah diterbitkan | Menghubungkan `ar_deposits` ↔ `ar_invoices`, dan ke transaksi jurnal reklasifikasi |
| `ar_deposit_forfeitures` | DP hangus — order dibatalin sebelum invoice pernah ada | `ar_deposits`, dan ke transaksi jurnal (Uang Muka Penjualan → Pendapatan Lain-lain) |
| `warranty_replacements` + `warranty_replacement_lines` | Penukaran barang pasca-retur/garansi — bukan gratis, tanpa invoice baru, wajib membalikkan diskon retur yang sudah diberikan (proporsional), DAN kalau retur sumbernya punya saldo kredit retur aktif, ikut menyelesaikan saldo itu | `ar_credit_notes` (wajib retur fisik yang sudah ada dulu), `ar_return_credits` (via `ar_credit_notes`, kalau ada), dan ke sampai 3 transaksi jurnal (HPP → Persediaan Barang Jadi, pembalikan diskon, penyelesaian saldo kredit retur) |
| `ar_bad_debt_writeoffs` | Piutang yang benar-benar tidak akan tertagih, dihapusbukukan | `ar_invoices` (1 invoice bisa punya lebih dari satu write-off parsial), dan ke transaksi jurnal (Beban Piutang Tak Tertagih → Piutang Usaha) |
| `ar_return_credits` | Saldo kredit yang lahir otomatis dari retur yang terjadi setelah invoice lunas — cuma bisa diselesaikan refund tunai atau ganti barang, tidak bisa dititip ke invoice lain | `customers`, `ar_credit_notes` (sumbernya), dan ke transaksi jurnal reklasifikasi (Piutang Usaha → Saldo Kredit Retur Customer) |
| `ar_return_credit_refunds` | Saldo kredit retur dikembalikan tunai ke pelanggan | `ar_return_credits`, dan ke transaksi jurnal (Saldo Kredit Retur Customer → Kas) |

Kenapa cukup satu pembayaran nunjuk satu invoice (bukan tabel jembatan banyak-ke-banyak) — kebijakan penagihan tetap gak izinin **bayar gabungan** (1 pembayaran nutup beberapa invoice sekaligus) maupun **kelebihan bayar** (yang jadi saldo bebas dipakai kapan saja). Tapi **cicilan boleh** — 1 invoice sekarang bisa punya banyak baris pembayaran dari waktu ke waktu, `ar_payments.invoice_id` gak lagi unik. Desain sebelumnya sempat mendukung ketiga hal itu lewat tabel jembatan `ar_payment_allocations`, lalu sempat dicabut total (semua tiga sekaligus) — belakangan dikoreksi: yang dianggap masalah cuma kelebihan bayar yang "nyantol", bukan cicilan.

**Struktur `ar_invoices`:**

| Kolom | Isinya | Catatan |
|---|---|---|
| pelanggan | Siapa yang berutang | |
| tanggal invoice, jatuh tempo | Kapan diterbitkan, kapan harus lunas | Jatuh tempo dihitung sekali dari termin pelanggan **saat invoice dibuat**, lalu disimpan permanen — kalau termin pelanggan berubah belakangan, invoice lama tidak ikut berubah |
| jumlah | Nilai tagihan | |
| status (lunas/belum/dibatalkan) | — | **Tidak disimpan**, selalu dihitung ulang dari ada-tidaknya pembayaran yang tercatat buat invoice ini dibanding nilai invoice |

## Aturan Otomatis yang Dijaga Sistem

1. **Pembayaran boleh kurang dari sisa tagihan invoice (cicil), tapi gak boleh lebih.** Sistem menolak keras kalau nominalnya melebihi sisa outstanding (coba kelebihan bayar) — gak ada ruang buat kelebihan yang "nyantol" jadi saldo. Cicilan (bayar sebagian, sisanya belakangan) boleh.
2. **Invoice dan pembayaran tidak pernah bisa diedit atau dihapus** — sama seperti transaksi jurnal biasa (dua lapis pengamanan). Data pelanggan sendiri (nama, kontak, termin) boleh diubah kapan saja karena itu bukan catatan transaksi, cuma master data.
3. **Invoice hanya bisa dibatalkan kalau belum ada pembayaran yang melunasi.** Kalau sudah ada pelunasan, pembatalan lewat jalur biasa ditolak — harus ditangani lewat proses yang lebih hati-hati (di luar cakupan saat ini). **Kalau invoice itu punya uang muka yang sudah diterapkan**, pembatalan tetap diizinkan — sistem otomatis membalik transaksi jurnal uang muka itu juga, bukan cuma jurnal invoice-nya, supaya uang mukanya kembali berstatus "belum dipakai" (lihat "Uang Muka / DP" di bawah).
4. **Setiap invoice dan pembayaran otomatis membuat transaksi jurnal yang sepadan** — tidak mungkin ada invoice tanpa jurnal Piutang/Pendapatan, atau pembayaran tanpa jurnal Kas/Piutang. Ini dijamin karena satu-satunya cara membuat invoice/pembayaran adalah lewat proses gabungan yang disebut di bawah.
5. **Invoice baru ditolak kalau pelanggan kena "credit hold".** Dicek dua hal, cukup salah satu terpenuhi: total piutang belum lunas pelanggan (ditambah invoice baru ini) melebihi batas kreditnya, atau ada piutang lama yang telatnya sudah melebihi toleransi hari yang diizinkan buat pelanggan itu. Kalau batas kredit atau toleransi telatnya tidak diisi (kosong), pelanggan itu tidak pernah kena hold dari sisi itu. Pelanggan yang kena hold tetap bisa dilayani asal bayar tunai langsung — itu dicatat sebagai penjualan tunai biasa, bukan lewat invoice.
6. **Retur tidak boleh melebihi nilai invoice, dan (kalau retur fisik) tidak boleh melebihi qty yang pernah terjual.** Retur boleh dibuat kapan pun terlepas status bayar invoice maupun sudah berapa lama sejak invoice diterbitkan (sengaja tidak ada batas waktu retur — keputusan itu diserahkan ke pemilik/staf di luar sistem) — kalau invoicenya sudah lunas, retur membuat saldo pelanggan jadi negatif, yang otomatis dicairkan jadi saldo kredit (lihat "Saldo Kredit dari Retur" di bawah).
7. **Satu uang muka cuma boleh punya satu nasib akhir** — diterapkan ke invoice, atau dihanguskan. Sistem menolak kalau uang muka yang sudah dihanguskan dicoba diterapkan, atau sebaliknya. Jumlah yang diterapkan juga tidak boleh melebihi sisa uang muka maupun nilai invoice tujuannya.
8. **Penukaran barang wajib nunjuk retur yang sudah ada, dan jumlahnya dibatasi.** Tidak bisa dibuat berdiri sendiri — harus terhubung ke retur fisik yang sudah tercatat. Total yang ditukar tidak boleh melebihi jumlah yang benar-benar diretur untuk item itu.
9. **Write-off tidak boleh melebihi sisa piutang yang benar-benar masih outstanding.** Beda dari retur (yang boleh bikin saldo negatif) — write-off ikut menghitung SEMUA pengurang lain yang sudah ada buat invoice itu (pembayaran, retur, uang muka), supaya tidak "menghapus" uang yang sebenarnya sudah lunas/diretur lewat jalur lain. Invoice yang sudah punya write-off tidak bisa dibatalkan lewat jalur biasa — sama seperti invoice yang sudah ada pembayarannya.
10. **Retur yang membuat saldo invoice jadi negatif otomatis "dicairkan" jadi saldo kredit resmi.** Bagian yang melebihi sisa outstanding (bukan seluruh nilai retur) dicatat sebagai saldo kredit terpisah milik pelanggan itu, ke akun tersendiri (biar riwayatnya tetap bisa ditelusuri balik ke retur yang jadi sumbernya).
11. **Saldo kredit dari retur cuma boleh diselesaikan refund tunai atau ganti barang — tidak bisa dititip ke invoice lain.** Kalau retur yang bikin saldo ini nanti diselesaikan lewat penukaran barang, sistem otomatis menyelesaikan saldo itu sejumlah persis porsi diskon retur yang dibalik di penukaran itu — tidak ada jalur manual "pakai ke invoice lain". Kalau porsi itu ternyata lebih besar dari sisa saldo yang ada (misal sebagian sudah kadung dikembalikan tunai lebih dulu), sistem menolak transaksinya sama sekali, bukan menyelesaikan sebagian lalu membiarkan sisanya menggantung tanpa penjelasan.

## Cara Kerja "Buat Invoice", "Catat Pembayaran", dan "Batalkan Invoice"

- **Buat invoice** — sistem menghitung tanggal jatuh tempo dari termin pelanggan, membuat transaksi jurnal (Debit Piutang Usaha, Kredit Pendapatan), lalu mencatat invoice yang menunjuk ke transaksi jurnal itu — semua sebagai satu langkah gabungan.
- **Catat pembayaran** — pelanggan wajib pilih 1 invoice, dan nominalnya boleh kurang dari sisa tagihan (cicil) tapi gak boleh lebih. Sistem membuat transaksi jurnal (Debit Kas/Bank, Kredit Piutang Usaha) untuk nominal itu dan mencatat pembayarannya langsung menunjuk ke invoice itu — semua dalam satu langkah gabungan, ditolak keras cuma kalau nominalnya melebihi sisa.
- **Batalkan invoice** — sistem memeriksa dulu apakah invoice sudah punya pelunasan; kalau belum, sistem membuat transaksi pembalik (debit/kredit ditukar) memakai akun yang sama persis dengan invoice aslinya. Kalau invoice itu punya uang muka yang sudah diterapkan, transaksi jurnal uang muka itu ikut dibalik juga dalam langkah yang sama. Invoice aslinya sendiri tidak diubah sama sekali — status "dibatalkan" murni dibaca dari keberadaan transaksi pembalik itu.
- **Catat retur barang** — sistem mendeteksi sendiri invoicenya lahir dari Goods Issue (ada stok yang dilacak) atau tidak. Kalau tidak, cukup satu transaksi jurnal (mengurangi piutang lewat akun kontra "Retur & Potongan Penjualan"). Kalau iya, ada dua transaksi jurnal sekaligus — satu buat mengurangi piutang, satu lagi membalik sebagian biaya pokok penjualan yang sudah diakui — plus barangnya dikembalikan ke catatan stok. Invoice aslinya tetap tidak diubah, retur selalu berupa catatan tambahan.
- **Catat penukaran barang pasca-retur/garansi** — hanya bisa dilakukan kalau retur fisiknya sudah ada (barang beneran balik ke gudang). Sistem membuat transaksi jurnal cost (Debit HPP, Kredit Persediaan Barang Jadi) dan mengeluarkan barang pengganti dari stok yang aktif — tidak ada invoice baru, TAPI diskon retur yang sudah diberikan dibalik proporsional (Debit Piutang Usaha, Kredit Retur & Potongan Penjualan) supaya piutang tidak berkurang gara-gara penukaran ini. Jumlah yang ditukar (ditotal, bisa lebih dari satu kali) tidak boleh melebihi jumlah yang benar-benar diretur. **Kalau retur sumbernya punya saldo kredit retur aktif** (invoice-nya udah lunas duluan sebelum retur, lihat "Saldo Kredit dari Retur" di bawah), sistem otomatis membuat transaksi jurnal ketiga yang menyelesaikan saldo itu sejumlah persis porsi diskon yang dibalik (Debit Saldo Kredit Retur Customer, Kredit Piutang Usaha) — menetralkan efek pembalikan diskon ke Piutang Usaha, jadi invoice tetap keliatan lunas. Kalau porsi itu lebih besar dari sisa saldo yang ada, transaksinya ditolak sama sekali.

## Uang Muka / DP

Pelanggan kadang bayar duluan sebelum ada invoice — biasanya buat pesanan custom yang belum dikerjakan (misal kue ulang tahun). Ini beda dari pembayaran biasa: pembayaran biasa selalu melunasi invoice yang sudah ada, sementara uang muka diterima **sebelum** piutangnya ada sama sekali.

Karena piutangnya belum ada dan barang/jasanya belum diserahkan, uang muka **bukan pendapatan** — itu kewajiban (perusahaan "berutang" barang atau uang itu balik ke pelanggan), dicatat ke akun baru "Uang Muka Penjualan" (bukan mengurangi Piutang Usaha, dan bukan menambah Pendapatan).

Tiga kejadian yang bisa terjadi ke satu uang muka:

1. **Diterima** — transaksi jurnal Debit Kas/Bank, Kredit Uang Muka Penjualan. Piutang dan Pendapatan sama sekali belum tersentuh.
2. **Diterapkan ke invoice** — begitu barang/jasanya jadi dan invoice diterbitkan penuh, uang mukanya direklasifikasi: Debit Uang Muka Penjualan, Kredit Piutang Usaha. Ini mengurangi tagihan yang masih harus dibayar pelanggan.
3. **Dihanguskan** — kalau pesanannya dibatalkan **sebelum** invoice pernah dibuat, dan kebijakan tokonya uang muka tidak dikembalikan (karena bahan khusus sudah kadung dibeli): Debit Uang Muka Penjualan, Kredit **Pendapatan Lain-lain** — sengaja bukan akun Pendapatan Penjualan biasa, karena ini bukan hasil jualan, supaya laporan laba rugi tidak bercampur antara "hasil jualan beneran" dan "uang muka hangus".

Status satu uang muka (belum dipakai / diterapkan / hangus) tidak disimpan sebagai kolom — selalu dihitung ulang dari ada-tidaknya catatan "diterapkan" atau "dihangus" yang terkait dengannya, sama seperti status invoice.

*(Catatan: sistem sempat punya mekanisme "Kelebihan Bayar jadi Saldo Kredit Pelanggan" — kalau pembayaran melebihi invoice yang dituju, excess-nya dicairkan jadi saldo yang bisa dipakai/dikembalikan. Dicabut total, TETAP dicabut — sekarang pembayaran yang melebihi sisa tagihan langsung ditolak, gak ada lagi jalur buat kelebihan bayar "nyantol". Cicilan/bayar sebagian beda kasus, itu boleh.)*

## Piutang Tak Tertagih (Write-off)

Kadang piutang pelanggan benar-benar tidak akan pernah tertagih — bukan cuma telat, tapi customer-nya menghilang atau tutup usaha. Ini beda dari pembatalan invoice: penjualannya beneran terjadi dan Pendapatan yang sudah diakui **tidak dibalik** — yang terjadi cuma pengakuan kerugian baru di periode saat ketauan macetnya, lewat akun beban baru "Beban Piutang Tak Tertagih" (bukan akun kontra, langsung mengurangi Piutang Usaha).

Sistem ini pakai metode **langsung dihapuskan** (bukan metode mencadangkan dulu sebagian piutang tiap tutup buku) — cocok buat skala usaha yang piutang macetnya jarang dan tidak ada pola historis buat diestimasi, dan juga satu-satunya metode yang diakui pajak buat badan usaha umum di Indonesia (bukan lembaga keuangan).

Write-off boleh sebagian (tidak wajib menghapus penuh nilai outstanding invoice), tapi jumlahnya dibatasi sisa piutang yang benar-benar masih outstanding (lihat aturan #11 di atas). Invoice yang sudah punya write-off, statusnya jadi "dihapusbukukan" — beda dari "lunas" (piutang ini tidak pernah benar-benar dibayar, cuma diakui hilang).

**Belum termasuk**: kalau piutang yang sudah di-write-off ternyata akhirnya kebayar juga (pemulihan) — metode langsung dihapuskan tidak punya akun cadangan penyangga buat menangani ini dengan mulus, penanganannya belum dirancang.

## Saldo Kredit dari Retur

Retur boleh dibuat kapan pun terlepas status bayar invoice (lihat "Cara Kerja" di atas) — kalau invoicenya sudah lunas, retur membuat saldo invoice itu jadi **negatif**. Secara bisnis, itu artinya perusahaan "berutang" ke pelanggan sejumlah itu.

Sistem sekarang otomatis mendeteksi ini tiap kali retur dicatat: bagian yang melebihi sisa outstanding sebelum retur itu (bukan seluruh nilai returnya) langsung dicatat sebagai saldo kredit terpisah ("Saldo Kredit Retur Customer"), supaya riwayatnya tetap jelas ketelusur balik ke retur mana yang jadi sumbernya.

**Cuma dua cara nyelesaiin saldo ini, boleh sebagian-sebagian dan berkali-kali** — tidak bisa dititip/dipakai motong invoice lain:
1. **Dikembalikan tunai** — lewat aksi "Refund Tunai" di halaman detail saldo kredit retur.
2. **Diselesaikan lewat ganti barang** — kalau retur ini nanti ditindaklanjuti pakai penukaran barang pasca-retur/garansi (lihat "Cara Kerja" di atas), sistem otomatis menyelesaikan saldo bareng penukarannya (sejumlah persis porsi diskon yang dibalik, bisa bertahap kalau penukarannya juga bertahap), tanpa aksi manual terpisah. Kalau porsi yang mau diselesaikan lebih besar dari sisa saldo, penukaran barangnya ditolak.

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat pelanggan, invoice, pembayaran, uang muka | Semua user yang sudah login |
| Menambah pelanggan baru, mengubah data pelanggan | Role `admin` atau `accountant` |
| Membuat invoice, mencatat pembayaran, mencatat/menerapkan/menghanguskan uang muka, mencatat write-off, refund saldo kredit retur, mencatat penukaran barang | Role `admin` atau `accountant` |
| Mengedit atau menghapus invoice/pembayaran/retur/uang muka/write-off/saldo kredit retur | **Tidak ada seorang pun** — hanya pembatalan/retur lewat jalur resmi yang diizinkan |
| Menghapus data pelanggan secara permanen | **Tidak ada seorang pun** — hanya bisa diarsipkan |

## Belum Termasuk

- **Laporan umur piutang (aging) / dashboard invoice jatuh tempo** — ini laporan baca-saja dari data yang sudah ada, akan dibangun bersama tampilan UI-nya, tidak butuh perubahan struktur data.
- **Pemulihan piutang yang sudah di-write-off** — lihat "Piutang Tak Tertagih" di atas, belum dirancang.