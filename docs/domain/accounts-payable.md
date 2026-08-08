# Accounts Payable — Bayar Utang ke Supplier

## Masalah yang diselesaikan

Fase 2 (`general-ledger.md`) udah bisa nyatet utang timbul (Kredit Utang Usaha) pas beli bahan baku belum bayar — entry 10 Juli, beli tepung & gula Rp800.000. Tapi sama kayak sebelum AR ada, itu baru "kejadiannya kecatet" — belum ada mekanisme buat tau **siapa** supplier-nya, **kapan jatuh tempo**, dan **udah dibayar berapa**. AP (Accounts Payable) nutup gap ini dari sisi kebalikan AR: sekarang **CV Barokah** yang berutang, bukan yang piutang.

## Kenapa Beda dari AR (bukan cuma tukar arah)

Struktur tabelnya mirror persis AR (`docs/domain/accounts-receivable.md`), tapi ada 1 perbedaan konteks bisnis yang penting:

- **Di AR**, CV Barokah yang nentuin `payment_term_days` buat customer (Bu Nur ngasih syarat termin ke warung langganan).
- **Di AP**, kebalikannya — **supplier** yang nentuin termin, CV Barokah cuma nerima syarat itu. `payment_term_days` di tabel `suppliers` maknanya "syarat yang diterima dari supplier", bukan "syarat yang kita tetapkan sendiri".

Bedanya cuma di makna bisnis, bukan di struktur data — kolomnya tetap sama.

## Konsep Inti

- **Supplier** — master data, pihak yang CV Barokah berutang ke dia (2 supplier bahan baku langganan). Punya `payment_term_days` (syarat dari supplier, bukan kita yang nentuin) yang dipakai ngitung jatuh tempo tiap bill baru. Bukan data transaksional — kalau terminnya berubah (misal supplier naikin kepercayaan jadi termin lebih panjang), di-`UPDATE` di baris yang sama, gak bikin row baru (sama alasan `customers` di AR).
- **AP Bill** — utang timbul. 1 kejadian "ambil barang, belum bayar" = 1 bill. Tiap bill bikin 1 journal entry: **Debit Persediaan/Beban (tergantung jenis pembelian), Kredit Utang Usaha**. `due_date` dihitung otomatis (`bill_date + payment_term_days` supplier itu) **pas bill dibuat**, disimpan permanen.
- **AP Payment** — utang berkurang, kejadian bayar beneran ke supplier (bukan jadwal). Selalu nutup **1 bill spesifik** (gak ada gabung ke bill lain), boleh **cicil** (kurang dari sisa outstanding, 1 bill boleh punya banyak baris payment dari waktu ke waktu), tapi gak boleh **overpay**. 1 payment bikin 1 journal entry: **Debit Utang Usaha, Kredit Kas/Bank**, sejumlah yang beneran dibayar. Sempat ada tabel jembatan `ap_payment_allocations` (many-to-many, ngizinin 1 payment nutup beberapa bill sekaligus) — dicabut migration `0011_ap_payment_single_bill.sql` demi selaras filosofi AR pasca-`0010`: payment taat ke 1 obligasi spesifik.
- **Status bill** (lunas/sebagian/belum/dibatalkan) — derived dari `SUM(ap_payments.amount)` dibanding `bill.amount`, ditambah cek reversal journal entry buat status "dibatalkan". Bukan kolom manual, pola sama persis AR.

## Retur Barang ke Supplier

Kebalikan AR Credit Note (`docs/domain/accounts-receivable.md` bagian "Retur Barang") — bahan baku yang diterima dari supplier ternyata rusak (misal tepung apek, gula basah kena air), dan Barokah mau kembalikan. Bedanya dari `cancel_ap_bill`: bill-nya **valid**, transaksinya beneran kejadian, cuma **sebagian barangnya** dikembalikan belakangan — bisa kejadian kapan pun, baik bill belum dibayar, sebagian, atau udah lunas penuh.

Begitu barang rusak ketauan, ada **2 resolusi** yang bisa disepakati sama supplier — pilihan manual orang yang input transaksi (sama pola milih akun debit Persediaan vs Beban di `create_ap_bill`, keputusan bisnis manusia, bukan hasil deteksi sistem), **bukan konsekuensi otomatis dari status bayar bill**:

- **Opsi A — Kurangi Utang** (retur beneran ngurangin Utang Usaha)
  - **Bill belum lunas/sebagian**: Debit Utang Usaha / Kredit Persediaan Bahan Baku — utang beneran berkurang. Contoh: bill Rp1.200.000 belum dibayar, retur Rp180.000 → sisa utang jadi Rp1.020.000.
  - **Bill udah lunas penuh** (atau retur ngelebihin sisa outstanding): jurnal yang sama tetap jalan dulu (bikin outstanding minus) → excess-nya **otomatis** direklasifikasi jadi saldo baru **Piutang Retur Supplier** (akun asset baru) — mirror `ar_return_credits` di AR, tapi arah aset kebalik (di AR itu liability kita ke customer; di sini asset kita ke supplier, karena supplier yang "berutang" balik ke kita). Saldo ini partial-capable, **dicairkan tunai** (Debit Kas/Bank / Kredit Piutang Retur Supplier) — sempat juga bisa "dipakai motong bill lain" ke supplier yang sama, dicabut (2026-08-08) karena bukan fondasi AP, gak ada bukti kebutuhan bisnis konkret.
  - **Kenapa gak butuh akun kontra** (beda dari AR yang pakai kontra-revenue "Retur & Potongan Penjualan"): sisi debit bill (Persediaan Bahan Baku) itu akun **neraca** (asset), bukan akun laporan laba-rugi kayak Pendapatan — retur boleh langsung mengurangi Persediaan tanpa lewat akun perantara.
- **Opsi B — Tukar Barang** (supplier kirim barang pengganti, bukan kurangin utang)
  - **Berdiri sendiri, gak lewat retur Opsi A sama sekali** — beda dari AR (`warranty_replacement` di AR itu WAJIB nunjuk credit note yang udah dibuat duluan, jadi tambahan DI ATAS retur; kalau AP niru pola itu tanpa penyeimbang, supplier jadi ngasih 2 kompensasi sekaligus — kurangi utang DAN kirim barang pengganti tanpa nagih balik — buat 1 kejadian rusak yang sama, gak masuk akal secara bisnis. AR sendiri sempat kena bug ini, sekarang sudah diperbaiki lewat pembalikan diskon proporsional di `warranty_replacement`, migration `0037`).
  - **Berlaku sama persis di semua status bayar** — Utang Usaha **gak pernah kesentuh**, mau bill-nya lunas, sebagian, atau belum dibayar sama sekali.
  - Jurnal: Debit Persediaan Bahan Baku (barang baru masuk) / Kredit Persediaan Bahan Baku (barang rusak keluar) — **net nol**, murni reklasifikasi fisik (barang keluar-masuk dicatat biar jejak audit per-kejadian lengkap), **tanpa** baris Beban — karena Barokah gak kehilangan nilai apa pun (dapat gantinya senilai sama).
  - **Beda dari barang rusak yang GAK dapat kompensasi sama sekali** (supplier nolak ganti maupun kurangi utang) — itu bukan retur, itu kerugian murni yang ditanggung Barokah sendiri (Beban Kerugian Barang Rusak), kasus terpisah di luar scope fitur ini (lihat "Belum Termasuk").

**Catatan implementasi**: fitur ini nanganin item dengan metode costing **Weighted Average** — satu-satunya metode yang ada, FIFO sudah dihapus total dari sistem (migration `0038_remove_fifo_costing.sql`). Nilai barang yang diretur/ditukar dihitung dari harga rata-rata (`avg_cost`) **saat retur terjadi**, bukan harga asal pas barang diterima — konsisten dengan cara Weighted Average bekerja di modul Inventory (gak nyimpen asal-usul per batch).

## Uang Muka / DP ke Supplier (migration `0013_ap_deposits_schema.sql`)

CV Barokah kadang harus bayar duluan ke supplier **sebelum** ada bill — supplier baru yang belum kasih kepercayaan termin, atau bahan baku custom/pesanan besar yang mensyaratkan DP dulu. Mirror `AR Deposit` (`docs/domain/accounts-receivable.md` bagian "Uang Muka / DP"), tapi arahnya **kebalik**: di AR, DP yang **diterima** dari customer itu **liability** (kita berutang barang ke mereka); di AP, DP yang **dibayar** ke supplier itu **asset** (`Uang Muka Pembelian`, akun baru) — supplier yang berutang barang/uang balik ke kita.

**Kenapa gak langsung dicatat sebagai Beban atau pengurang Utang Usaha**: matching principle — barangnya belum diterima, belum ada manfaat yang diakui. DP itu klaim ke supplier, bukan biaya yang udah terjadi, dan belum ada bill/utang yang timbul di titik itu.

**Empat kejadian, empat jurnal berbeda** (semuanya partial-capable dari awal, dijaga fungsi terpusat `ap_deposit_remaining(deposit_id) = amount − SUM(applications) − SUM(refunds) − SUM(forfeitures)`, sama pola `ar_deposit_remaining()` pasca-`0012`):

1. **DP dibayar** — Debit Uang Muka Pembelian / Kredit Kas/Bank. Belum nyentuh Utang Usaha sama sekali — belum ada bill.
2. **DP diterapkan ke bill** (begitu barang datang & bill diterbitkan) — Debit Utang Usaha / Kredit Uang Muka Pembelian. Reklasifikasi, ngurangin outstanding bill itu.
3. **DP direfund tunai** (order dibatalin, supplier mau balikin uangnya) — Debit Kas/Bank / Kredit Uang Muka Pembelian. **Gak ada dampak Laba Rugi** — murni aset balik jadi kas.
4. **DP hangus** (order dibatalin, supplier gak mau/gak bisa balikin) — Debit **Beban Kerugian Uang Muka** (akun baru) / Kredit Uang Muka Pembelian. **Ada dampak Laba Rugi** — kita beneran rugi sejumlah itu.

**Beda mendasar dari AR Deposit soal siapa nentuin kebijakan refund**: di AR, DP dari customer defaultnya **gak direfund** (kebijakan yang KITA tetapkan ke customer kita — makanya `ar_deposit_refunds` gak ada sampai `0012`, cuma forfeiture). Di AP, refund-tidaknya DP kita ke supplier itu **supplier** yang nentuin, bukan kita — makanya sejak awal AP butuh 2 jalur (refund DAN forfeiture), gak cuma 1. Ini juga alasan kenapa `ap_deposit_refunds` dibangun bareng `ap_deposit_forfeitures` dari awal (bukan ditambah belakangan kayak `ar_deposit_refunds`).

**Dampak ke `ap_bills`**: `ap_bill_remaining()` nambah reducer ke-3 (`ap_deposit_applications`), mirror `ar_invoice_remaining()`. `cancel_ap_bill` nambah auto-unwind `ap_deposit_applications` aktif kalau bill yang DP-nya udah diterapkan dibatalin, mirror `cancel_ar_invoice`.

**Akun baru**: `Uang Muka Pembelian` (asset) dan `Beban Kerugian Uang Muka` (expense) — di-insert di migration seed, pola sama semua akun baru lain.

## Constraint Wajib

**1. Bill & Payment tetap masuk General Ledger lewat jalur yang sama**
Gak ada jalur pencatatan utang yang bypass `journal_entries`/`journal_lines`. Tiap bill/payment wajib punya `journal_entry_id` yang dibuat via RPC yang manggil `create_journal_entry`, bukan insert manual.

**2. Immutability sama kayak Journal Entry & AR**
Bill/payment gak boleh diedit/dihapus. Koreksi = reversing entry.

**3. Payment gak boleh melebihi sisa outstanding bill**
Boleh kurang (cicil), gak boleh lebih (overpay) — sama constraint di AR pasca-`0010`.

**4. `due_date` dihitung sekali pas insert, snapshot dari `payment_term_days` supplier**
Perubahan termin supplier ke depan gak boleh retroaktif ngubah `due_date` bill lama.

**5. Bill salah input cuma boleh dibatalkan kalau BELUM ada payment/alokasi masuk**
Sama guard yang dipakai di AR (`cancel_ar_invoice`) — begitu ada 1 alokasi aja, pembatalan ditolak. Beda dari AR, di AP aturan ini **langsung diterapkan dari awal** (bukan ditambah belakangan), karena udah kebukti perlu dari pengalaman desain AR.

**6. No over-return — gabungan Opsi A + Opsi B**
Total qty yang diklaim retur (Opsi A) **plus** total qty yang ditukar (Opsi B) buat 1 item di 1 bill yang sama, gak boleh ngelebihin qty yang beneran diterima di bill itu. Ini guard baru (gabungan 2 mekanisme sekaligus, bukan cuma 1) — item Weighted Average butuh pengecekan eksplisit karena stoknya udah nyampur, gak ada cara nelusurin balik "qty ini asalnya dari bill mana" (beda dari zaman FIFO masih ada, yang otomatis kejaga lewat batas per-lot).

**7. No over-use Piutang Retur Supplier**
Total saldo yang dicairkan tunai gak boleh ngelebihin nominal awal saldo itu.

**8. No over-use Uang Muka Pembelian (DP ke supplier)**
Total dari 3 jalur (diterapkan ke bill + refund + hangus) gak boleh ngelebihin nominal DP awal — dijaga `ap_deposit_remaining()`, partial-capable dari awal.

## Skenario (lihat detail angka lengkap di `docs/story/accounts-payable.md`)

1. Bill lunas tepat waktu — 1 payment nutup 1 bill penuh sekaligus, pola identik AR skenario 1.
2. Bayar sebagian (cicil) — 2+ payment ke bill yang sama, masing-masing kurang dari sisa, pola identik AR skenario 11 (`0010`/`0011`).
3. Payment ditolak — overpay, atau coba nutup lebih dari 1 bill dalam 1 transaksi — `record_ap_payment` cuma nerima 1 `p_bill_id`, gak ada lagi jalur "bayar gabungan" (dicabut migration `0011_ap_payment_single_bill.sql`, sebelumnya via tabel jembatan `ap_payment_allocations`).
4. Telat bayar — **beda arah dari AR**. Di AR, yang nanggung resiko telat itu kita (piutang macet, harus nagih). Di AP, kalau **CV Barokah** yang telat bayar, resikonya: supplier bisa setop kirim bahan baku berikutnya. Aging query (`due_date < now()` belum lunas) tetap sama, tapi maknanya "bill mana yang HARUS kita bayar duluan", bukan "piutang mana yang harus ditagih".
5. Bill dibatalkan (salah input, belum ada payment) — reversing entry via RPC `cancel_ap_bill`, sama pola AR skenario 5.
6. Retur (Opsi A — kurangi utang), bill belum lunas — utang beneran berkurang, lihat "Retur Barang ke Supplier".
7. Retur (Opsi A), bill udah lunas — outstanding jadi minus, otomatis jadi Piutang Retur Supplier.
8. Retur (Opsi B — tukar barang) — berdiri sendiri, Utang Usaha gak kesentuh, independen dari status bayar.
9. Piutang Retur Supplier dicairkan tunai.
10. DP dibayar lalu diterapkan penuh ke bill — 2 jurnal terpisah (bayar DP, terapkan ke bill), outstanding bill berkurang sejumlah DP.
11. DP dibatalkan, direfund tunai penuh — supplier mau balikin, gak ada dampak Laba Rugi.
12. DP dibatalkan, hangus penuh — supplier gak mau balikin, jadi Beban Kerugian Uang Muka.
13. DP diselesaikan campuran — sebagian diterapkan ke bill, sebagian direfund, sisanya hangus (3 jurnal terpisah, partial-capable).

## Common Mistakes

- Sama semua common mistake di AR (`accounts-receivable.md`), cuma arah kebalik: due_date dihitung ulang dinamis (harusnya snapshot), status disimpan manual (harusnya derived), insert AP tanpa lewat RPC yang juga bikin journal entry, payment ngelebihin sisa outstanding bill (overpay — kurang/cicil boleh, itu bukan mistake), batalin bill yang udah ada payment tanpa guard.
- **Khusus AP**: salah pilih akun debit pas bikin bill — bahan baku (Persediaan, asset) vs jasa/sewa/utility (Beban, expense langsung). RPC `create_ap_bill` terima akun debit sebagai parameter (gak di-hardcode), jadi kesalahan pilih akun itu tanggung jawab yang input, bukan dicegah sistem — sama pola `create_ar_invoice`/`create_journal_entry` yang emang generik.
- **Retur**: Opsi A dan Opsi B dianggap bisa jalan bareng buat 1 kejadian retur yang sama — itu kompensasi ganda dari sisi supplier, cuma boleh pilih salah satu.
- **Retur**: excess dari Opsi A (bill udah lunas) dianggap otomatis berarti barang harus diganti (Opsi B) — dua-duanya independen, resolusi yang dipilih adalah keputusan bisnis, bukan konsekuensi status bayar.
- **Retur**: barang rusak yang gak dapat kompensasi sama sekali (supplier nolak) dicatat lewat jalur retur — itu kasus terpisah (kerugian/write-off), lihat "Belum Termasuk".
- **DP**: refund DP dicatat lewat jalur forfeiture (atau sebaliknya) — dua-duanya beda dampak Laba Rugi (refund netral, forfeiture jadi Beban), harus lewat tabel yang tepat.
- **DP**: DP yang udah diterapkan ke bill dianggap masih bisa direfund/dihanguskan sejumlah penuh — `ap_deposit_remaining()` udah ngurangin bagian yang kepake, cuma sisanya yang bisa diselesaikan lewat refund/hangus.

## Belum Termasuk (di luar scope fase ini)

Detail lengkap tiap item ada di `memory/scope-debt/`:

- **Bill kepisah kategori (compound debit)** — `memory/scope-debt/ap-bill-compound.md`. Nota supplier yang isinya campuran (misal barang + ongkos kirim) butuh RPC yang nerima array baris debit, bukan 1 akun tetap.
- **Kerugian barang rusak tanpa kompensasi supplier** — `memory/scope-debt/kerugian-barang-rusak.md`. Lintas modul AR & AP — barang rusak yang gak diganti maupun gak dikurangin utangnya (atau di AR, gak dikurangin piutangnya) harus diakui sebagai kerugian (Beban Kerugian Barang Rusak), bukan lewat jalur retur.
