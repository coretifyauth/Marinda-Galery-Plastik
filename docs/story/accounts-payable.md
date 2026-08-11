# Story — Accounts Payable: Toko Plastik Makmur Jaya

Konteks bisnis: `docs/story/company-profile.md`. Konsep: `docs/domain/accounts-payable.md`. Schema: `memory/architecture/data/ap-schema.md`. Kebalikan langsung dari `docs/story/accounts-receivable.md` — Toko Plastik Makmur Jaya yang berutang ke supplier, bukan piutang dari customer. Struktur mirror persis AR, cuma arah kebalik.

Sama seperti file AR: ini tutorial jalan-jalan di UI beneran, bukan cuma cerita bisnis. Sidebar app: grup **Accounts Payable** (ikon `CreditCard`) berisi Suppliers, AP Bills, AP Payments, AP Deposits, AP Return Credit.

## Master Data — Suppliers

Toko Plastik Makmur Jaya punya 2 supplier langganan: **PT Plastindo Jaya** (pabrik plastik lokal, pemasok Ember Plastik 10L/Kursi Plastik Lipat/Rak Plastik Serbaguna — kadang ada barang cacat produksi) dan **CV Sumber Plastik** (distributor, pemasok Piring Plastik/Gelas Plastik/Toples Plastik/Sendok-Garpu Plastik import — kadang dikasih DP dulu buat kunci stok musiman).

**Buka:** sidebar → grup **Accounts Payable** → **Suppliers** (`/suppliers`). Klik **+ New**. Form: **Nama**, **Kontak**, **Termin (hari)**. Beda dari Customers — di sini **gak ada** field credit_limit/overdue_threshold_days (Pak Herman gak nentuin batas ke diri sendiri; termin di sini malah syarat yang DITETAPKAN supplier ke Pak Herman, bukan sebaliknya). Isi 2x:

| Nama | Kontak | Termin (hari) |
|---|---|---|
| PT Plastindo Jaya | 031-7001-1001 | 30 |
| CV Sumber Plastik | 031-7001-1002 | 21 |

Klik **Simpan** tiap kali. **Lihat detail:** klik baris `PT Plastindo Jaya` di tabel → `/suppliers/[id]`. Halaman ini nampilin Total Outstanding di kanan atas, tabel **AP Bills** dan **AP Payments** milik supplier ini (kosong dulu, keisi di skenario bawah). Beda dari Customer detail, di sini gak ada tombol Edit inline — kalau termin berubah, edit lewat form yang sama seperti create (belum ada UI khusus edit supplier di halaman ini).

## Skenario 1 — AP Bill dengan kategori campur + PPN Masukan (PT Plastindo Jaya)

10 Januari 2026: Toko Plastik Makmur Jaya ambil stok dari PT Plastindo Jaya — 60 lusin Ember Plastik 10L @ Rp150.000/lusin = Rp9.000.000 (harga pabrik, lebih murah dari harga jual ke pelanggan grosir). Ongkos kirim dari pabrik ke gudang Rp250.000 ditagih terpisah di nota yang sama. Supplier ini PKP, jadi nota-nya kena PPN Masukan yang bisa dikreditkan.

**Buka:** sidebar → **AP Bills** (`/ap-bills`). Klik **+ New**. Isi:
- **Supplier**: pilih `PT Plastindo Jaya (net-30)`.
- **Tanggal**: `2026-01-10`.
- **Rujukan dokumen (source_ref)**: `Nota Beli #PJ-001`.
- **Deskripsi**: `Ambil Ember Plastik 10L dari PT Plastindo Jaya`.
- **Jumlah**: `9000000`.
- **Akun Persediaan/Beban (debit)**: pilih akun `Persediaan Bahan Baku` (atau `Persediaan Barang Dagang` sesuai COA — barang ini buat dijual ulang).
- **Akun Utang Usaha (kredit)**: pilih akun `Utang Usaha`.

Di bawah, **Kategori Debit Tambahan (opsional — mis. ongkir supplier)**: tambah 1 baris kategori `Beban Ongkir`, nominal `250000`. Kalau PPN aktif, centang **Kena PPN Masukan (11%, dihitung otomatis dari subtotal)** — PPN dihitung otomatis dari subtotal (Rp9.000.000 + Rp250.000 = Rp9.250.000 × 11% = Rp1.017.500), ditambahkan ke Utang Usaha (utang ke supplier termasuk pajak yang bisa dikreditkan).

Klik **Simpan Bill**. Hasil: baris baru di tabel AP Bills, **Jumlah** = Rp10.267.500, status **belum**, `due_date` = 10 Jan + 30 = **9 Februari 2026**. Jurnal: Debit Persediaan Bahan Baku 9.000.000, Debit Beban Ongkir 250.000, Debit PPN Masukan 1.017.500 | Kredit Utang Usaha 10.267.500.

**Lihat detail:** klik baris ini → `/ap-bills/[id]`. Sama pola AR Invoice detail: ringkasan Jumlah Bill/Terbayar/Retur/Outstanding, tabel Jurnal Terkait, lalu tabel-tabel kosong (Pembayaran, DP Diterapkan, Retur, Tukar Barang, Tulis-jadi-Beban) yang bakal keisi di skenario berikutnya. Tombol aksi (Retur, Tukar Barang, Tulis-jadi-Beban, Terapkan DP, Batalkan Bill) semuanya hidup di header halaman ini.

## Skenario 2 — AP Payment cicilan (CV Sumber Plastik)

15 Januari 2026: ambil stok dari CV Sumber Plastik — 200 lusin Piring Plastik @ Rp28.000/lusin = Rp5.600.000, `due_date` = 15 Jan + 21 = **5 Februari 2026**. (Bikin bill-nya lewat AP Bills: source_ref `Nota Beli #SP-001`, akun sama seperti Skenario 1 tanpa kategori tambahan/PPN.)

25 Januari 2026: Toko Plastik Makmur Jaya baru sanggup bayar Rp3.000.000 dulu, sisanya nanti.

**Buka:** sidebar → **AP Payments** (`/ap-payments`). Klik **+ New**. Form:
- **Supplier**: pilih `CV Sumber Plastik` — dropdown **Bill** otomatis kefilter bill outstanding milik supplier ini.
- **Bill**: pilih `Nota Beli #SP-001 — sisa 5.600.000` — **Jumlah dibayar** otomatis keisi `5600000`.
- Ubah manual jadi `3000000`.
- **Tanggal**: `2026-01-25`, **Rujukan dokumen**: `Transfer BCA #SP-001-1`.
- **Akun Utang Usaha (debit)** dan **Akun Kas/Bank (kredit)** — pilih akun.

Kotak info live di bawah form nampilin **Sisa outstanding bill terpilih: 5.600.000** dan teks hijau **Cicil — sisa setelah ini: 2.600.000**. Klik **Simpan Payment**. Status bill `SP-001` jadi **sebagian**. Klik baris payment ini → `/ap-payments/[id]` nampilin detail sama pola AR Payment.

5 Februari 2026 (pas jatuh tempo): lunasin sisa Rp2.600.000 — ulangi form, pilih bill sama, jumlah otomatis `2600000`, source_ref `Transfer BCA #SP-001-2`. Status bill jadi **lunas**.

**Catatan penting**: form ini cuma bisa 1 bill per payment — gak ada opsi "bayar gabungan" ke beberapa bill sekaligus dalam 1 transaksi (beda dari AR yang memang dari awal juga gak punya fitur itu). Kalau ada 3 bill kecil dari supplier yang sama mau dilunasi bareng, catat 3x payment terpisah.

## Skenario 3 — Aging (Toko Plastik Makmur Jaya telat bayar ke PT Plastindo Jaya)

Lanjutan bill `PJ-001` (Skenario 1, Rp10.267.500, `due_date` 9 Februari 2026) — belum dibayar sama sekali. Kalau kamu buka `/suppliers/[id]` PT Plastindo Jaya setelah 9 Februari lewat, tabel AP Bills nampilin badge merah **Telat** di kolom Jatuh Tempo (badge muncul otomatis, sama mekanisme dengan AR).

Beda arah dari AR: di sini yang telat itu **kita** (Toko Plastik Makmur Jaya), resikonya PT Plastindo Jaya bisa nahan kiriman berikutnya kalau makin lama gak dibayar — bukan piutang customer yang macet.

## Skenario 4 — Retur barang ke supplier: Opsi A vs Opsi B (PT Plastindo Jaya)

Barang cacat dari pabrik itu ada 2 cara diselesaikan, saling eksklusif per unit barang: **Opsi A — Kurangi Utang** (`create_ap_credit_note`, Debit Utang Usaha / Kredit Persediaan, tanpa akun kontra karena Persediaan itu akun neraca) atau **Opsi B — Tukar Barang** (`create_purchase_replacement`, barang rusak keluar/barang baik masuk, net nol, Utang Usaha gak kesentuh sama sekali). Dua-duanya independen dari status bayar bill, dan boleh dipecah campur dalam 1 bill yang sama (qty berbeda, opsi berbeda) — dibatasi cuma sama qty fisik yang diterima di GRN.

Lanjutan bill `PJ-001` (60 lusin Ember Plastik 10L, unit cost Rp150.000/lusin, diterima lewat Goods Receipt di modul Inventory — jadi retur ini lewat jalur full).

**Skenario 4a — Opsi A, minta tagihan dikurangi.** 20 Januari 2026: pas dicek ulang, 5 lusin dari kiriman itu ternyata sompel/retak di bagian pinggir — gak layak dijual. PT Plastindo Jaya setuju kurangi tagihan (Opsi A).

**Buka:** `/ap-bills/[id]` bill `PJ-001`. Klik tombol **Retur — Kurangi Utang** di header. Panel amber **Retur — Kurangi Utang** muncul dengan penjelasan: bill ini lewat Goods Receipt, jadi kolom nominal retur otomatis dihitung dari cost fisik barang (bukan angka yang kamu ketik manual) — field **Nominal Retur** malah gak muncul kalau `goodsReceipt` ada, digantikan tabel per item.

Isi: **Tanggal Retur** `2026-01-20`, **Rujukan dokumen** `Retur-PJ-001-1`, **Akun Utang Usaha (debit)** dan **Akun Persediaan/Beban (kredit)** — pilih akun. Di tabel item, **Ember Plastik 10L (sisa bisa diklaim: 60 lusin)** — isi **Qty Retur** = `5`. Klik **Simpan Retur**.

**Hasil:** tabel **Retur (Kurangi Utang)** di halaman detail keisi 1 baris, badge jalur **Full (stok)**, nominal Rp750.000 (5 lusin × Rp150.000, dihitung sistem dari cost fisik `consume_weighted_average`, bukan input manual). Utang Usaha bill `PJ-001` turun dari Rp10.267.500 jadi Rp9.517.500. Stok Ember Plastik di `inventory_balances` berkurang 5 lusin.

**Skenario 4b — Opsi B, minta barang diganti.** 22 Januari 2026: 3 lusin lainnya dari kiriman yang sama juga cacat (sompel ringan), tapi kali ini PT Plastindo Jaya lebih suka kirim gantinya langsung buat jaga hubungan baik, bukan potong tagihan.

**Buka:** `/ap-bills/[id]` bill `PJ-001` lagi. Klik tombol **Tukar Barang** di header (cuma muncul kalau bill ini punya Goods Receipt). Panel ungu **Tukar Barang** muncul: "Barang rusak keluar, barang baik masuk — murni reklasifikasi stok, gak nyentuh Utang Usaha sama sekali. Utang Usaha bill ini tetap penuh."

Isi: **Tanggal** `2026-01-22`, **Rujukan dokumen** `Tukar-PJ-001-1`, **Akun Persediaan (debit barang masuk & kredit barang keluar)** — pilih akun. Di tabel item, **Ember Plastik 10L (sisa bisa diklaim: 55 lusin)** — isi **Qty Tukar** = `3`. Klik **Simpan Tukar Barang**.

**Hasil:** tabel **Tukar Barang** keisi 1 baris, cost Rp450.000 (3 lusin × Rp150.000) — jurnalnya Debit Persediaan (barang baru) / Kredit Persediaan (barang rusak), akun yang sama di 2 baris, net nol. Utang Usaha bill `PJ-001` **tetap Rp9.517.500**, gak berubah sama sekali dari langkah ini — beda dari Opsi A yang beneran ngurangin utang.

## Skenario 5 — Retur (Opsi A) bikin saldo kredit karena bill sudah lunas (CV Sumber Plastik)

Lanjutan bill `SP-001` (Skenario 2, Rp5.600.000, **lunas** sejak 5 Februari 2026). 10 Februari 2026: pas dihitung ulang stok, 4 lusin Piring Plastik dari kiriman itu ternyata retak halus — CV Sumber Plastik setuju potong nota lama itu (Opsi A) walau udah lunas. Nilai retur = 4 lusin × Rp28.000 = Rp112.000.

**Buka:** `/ap-bills/[id]` bill `SP-001`. Klik **Retur — Kurangi Utang**. Karena bill ini juga lewat Goods Receipt (jalur full), form nampilin tabel item — isi **Piring Plastik**, **Qty Retur** = `4`, tanggal `2026-02-10`, source_ref `Retur-SP-001-1`, pilih **Akun Utang Usaha (debit)** dan **Akun Persediaan/Beban (kredit)**. Karena outstanding bill ini sebelum retur = Rp0 (udah lunas penuh), field **Akun Piutang Retur Supplier (debit, cuma kalau retur ini bikin Utang Usaha jadi minus)** WAJIB diisi — pilih akun `Piutang Retur Supplier`. Klik **Simpan Retur**.

**Hasil:** sistem otomatis deteksi seluruh Rp112.000 jadi excess, bikin jurnal reklasifikasi (Debit Piutang Retur Supplier / Kredit Utang Usaha) — Utang Usaha bill `SP-001` balik ke Rp0 (gak jadi minus), 1 baris baru lahir di **AP Return Credit**.

**Buka:** sidebar → **AP Return Credit** (`/ap-return-credits`) — mirror `/ar-return-credits`, murni lahir otomatis dari retur, gak ada tombol +New. Klik baris CV Sumber Plastik yang baru muncul → `/ap-return-credits/[id]`. Nampilin Jumlah Awal Rp112.000, Sudah Direfund Rp0, Sisa Rp112.000, tombol **Refund Tunai**.

15 Februari 2026: klik **Refund Tunai** → isi **Nominal Refund (maks 112.000)** `112000`, **Tanggal** `2026-02-15`, **Rujukan dokumen** `Refund-SP-001-1`, **Akun Kas/Bank (debit)** dan **Akun Piutang Retur Supplier (kredit)**. Klik **Refund**. Sisa saldo sekarang Rp0.

**Catatan**: beda dari sisi AR, `ap_return_credits` cuma punya 1 disposisi — refund tunai. Gak ada opsi "dipakai motong bill lain" (sempat ada di desain awal, dicabut karena bukan fondasi AP).

## Skenario 6 — Tulis-jadi-Beban / write-off, supplier tolak kompensasi (PT Plastindo Jaya, Opsi C)

Lanjutan bill `PJ-001` (sudah kena Opsi A 5 lusin + Opsi B 3 lusin di Skenario 4, sisa klaim 8 dari 60 lusin). 5 Maret 2026: pas cek ulang sisa stok, ketauan lagi 2 lusin Ember Plastik dari kiriman yang sama menggumpal deformasi kena panas gudang — ketauan belakangan, bukan pas pengecekan pertama. Kali ini PT Plastindo Jaya **menolak** kompensasi apa pun — alasan mereka, klaim buat kiriman itu udah dianggap selesai lewat Opsi A/B sebelumnya. Toko Plastik Makmur Jaya harus menanggung sendiri kerugian ini.

**Buka:** `/ap-bills/[id]` bill `PJ-001`. Klik tombol **Tulis-jadi-Beban** di header. Panel merah **Tulis-jadi-Beban (Kerugian Barang Rusak)** muncul: "Supplier nolak kompensasi sama sekali — gak kurangin Utang Usaha, gak kirim pengganti. Barang rusak ini murni kerugian yang ditanggung sendiri... Utang Usaha bill ini tetap penuh."

Isi: **Tanggal** `2026-03-05`, **Rujukan dokumen** `WriteOff-PJ-001-1`, **Akun Beban Kerugian Barang Rusak (debit)** dan **Akun Persediaan (kredit)** — pilih akun. Tabel item nampilin **Ember Plastik 10L (sisa bisa diklaim: 52 lusin)** — isi **Qty Write-off** = `2`. Klik **Simpan Write-off**.

**Hasil:** tabel **Tulis-jadi-Beban (Kerugian Barang Rusak)** keisi 1 baris, cost Rp300.000 (2 lusin × Rp150.000). Jurnal: Debit Beban Kerugian Barang Rusak 300.000 / Kredit Persediaan Bahan Baku 300.000. Utang Usaha bill `PJ-001` **gak kesentuh sama sekali**, tetap Rp9.517.500 (sama seperti setelah Opsi A/B). Kombinasi Opsi A (5 lusin) + Opsi B (3 lusin) + Opsi C (2 lusin) = 10 lusin dari 60 lusin yang diterima — sisa 50 lusin masih bisa diklaim lewat opsi mana pun kalau nanti ketauan cacat lagi.

## Uang Muka Pembelian / DP ke supplier (CV Sumber Plastik)

CV Sumber Plastik kadang minta Toko Plastik Makmur Jaya bayar DP dulu buat kunci stok barang musiman (misal stok alat makan plastik jelang Lebaran yang cepat abis).

## Skenario 7 — DP dibayar, diselesaikan campuran: sebagian diterapkan, sebagian refund, sebagian hangus

1 Maret 2026: mendekati musim Lebaran, CV Sumber Plastik nawarin stok Paket Alat Makan edisi khusus — 100 lusin @ Rp95.000/lusin = Rp9.500.000, tapi minta DP 40% duluan buat kunci stoknya (supplier ini juga lagi kejar order dari toko lain). DP = Rp3.800.000.

**Buka:** sidebar → **AP Deposits** (`/ap-deposits`). Klik **+ New**. Form **Bayar Uang Muka ke Supplier**:
- **Supplier**: pilih `CV Sumber Plastik`.
- **Tanggal**: `2026-03-01`.
- **Rujukan dokumen (source_ref)**: `DP Paket Alat Makan Lebaran`.
- **Jumlah**: `3800000`.
- **Akun Uang Muka Pembelian (debit)** dan **Akun Kas/Bank (kredit)** — pilih akun.

Klik **Simpan Deposit**. Baris baru di tabel AP Deposits, status **Belum Dipakai**, Sisa Rp3.800.000. Utang Usaha belum kesentuh — DP ini murni asset (Uang Muka Pembelian), kebalikan dari AR di mana DP jadi liability, karena di sini **supplier** yang "berutang" balik ke kita.

15 Maret 2026: cuma 70 lusin yang beneran bisa dikirim (bukan 100 — supplier kehabisan bahan baku import). Bikin bill-nya lewat **AP Bills**: supplier CV Sumber Plastik, jumlah Rp6.650.000 (70 × Rp95.000), source_ref `Nota Beli #SP-002`, due date otomatis 15 Mar + 21 = 5 April.

**Buka:** `/ap-bills/[id]` bill `SP-002`. Klik **Terapkan DP**. Panel biru **Terapkan DP ke Bill Ini** muncul:
- **Deposit**: pilih `DP Paket Alat Makan Lebaran (sisa 3.800.000)` — **Nominal Diterapkan** otomatis keisi `3800000` (min dari sisa DP dan outstanding bill, di sini dibatasi Rp3.800.000 karena itu lebih kecil dari outstanding Rp6.650.000).
- Ubah manual jadi `2660000` (proporsional 40% dari nilai barang yang beneran dikirim, 70 lusin).
- **Tanggal** `2026-03-15`, **Rujukan dokumen** `Terapkan-DP-SP-002`.
- **Akun Utang Usaha (debit)** dan **Akun Uang Muka Pembelian (kredit)** — pilih akun.

Klik **Terapkan DP**. Hasil: Outstanding bill `SP-002` turun jadi Rp3.990.000 (6.650.000 − 2.660.000), lunasin sisanya lewat AP Payments biasa kalau mau. Sisa DP sekarang Rp1.140.000 (3.800.000 − 2.660.000).

30 lusin sisanya gak jadi dikirim (dibatalkan karena stok bahan baku CV Sumber Plastik beneran habis). CV Sumber Plastik mau balikin sebagian sebagai itikad baik.

**Buka:** `/ap-deposits/[id]` deposit `DP Paket Alat Makan Lebaran`. Sisa Belum Dipakai sekarang Rp1.140.000, 2 tombol muncul: **Refund Tunai** dan **Hanguskan**.

Klik **Refund Tunai** — isi **Nominal Refund (maks 1.140.000)** `800000`, **Tanggal** `2026-03-30`, **Rujukan dokumen** `Refund-DP-SP-002`, **Akun Kas/Bank (debit)** dan **Akun Uang Muka Pembelian (kredit)** — pilih akun. Klik **Refund**.

Sisa deposit sekarang Rp340.000 (1.140.000 − 800.000). Klik **Hanguskan** buat sisanya (dianggap biaya admin yang udah dikeluarkan CV Sumber Plastik, gak dibalikin) — isi **Nominal Hangus (maks 340.000)** `340000`, **Tanggal** `2026-03-30`, **Rujukan dokumen** `Hangus-DP-SP-002`, **Akun Beban Kerugian Uang Muka (debit)** dan **Akun Uang Muka Pembelian (kredit)**. Klik **Hanguskan**.

**Hasil:** deposit `DP Paket Alat Makan Lebaran` sekarang status **Selesai** — total penyelesaian 2.660.000 (diterapkan) + 800.000 (refund) + 340.000 (hangus) = Rp3.800.000, pas nominal DP awal. Beda dari AR: refund di sini **supplier** yang mutusin mau balikin berapa, bukan kita yang nentuin kebijakan sepihak ke customer.

## Skenario 8 — Bill salah input, dibatalkan (PT Plastindo Jaya)

10 April 2026: staff salah input bill duplikat — nota `PJ-001` (Skenario 1) sempat kecatat 2x karena staff kepencet submit dua kali. Bill duplikat ini `PJ-001-dup`, Rp10.267.500, belum ada payment yang dialokasikan ke bill ini.

**Buka:** `/ap-bills/[id]` bill duplikat. Klik tombol **Batalkan Bill** di header (cuma muncul kalau bill belum ada payment). Dialog konfirmasi browser muncul: "Batalkan bill Nota Beli #PJ-001 (Rp10.267.500)? Masukin rujukan dokumen buat entry pembalik:" — isi `Pembatalan bill duplikat PJ-001`, klik OK.

**Hasil:** RPC `cancel_ap_bill` bikin jurnal pembalik — Debit Utang Usaha 10.267.500 | Kredit Persediaan Bahan Baku/Beban Ongkir/PPN Masukan (sesuai baris debit aslinya). Status bill jadi **dibatalkan**, tetap ada di histori (dicoret di tabel). Beda dari AR: guard cancel di AP juga nolak kalau bill udah punya retur (`ap_credit_notes`) — bukan cuma payment — karena bill yang udah kesentuh transaksi retur dianggap "udah dipakai".

## Rekap Cakupan

Semua fitur AP yang ada di sistem sudah dipraktikkan di atas: Suppliers (CRUD), AP Bill (multi-line/kompunding + PPN Masukan), AP Payment (cicilan + anti-overpay, 1 bill per payment), Retur Barang Opsi A (Kurangi Utang, termasuk kasus bill lunas → AP Return Credit), Opsi B (Tukar Barang), Opsi C (Tulis-jadi-Beban/write-off), AP Return Credit (refund tunai), Uang Muka Pembelian (bayar, terapkan, refund tunai, hanguskan — bisa campur ketiganya), dan Batalkan Bill.

## Lanjutan Story

Fase berikutnya (Inventory) yang ngitung stok & HPP dari Goods Receipt yang jadi basis bill-bill di atas (PT Plastindo Jaya, CV Sumber Plastik) — pakai Weighted Average karena harga plastik sering naik-turun ngikutin harga bahan baku minyak bumi.
