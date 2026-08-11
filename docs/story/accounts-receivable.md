# Story — Accounts Receivable: Toko Plastik Makmur Jaya

Konteks bisnis: `docs/story/company-profile.md` (baca dulu — nama pelanggan/barang di sini persis dari situ). Konsep: `docs/domain/accounts-receivable.md`. Schema: `memory/architecture/data/ar-schema.md`.

Beda dari versi lama file ini: bukan cuma cerita bisnis, tapi **tutorial jalan-jalan di UI beneran** — tiap skenario diikuti langkah konkret (menu mana, field apa, tombol apa, hasil apa). Sidebar app: grup **Accounts Receivable** (ikon `Wallet`) berisi Customers, AR Invoices, AR Payments, AR Deposits, AR Return Credit. Ikuti urutannya kalau mau coba sendiri di browser — tiap skenario numpang dari hasil skenario sebelumnya.

## Master Data — Customers

Pak Herman baru migrasi dari nota tulisan tangan ke sistem. Tiga pelanggan grosir langganan didaftarkan duluan sebagai `customers`, karena semua modul AR (invoice, payment, DP) butuh customer_id.

**Buka:** sidebar → grup **Accounts Receivable** → **Customers** (`/customers`).

Klik **+ New** di pojok kanan toolbar tabel. Form muncul di bawah tabel dengan field: **Nama**, **Kontak**, **Termin (hari)**, **Credit Limit (kosongkan = tanpa batas)**, **Toleransi Telat (hari)**. Isi 3x berturut-turut:

| Nama | Kontak | Termin (hari) | Credit Limit | Toleransi Telat (hari) |
|---|---|---|---|---|
| Toko Kelontong Sumber Rejeki | 0812-3001-0001 | 30 | 8.000.000 | 14 |
| Warung Bu Siti | 0812-3001-0002 | 14 | (kosongkan) | (kosongkan) |
| Toko Serba Ada Barokah | 0812-3001-0003 | 30 | (kosongkan) | (kosongkan) |

Catatan pas ngisi: field **Toleransi Telat (hari)** otomatis ke-prefill sama angka **Termin (hari)** begitu kamu ngetik termin — itu cuma nilai default UI, boleh kamu timpa manual (Sumber Rejeki sengaja diketatin ke 14 padahal terminnya 30, karena riwayat kadang telat bayar). Klik **Simpan** tiap kali — tabel refresh otomatis, baris baru muncul.

Sumber Rejeki dikasih `credit_limit` karena dia pelanggan paling lama tapi kadang telat — Pak Herman mau sistem otomatis nolak kalau piutangnya kelewat besar/lama. Bu Siti dan Serba Ada Barokah dibiarkan tanpa batas dulu (baru, belum ada riwayat piutang bermasalah).

**Lihat detail:** klik baris **Toko Kelontong Sumber Rejeki** di tabel (seluruh baris clickable, bukan tombol) → masuk ke `/customers/[id]`. Halaman ini nampilin ringkasan (nama, kontak, termin, credit limit, total outstanding di kanan atas), badge **Credit Hold** kalau lagi kena hold, tombol **Edit** (toggle form inline buat ubah termin/limit kapan pun — invoice lama gak ikut berubah karena `due_date`-nya udah disnapshot), lalu 2 tabel bertumpuk: **AR Invoices** dan **AR Payments** milik customer ini. Kosong dulu — nanti keisi pas skenario di bawah jalan.

## Skenario 1 — AR Invoice dengan kategori campur + PPN (Toko Serba Ada Barokah)

3 Februari 2026: Toko Serba Ada Barokah — pelanggan grosir volume besar — pesan barang buat restock lapaknya: 40 lusin Ember Plastik 10L @ Rp200.000/lusin = Rp8.000.000. Karena order besar dan lokasinya agak jauh, Pak Herman juga nagih ongkos kirim Rp150.000 terpisah dari harga barang. Toko ini juga customer yang dagangannya dijual lagi ke konsumen akhir yang minta bukti pajak, jadi Pak Herman kenain PPN Keluaran.

**Buka:** sidebar → **AR Invoices** (`/ar-invoices`). Klik **+ New**.

Isi field utama:
- **Customer**: pilih `Toko Serba Ada Barokah (net-30)`.
- **Tanggal**: `2026-02-03`.
- **Rujukan dokumen (source_ref)**: `Nota Grosir #SAB-001`.
- **Deskripsi**: `Kirim Ember Plastik 10L ke Toko Serba Ada Barokah`.
- **Jumlah**: `8000000`.
- **Akun Piutang Usaha (debit)**: pilih akun `Piutang Usaha`.
- **Akun Pendapatan (kredit)**: pilih akun `Pendapatan Penjualan Grosir`.

Di bawahnya ada **Kategori Pendapatan Tambahan (opsional — mis. jasa antar)** — ini yang bikin invoice bisa punya lebih dari 1 baris kredit dalam 1 transaksi (kompunding). Tambah 1 baris: kategori `Jasa Antar` (atau pilih akun pendapatan lain kalau charge type belum ada, sistem juga izinkan pilih akun COA langsung), nominal `150000`.

Kalau PPN aktif (`tax_settings.is_active = true`, diset admin lewat Settings), akan muncul checkbox **Kena PPN Keluaran (11%, dihitung otomatis dari subtotal)** di bawah kategori tambahan — centang. Sistem otomatis ngitung PPN dari subtotal (Rp8.000.000 + Rp150.000 = Rp8.150.000 × 11% = Rp896.500), **bukan** kamu ketik manual.

Klik **Simpan Invoice**. Hasil: 1 baris baru muncul di tabel AR Invoices dengan **Jumlah** = Rp9.046.500 (subtotal + PPN), status **belum**, `due_date` = 3 Feb + 30 hari = **5 Maret 2026**. Jurnal di baliknya (bisa dicek nanti dari halaman detail): Debit Piutang Usaha Rp9.046.500 | Kredit Pendapatan Penjualan Grosir Rp8.000.000, Kredit Jasa Antar Rp150.000, Kredit PPN Keluaran Rp896.500 — SUM debit = SUM kredit, tetap balance.

**Lihat detail invoice:** klik baris ini di tabel → masuk `/ar-invoices/[id]`. Halaman ini pusat semua aksi transaksional invoice (retur, terapkan DP, hapusbukukan, batalkan — semuanya hidup di sini, bukan di row list). Bagian atas nampilin ringkasan: Jumlah Invoice, Terbayar, Retur, Outstanding. Di bawahnya tabel **Jurnal Terkait** (baris debit/kredit lengkap), lalu tabel-tabel kosong: Pembayaran, DP Diterapkan, Retur, Piutang Tak Tertagih (Write-off), Penggantian Barang — semuanya bakal keisi di skenario-skenario berikutnya.

## Skenario 2 — AR Payment cicilan (Toko Kelontong Sumber Rejeki)

5 Februari 2026: Sumber Rejeki ambil barang duluan — 30 lusin Piring Plastik @ Rp32.000/lusin = Rp960.000, invoice biasa tanpa kategori tambahan/PPN, `due_date` = 5 Feb + 30 = **7 Maret 2026**. (Ulangi langkah bikin invoice seperti Skenario 1 kalau mau praktik: source_ref `Nota Grosir #SR-001`, akun sama, tanpa centang PPN.)

20 Februari 2026: Sumber Rejeki baru sanggup bayar sebagian, Rp600.000 dulu — sisanya nyusul.

**Buka:** sidebar → **AR Payments** (`/ar-payments`). Klik **+ New**. Form:
- **Customer**: pilih `Toko Kelontong Sumber Rejeki` — begitu dipilih, dropdown **Invoice** otomatis kefilter cuma invoice outstanding milik customer ini.
- **Invoice**: pilih `Nota Grosir #SR-001 — sisa 960.000`. Begitu dipilih, field **Jumlah dibayar** otomatis keisi `960000` (full outstanding).
- Ubah manual **Jumlah dibayar** jadi `600000` — ini yang bikin cicil.
- **Tanggal**: `2026-02-20`.
- **Rujukan dokumen (source_ref)**: `Transfer BCA #001`.
- **Akun Kas/Bank (debit)**: pilih akun `Kas di Bank`.
- **Akun Piutang Usaha (kredit)**: pilih akun `Piutang Usaha`.

Di bawah form ada kotak info live: **Sisa outstanding invoice terpilih: 960.000**, dan di sebelah kanan teks hijau **Cicil — sisa setelah ini: 360.000** (update otomatis tiap kamu ubah nominal). Kalau kamu coba isi lebih dari 960.000, teksnya berubah merah **Melebihi sisa outstanding — ditolak** — sistem (`record_ar_payment`) betulan nolak overpay lewat RPC, bukan cuma validasi UI kosmetik.

Klik **Simpan Payment**. Baris baru muncul di tabel AR Payments, status invoice `SR-001` di `/ar-invoices` berubah jadi **sebagian**. Klik baris payment ini → `/ar-payments/[id]` nampilin detail: invoice yang dilunasi, nominal, dan tabel Jurnal Terkait (Debit Kas di Bank 600.000 | Kredit Piutang Usaha 600.000).

15 Maret 2026 (telat 8 hari dari due date 7 Maret): Sumber Rejeki lunasin sisanya Rp360.000 — ulangi langkah AR Payments, kali ini pilih invoice yang sama, jumlah otomatis keisi `360000` (sisa outstanding-nya), source_ref `Transfer BCA #002`. Simpan. Status invoice `SR-001` sekarang **lunas**.

## Skenario 3 — Aging & Credit Hold (Toko Kelontong Sumber Rejeki)

1 April 2026: Sumber Rejeki order lagi — 25 lusin Kursi Plastik Lipat @ Rp850.000/lusin = Rp21.250.000, `due_date` = 1 Apr + 30 = **1 Mei 2026**. Bikin invoice-nya dulu lewat AR Invoices (source_ref `Nota Grosir #SR-002`).

**Belum ada pembayaran sama sekali** sampai hari ini. Cek: buka `/customers/[id]` Sumber Rejeki — tabel AR Invoices nampilin baris `SR-002` dengan badge merah **Telat** di kolom Jatuh Tempo begitu tanggalnya udah lewat (badge ini muncul otomatis, `due_date < hari ini`).

2 Juni 2026 (62 hari lewat due date): Sumber Rejeki mau order lagi, 10 lusin Rak Plastik Serbaguna @ Rp1.200.000 = Rp12.000.000. Coba bikin invoice-nya lewat AR Invoices seperti biasa (customer Sumber Rejeki, jumlah 12000000) → klik **Simpan Invoice**.

**Hasil: gagal, muncul `FormError` merah** berisi pesan dari RPC `create_ar_invoice` — kena credit hold. Cek kenapa: outstanding Sumber Rejeki sekarang Rp21.250.000 (invoice SR-002 belum dibayar sepeser pun) — `credit_limit`-nya Rp8.000.000, **kelampaui**. Invoice SR-002 juga udah telat 62 hari sementara `overdue_threshold_days` Sumber Rejeki cuma 14 hari — **kelampaui juga**. Cukup salah satu kondisi kepenuhi buat ditolak; di sini dua-duanya kepenuhi. Kalau kamu buka `/customers/[id]` Sumber Rejeki sekarang, badge merah **Credit Hold** muncul di sebelah nama customer di header.

Pak Herman tetap mau ngirim barang hari itu, tapi minta Bu Siti (kasir) catat sebagai penjualan tunai biasa lewat kios POS (bayar cash langsung) — bukan lewat AR, gak nambah piutang. Itu di luar scope dokumen ini (lihat modul POS terpisah).

## Skenario 4 — Retur barang, jalur full dengan kondisi RESALABLE/DAMAGED (Toko Serba Ada Barokah)

Lanjutan invoice `SAB-001` (Skenario 1) — invoice ini lahir dari proses **Goods Issue** di modul Inventory (barang beneran dikeluarkan dari stok, bukan cuma dicatat manual di AR), jadi retur di sini lewat **jalur full**: form-nya bakal nampilin baris per item dengan pilihan kondisi, bukan cuma field nominal polos.

10 Februari 2026: pas dibongkar di gudang Toko Serba Ada Barokah, 3 lusin dari 40 lusin Ember Plastik 10L ternyata penyok kena benturan pas dikirim (mobil pickup Pak Herman lewat jalan rusak) — gak layak jual lagi. 2 lusin lainnya cuma keliru pesan (harusnya warna beda), masih mulus dan bisa dijual ulang.

**Buka:** `/ar-invoices/[id]` invoice `SAB-001` (klik dari tabel AR Invoices). Klik tombol **Retur** di kanan atas (di sebelah tombol Terapkan DP/Hapusbukukan/Batalkan — semuanya di halaman detail ini, sesuai aturan halaman detail admin-shell). Form **Catat Retur** muncul dengan teks penjelasan "Invoice ini lewat Goods Issue — isi qty per item yang balik, stok & HPP otomatis ke-reverse proporsional."

Isi:
- **Tanggal Retur**: `2026-02-10`.
- **Rujukan dokumen**: `Nota Retur #SAB-001-R1`.
- **Akun Retur & Potongan Penjualan (debit)**, **Akun Piutang Usaha (kredit)**, **Akun HPP (kredit)**, **Akun Persediaan Barang Jadi (debit, baris Layak Jual)**, **Akun Beban Kerugian Barang Rusak (debit, baris Rusak)** — pilih akun masing-masing sesuai nama.
- **Nominal Retur**: isi total nilai jual barang yang diretur (5 lusin × Rp200.000 = Rp1.000.000).

Di bagian bawah, tabel baris item muncul otomatis dari data Goods Issue asli — untuk **Ember Plastik 10L**, isi:
- Baris 1 (2 lusin, keliru pesan): **Qty Retur** = `2`, **Kondisi** = `Layak Jual` (dropdown default).
- Baris 2 (3 lusin, penyok): karena cuma 1 baris per item di form, praktiknya kamu isi qty retur 3 lusin sekaligus tapi kondisinya beda dari yang 2 lusin — kalau kondisinya campur dalam 1 item, catat 2 kali panggilan retur terpisah (submit form 2x, sekali per kondisi) supaya tiap baris dapat 1 `condition` yang benar. Panggilan pertama: **Qty Retur** = `2`, **Kondisi** = `Layak Jual`. Klik **Simpan Retur**.

Ulangi buka form Retur lagi (klik **Retur** sekali lagi di header): panggilan kedua, **Qty Retur** = `3`, **Kondisi** = `Rusak`, **Nominal Retur** = Rp600.000 (3 lusin × Rp200.000), source_ref `Nota Retur #SAB-001-R2`. Klik **Simpan Retur**.

**Hasil yang harus muncul:** tabel **Retur** di halaman detail invoice sekarang punya 2 baris, badge jalur **Full (stok+HPP)** di keduanya. Baris kedua (3 lusin) item-nya dapat badge merah kecil **Rusak** di sebelah nama item. Outstanding invoice berkurang total Rp1.600.000 dari kedua retur ini. Efek stok: 2 lusin Ember Plastik yang **Layak Jual** balik masuk `inventory_balances` (bisa dicek di `/inventory`), 3 lusin yang **Rusak** TIDAK balik ke stok — cost-nya direklasifikasi jadi beban (Debit Beban Kerugian Barang Rusak, bukan Debit Persediaan Barang Jadi).

## Skenario 5 — Penggantian barang / garansi (Toko Serba Ada Barokah, lanjutan Skenario 4)

12 Februari 2026: Toko Serba Ada Barokah tetap butuh 3 lusin Ember Plastik utuh buat dijual ulang (bukan cuma potongan tagihan) — mereka pelanggan volume besar, gak mau kehilangan stok jual. Pak Herman setuju ganti dengan barang baru dari stok gudang — ini penukaran garansi, bukan gratisan: mereka tetap bayar penuh nilai barang aslinya, cuma gak ada invoice baru buat 3 lusin pengganti ini.

**Buka:** `/ar-invoices/[id]` invoice `SAB-001` lagi. Di tabel **Retur**, baris retur kedua (3 lusin, **Rusak**) punya tombol **Ganti Barang** di kolom paling kanan (cuma muncul di baris retur yang jalur full). Klik tombol itu — panel ungu **Tukar Barang (Garansi)** muncul di bawah halaman.

Isi:
- **Tanggal**: `2026-02-12`.
- **Rujukan dokumen**: `Nota Ganti #SAB-001-G1`.
- **Akun HPP (debit)**, **Akun Persediaan Barang Jadi (kredit)**, **Akun Piutang Usaha (debit, pembalikan diskon)**, **Akun Retur & Potongan Penjualan (kredit, pembalikan diskon)** — pilih akun masing-masing.
- Di tabel item bawah, **Ember Plastik 10L (3 lusin tersedia)** — isi **Qty Ganti** = `3`.

Klik **Simpan Penggantian**. Hasil: tabel **Penggantian Barang** di halaman detail keisi 1 baris — kolom Cost (nilai barang pengganti keluar dari stok fresh, bukan dari lot rusak), **Diskon Retur Dibalik** (Rp600.000 — sama persis nominal retur "Rusak" yang tadi diberikan, dibalik penuh karena semua qty retur itu diganti barang). Outstanding invoice `SAB-001` naik lagi Rp600.000 (balik ke nilai yang seharusnya dibayar, karena akhirnya diganti barang, bukan didiskon) — tapi stok Ember Plastik NETT berkurang 3 lusin dari sebelum retur (3 lusin rusak beneran hilang nilainya, 3 lusin pengganti beneran keluar dari stok fresh terpisah).

## Skenario 6 — Saldo kredit dari retur, direfund tunai (Toko Kelontong Sumber Rejeki)

Lanjutan invoice `SR-001` (Skenario 2) — sudah **lunas** sejak 15 Maret 2026. 20 Maret 2026: Sumber Rejeki lapor 2 lusin Piring Plastik dari kiriman itu ternyata retak-retak halus, minta dikurangin Rp64.000 (2 lusin × Rp32.000). Karena invoice ini gak lewat Goods Issue (dibuat manual lewat AR Invoices), retur ini lewat **jalur financial-only**.

**Buka:** `/ar-invoices/[id]` invoice `SR-001`. Klik **Retur**. Form kali ini gak nampilin tabel item (financial-only) — cuma field nominal. Isi: **Tanggal Retur** `2026-03-20`, **Rujukan dokumen** `Nota Retur #SR-001-R1`, **Nominal Retur** `64000`, pilih **Akun Retur & Potongan Penjualan (debit)** dan **Akun Piutang Usaha (kredit)**. Karena outstanding invoice ini sebelum retur = Rp0 (udah lunas penuh), field **Akun Saldo Kredit Retur Customer (kredit, cuma kalau retur ini bikin outstanding minus)** WAJIB diisi juga — pilih akun `Saldo Kredit Retur Customer`. Klik **Simpan Retur**.

**Hasil:** sistem otomatis deteksi seluruh Rp64.000 jadi excess (karena outstanding sebelum retur udah 0), bikin jurnal reklasifikasi tambahan (Debit Piutang Usaha / Kredit Saldo Kredit Retur Customer) di baliknya — outstanding invoice `SR-001` balik ke 0 (gak jadi minus), tapi 1 baris baru lahir di **AR Return Credit**.

**Buka:** sidebar → **AR Return Credit** (`/ar-return-credits`) — daftar semua saldo kredit dari retur, murni lahir otomatis, gak ada tombol +New di sini. Klik baris Sumber Rejeki yang baru muncul → `/ar-return-credits/[id]`. Halaman ini nampilin Jumlah Awal Rp64.000, Sudah Direfund Rp0, Sisa Rp64.000, tombol **Refund Tunai** di kanan atas.

25 Maret 2026: Sumber Rejeki gak ada rencana order dekat-dekat ini, minta uangnya balik langsung. Klik **Refund Tunai** → form muncul: **Nominal Refund (maks 64.000)** isi `64000`, **Tanggal** `2026-03-25`, **Rujukan dokumen** `Refund-SR-001-R1`, **Akun Kas/Bank (debit)** dan **Akun Saldo Kredit Retur Customer (kredit)** — pilih akun masing-masing. Klik **Refund**. Sisa saldo kredit sekarang **Rp0**.

## Skenario 7 — Piutang tak tertagih / write-off (Toko Kelontong Sumber Rejeki)

Lanjutan invoice `SR-002` (Skenario 3, Rp21.250.000, belum dibayar sepeser pun, udah lewat due date jauh). Setelah berkali-kali ditagih (WA gak dibales, ke toko udah tutup), 1 Agustus 2026 Pak Herman mutusin toko ini beneran gulung tikar — piutang ini gak akan pernah tertagih.

**Buka:** `/ar-invoices/[id]` invoice `SR-002`. Klik tombol **Hapusbukukan** di header (muncul cuma kalau invoice masih outstanding & belum dibatalkan). Panel merah **Hapusbukukan Piutang Tak Tertagih** muncul dengan penjelasan: "Piutang ini beneran gak akan tertagih... Pendapatan asli gak dibalik, cuma piutangnya dihapusbukukan lewat beban baru. Boleh sebagian, tapi gak boleh ngelebihin sisa outstanding."

Isi: **Tanggal Write-off** `2026-08-01`, **Rujukan dokumen** `Write-off piutang - Toko Sumber Rejeki tutup usaha`, **Nominal Write-off (maks 21.250.000)** isi `21250000` (penuh — belum pernah ada payment/retur/DP di invoice ini), **Akun Beban Piutang Tak Tertagih (debit)** dan **Akun Piutang Usaha (kredit)** — pilih akun masing-masing. Klik **Simpan Write-off**.

**Hasil:** status invoice `SR-002` di `/ar-invoices` berubah jadi **dihapusbukukan** (beda dari lunas — piutangnya gak pernah beneran dibayar, cuma diakui hilang). Pendapatan Penjualan Grosir Rp21.250.000 dari 1 April **tetap berdiri**, gak dibalik — penjualannya beneran kejadian. Yang kena beban baru cuma periode Agustus (saat write-off), bukan periode April (saat penjualan). Outstanding invoice ini sekarang 0, tapi bukan karena lunas.

## Uang Muka / DP — pelanggan yang bayar duluan (Warung Bu Siti)

Warung Bu Siti — pelanggan grosir kecil — beda pola dari 2 langganan besar di atas: sering bayar cicil/DP dulu sebelum ambil barang, karena modalnya pas-pasan dan gak berani ambil banyak sekaligus tanpa modal muka.

## Skenario 8 — DP diterima & diterapkan penuh ke invoice (Warung Bu Siti)

5 Mei 2026: Bu Siti mau ambil paket alat makan buat dijual pas Lebaran — rencana 100 pcs Paket Alat Makan @ Rp8.000 = Rp800.000, tapi baru bisa DP Rp300.000 dulu, sisanya pas barang diambil minggu depan.

**Buka:** sidebar → **AR Deposits** (`/ar-deposits`). Klik **+ New**. Form **Terima Uang Muka**:
- **Customer**: pilih `Warung Bu Siti`.
- **Tanggal**: `2026-05-05`.
- **Rujukan dokumen (source_ref)**: `DP Paket Alat Makan Bu Siti`.
- **Jumlah**: `300000`.
- **Akun Kas/Bank (debit)** dan **Akun Uang Muka Penjualan (kredit)** — pilih akun masing-masing.

Klik **Simpan Deposit**. Baris baru muncul di tabel AR Deposits, kolom **Status** menunjukkan badge abu-abu **Belum Dipakai**, kolom **Sisa** = Rp300.000. Piutang Usaha belum kesentuh sama sekali — DP ini murni liability (Uang Muka Penjualan), bukan piutang.

12 Mei 2026: barang jadi & Bu Siti ambil. Bikin invoice dulu lewat **AR Invoices** seperti biasa: customer Warung Bu Siti, jumlah Rp800.000 penuh, source_ref `Nota Grosir #BS-001`. Simpan.

**Buka:** `/ar-invoices/[id]` invoice `BS-001` yang baru dibuat. Klik tombol **Terapkan DP** di header. Panel biru **Terapkan DP ke Invoice Ini** muncul:
- **Deposit**: pilih `DP Paket Alat Makan Bu Siti (sisa 300.000)` — begitu dipilih, **Nominal Diterapkan** otomatis keisi `300000` (min dari sisa DP dan outstanding invoice).
- **Tanggal**: `2026-05-12`.
- **Rujukan dokumen**: `Terapkan-DP-BS-001`.
- **Akun Uang Muka Penjualan (debit)** dan **Akun Piutang Usaha (kredit)** — pilih akun.

Klik **Terapkan DP**. Hasil: tabel **DP Diterapkan** di halaman detail invoice keisi 1 baris Rp300.000, Outstanding invoice turun jadi Rp500.000. Kalau kamu buka lagi `/ar-deposits/[id]` deposit ini, statusnya sekarang **Selesai** (sisa Rp0), tabel **Diterapkan ke Invoice** nampilin baris dengan badge hijau **Aktif**.

15 Mei 2026: Bu Siti lunasin sisa Rp500.000 lewat **AR Payments** biasa (pilih invoice `BS-001`, jumlah 500000, source_ref `Tunai #001`). Status invoice jadi **lunas**.

## Skenario 9 — DP hangus, order dibatalkan sebelum invoice ada (Warung Bu Siti)

20 Juni 2026: Bu Siti pesan lagi 50 pcs Toples Plastik @ Rp12.000 = Rp600.000 buat dijual ulang, DP Rp200.000 di muka (via AR Deposits, source_ref `DP Toples Bu Siti`). Barangnya udah disiapin Pak Herman dari stok.

25 Juni 2026: Bu Siti batal ambil (dagangannya lagi sepi). Belum ada invoice yang pernah dibuat sama sekali. Kebijakan Pak Herman: DP gak direfund kalau barang udah kadung disiapkan/dipesankan khusus.

**Buka:** `/ar-deposits/[id]` deposit `DP Toples Bu Siti`. Klik tombol **Hanguskan** di header. Panel merah **Hanguskan Deposit** muncul dengan penjelasan "Sisa deposit dihanguskan — jadi Pendapatan Lain-lain, bukan Pendapatan Penjualan. Boleh sebagian."

Isi: **Nominal Hangus (maks 200.000)** `200000`, **Tanggal** `2026-06-25`, **Rujukan dokumen** `Pembatalan pesanan Toples Bu Siti`, **Akun Uang Muka Penjualan (debit)** dan **Akun Pendapatan Lain-lain (kredit)** — pilih akun. Klik **Hanguskan**.

**Hasil:** status deposit jadi **Selesai**, tabel **Hangus** keisi 1 baris Rp200.000. Jurnalnya masuk ke Pendapatan Lain-lain, bukan Pendapatan Penjualan Grosir/Toko — karena gak ada barang yang beneran kejual.

## Skenario 10 — Invoice salah input, dibatalkan (Toko Serba Ada Barokah)

3 Juli 2026: staff salah ketik nominal invoice buat Toko Serba Ada Barokah — harusnya 20 lusin Gelas Plastik @ Rp27.000 = Rp540.000, kepencet jadi Rp5.400.000 (kelebihan 1 digit). Bikin invoice-nya dulu lewat AR Invoices dengan nominal salah itu (source_ref `Nota Grosir #SAB-002`) buat simulasi.

**Buka:** `/ar-invoices/[id]` invoice `SAB-002` yang baru dibuat (belum ada payment sama sekali). Klik tombol **Batalkan** di header (cuma muncul kalau invoice belum ada payment & belum ada write-off). Muncul dialog konfirmasi browser (`window.prompt`): "Batalkan invoice Nota Grosir #SAB-002 (Rp5.400.000)? Masukin rujukan dokumen buat entry pembalik:" — isi `Pembatalan salah input SAB-002`, klik OK.

**Hasil:** RPC `cancel_ar_invoice` bikin jurnal pembalik (reversing entry) — Debit Pendapatan Penjualan Grosir 5.400.000 | Kredit Piutang Usaha 5.400.000. Status invoice di tabel AR Invoices berubah jadi **dibatalkan** (baris tetap ada di histori, dicoret/di-strikethrough, bukan dihapus). Invoice yang benar (Rp540.000) diterbitkan ulang lewat AR Invoices seperti biasa.

Kalau invoice yang mau dibatalkan itu ternyata punya DP yang udah diterapkan (pola Skenario 8), tombol Batalkan tetap muncul dan RPC-nya otomatis ikut membalikkan jurnal DP-application-nya juga — DP-nya balik "belum dipakai", gak nyangkut.

## Rekap Cakupan

Semua fitur AR yang ada di sistem sudah dipraktikkan di atas: Customers (CRUD + credit_limit/overdue_threshold_days), AR Invoice (multi-line/kompunding + PPN + credit hold), AR Payment (cicilan + anti-overpay), Retur Barang (financial-only & full, kondisi RESALABLE/DAMAGED), Penggantian Barang/Garansi, AR Return Credit (refund tunai), Piutang Tak Tertagih (write-off), Uang Muka/DP (terima, terapkan, hanguskan), dan Batalkan Invoice.

## Lanjutan Story

Fase berikutnya (Accounts Payable) kebalikannya — Toko Plastik Makmur Jaya yang berutang ke 2 supplier (PT Plastindo Jaya, CV Sumber Plastik), pola bill/payment/retur-nya mirror AR ini dari sisi utang. Lihat `docs/story/accounts-payable.md`.
