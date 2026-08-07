# Story — Accounts Receivable: CV Roti Barokah

Fase 3. Konteks bisnis: `docs/story/company-profile.md`. Konsep: `docs/domain/accounts-receivable.md`. Schema: `docs/architecture/ar-schema.md`. Lanjutan langsung dari `docs/story/general-ledger.md` — entry 7 Juli (Piutang Usaha ke Warung Pak Budi) sekarang dapet identitas customer & jadwal pelunasan.

## Customer (master data)

3 warung langganan CV Roti Barokah, tiap warung punya termin sendiri (kesepakatan Bu Nur):

| Customer | Kontak | `payment_term_days` |
|---|---|---|
| Warung Pak Budi | 0812-xxxx-0001 | 14 (net-14, langganan lama) |
| Warung Bu Imas | 0812-xxxx-0002 | 7 (net-7) |
| Warung Kang Ade | 0812-xxxx-0003 | 7 (net-7) |

Tiap customer juga punya `credit_limit` dan `overdue_threshold_days` (prefill = `payment_term_days` pas dibuat, Bu Nur boleh sesuaikan manual):

| Customer | `credit_limit` | `overdue_threshold_days` |
|---|---|---|
| Warung Pak Budi | Rp1.000.000 (udah pernah telat, Bu Nur ketatin) | 7 (diketatin dari default 14, gara-gara riwayat telat) |
| Warung Bu Imas | Rp2.000.000 | 7 (default) |
| Warung Kang Ade | NULL (belum pernah macet, gak dibatasi) | 7 (default) |

`return_window_days` (toleransi hari boleh ngajuin retur) awalnya `NULL` buat ketiganya (gak dibatasi) — Bu Imas dapet nilai eksplisit belakangan (Oktober 2026, lihat Skenario 14), Pak Budi & Kang Ade tetap `NULL` sampai sekarang.

## Skenario 1 — Invoice awal + lunas tepat waktu (Warung Bu Imas)

10 Juli 2026: kirim roti ke Warung Bu Imas, invoice Rp500.000, `due_date` = 10+7 = **17 Juli 2026**.
Jurnal: Piutang Usaha (D) 500.000 | Pendapatan Penjualan Grosir (K) 500.000

17 Juli 2026: Bu Imas bayar pas Rp500.000.
Jurnal: Kas di Bank (D) 500.000 | Piutang Usaha (K) 500.000
Alokasi: 1 baris, 500.000, penuh ke invoice ini.
Status invoice: **lunas**.

## Skenario 2 — Bayar sebagian / cicil (Warung Kang Ade)

12 Juli 2026: kirim ke Warung Kang Ade, invoice Rp900.000, `due_date` = 12+7 = **19 Juli 2026**.
Jurnal: Piutang Usaha (D) 900.000 | Pendapatan Penjualan Grosir (K) 900.000

19 Juli 2026: Kang Ade baru sanggup bayar Rp500.000.
Jurnal: Kas di Bank (D) 500.000 | Piutang Usaha (K) 500.000. Alokasi: 500.000 ke invoice ini. Status: **sebagian**.

26 Juli 2026: Kang Ade lunasin sisa Rp400.000.
Jurnal: Kas di Bank (D) 400.000 | Piutang Usaha (K) 400.000. Alokasi: 400.000 ke invoice yang sama. Status: **lunas** (500.000+400.000 = 900.000).

## Skenario 3 — Piutang lama, telat bayar (Warung Pak Budi — lanjutan dari `general-ledger.md`)

7 Juli 2026 (sudah tercatat di Fase 2): kirim roti ke Warung Pak Budi, invoice Rp1.200.000, `due_date` = 7+14 = **21 Juli 2026**.
Jurnal (sudah ada): Piutang Usaha (D) 1.200.000 | Pendapatan Penjualan Grosir (K) 1.200.000

Hari ini (30 Juli 2026): **belum ada pembayaran sama sekali**. `due_date` 21 Juli udah lewat 9 hari.
Query aging: `due_date < 2026-07-30 and status != lunas` → invoice ini muncul, **telat 9 hari**, outstanding Rp1.200.000 — kandidat pertama buat ditagih.

## Skenario 4 — Credit hold (Warung Pak Budi, lanjutan Skenario 3)

30 Juli 2026: Warung Pak Budi mau pesan roti lagi, invoice baru Rp300.000 direncanain.

Cek `create_ar_invoice`:
- Outstanding sekarang: Rp1.200.000 (invoice 7 Juli, belum dibayar sepeser pun).
- `credit_limit` Warung Pak Budi = Rp1.000.000 → **Rp1.200.000 > Rp1.000.000, kelampaui.**
- `due_date` invoice 7 Juli = 21 Juli, udah lewat 9 hari. `overdue_threshold_days` = 7 → **9 hari > 7 hari, juga kelampaui.**

Dua kondisi kepenuhi sekaligus (walau cukup salah satu) → RPC nolak, invoice Rp300.000 gak jadi dibuat lewat jalur AR. Bu Nur tetap mau kirim roti hari itu, tapi minta Pak Budi bayar cash di tempat — dicatat sebagai penjualan tunai biasa (Debit Kas Rp300.000, Kredit Pendapatan Rp300.000), gak lewat `ar_invoices`, gak nambah piutang.

Bandingin sama Toko Melati (hipotetis, `credit_limit` Rp5.000.000 tapi ada 1 invoice telat 25 hari sementara `overdue_threshold_days`-nya 14) — outstanding-nya kecil dan jauh di bawah limit, tapi tetap kena hold karena syarat **waktu** aja udah cukup jadi trigger.

## Efek ke saldo Piutang Usaha per 30 Juli 2026

| Customer | Invoice | Dibayar | Outstanding | Status |
|---|---|---|---|---|
| Warung Bu Imas | 500.000 | 500.000 | 0 | Lunas |
| Warung Kang Ade | 900.000 | 900.000 | 0 | Lunas |
| Warung Pak Budi | 1.200.000 | 0 | 1.200.000 | **Telat 9 hari** |

Total saldo akun `Piutang Usaha` di General Ledger per 30 Juli 2026: **Rp1.200.000** (cuma sisa Warung Pak Budi — dua yang lain udah lunas, ke-nol-in lewat jurnal pelunasan masing-masing).

## Skenario 5 — Retur, financial-only (Warung Kang Ade, lanjutan Skenario 2)

5 September 2026: sebagian roti dari invoice 12 Juli (Rp900.000, udah lunas sejak 26 Juli) ternyata rusak, nilai Rp50.000. Warung Kang Ade minta dikurangin.

RPC retur dipanggil dengan `invoice_id` invoice 12 Juli. Cek: invoice ini gak punya baris `goods_issues` (dibuat sebelum modul Inventory ada) → **jalur financial-only**.

Jurnal:
```
Debit Retur & Potongan Penjualan   50.000
  Kredit Piutang Usaha                    50.000
```

Piutang Usaha Kang Ade: 900.000 (invoice) − 900.000 (bayar lunas) − 50.000 (retur) = **−50.000** (saldo kredit — Bu Nur "berutang" 50.000 ke Kang Ade, penanganannya belum di-scope — beda dari kelebihan bayar payment yang udah di-scope di "AR Customer Credit", ini dari retur yang bikin outstanding negatif).

## Skenario 6 — Retur, full/stok+HPP (Warung Pak Budi, lanjutan `docs/story/inventory.md` Tahap 7)

Basis: 25 Agustus 2026, Pak Budi beli 30 Roti Tawar @Rp2.000 = Rp60.000 lewat `create_goods_issue`, HPP 30×Rp1.300 = Rp39.000 dari `inventory_balances` Roti Tawar (`docs/story/inventory.md`).

28 Agustus 2026: 3 dari 30 roti apek, Pak Budi balikin. RPC retur dipanggil, `qty_returned = 3`. Cek: invoice ini punya baris `goods_issues` → **jalur full**.

Cost per unit asli = 39.000 / 30 = Rp1.300/buah (snapshot, bukan harga sekarang). Nominal retur = 3 × (60.000/30) = Rp6.000. Cost retur = 3 × 1.300 = Rp3.900.

Jurnal:
```
Debit Retur & Potongan Penjualan   6.000
  Kredit Piutang Usaha                    6.000

Debit Persediaan Barang Jadi       3.900
  Kredit Harga Pokok Penjualan            3.900
```

3 buah Roti Tawar masuk balik ke `inventory_balances` (bukan lot baru — konsep lot udah gak ada sejak FIFO dihapus): qty_before 20, avg_before Rp1.300 → qty_after 20+3 = **23**, avg_after = (20×1.300 + 3×1.300) / 23 = **Rp1.300** (kebetulan avg-nya gak berubah, karena unit cost retur ini persis sama dengan avg_cost yang berlaku saat itu — bukan aturan umum, kalau unit cost retur beda dari avg saat ini pasti avg_after ikut bergeser). Piutang Usaha Pak Budi: 60.000 (invoice, belum dibayar) − 6.000 (retur) = **54.000 outstanding**. Persediaan Roti Tawar: 23 buah @ Rp1.300 = **Rp29.900**.

**Catatan realitas baru:** dulu (waktu FIFO masih ada), 3 roti apek yang diretur ini masuk sebagai lot terpisah (`source_type = SALES_RETURN`) supaya gak ketuker pas ada penukaran garansi berikutnya (Skenario 6b). Sekarang gak ada lagi konsep lot — 3 roti apek ini langsung campur jadi 1 pool `inventory_balances` bareng 20 roti baik yang tersisa, gak ada segregasi sama sekali. Ini keterbatasan yang sudah diketahui & dicatat terpisah di `memory/scope-debt/kerugian-barang-rusak.md` (barang rusak yang diretur harusnya diakui sebagai Beban Kerugian, bukan balik jadi stok bernilai) — bukan hal yang diselesaikan di sini, cuma dicatat sebagai konsekuensi baru dari penghapusan FIFO.

## Skenario 6b — Penukaran barang pasca-retur/garansi (Pak Budi, lanjutan Skenario 6)

29 Agustus 2026: Pak Budi minta ganti 3 roti fresh buat gantiin 3 roti apek kemarin — bukan cuma potongan tagihan, dia tetap mau 30 roti utuh buat dijual. Bu Nur setuju (garansi kualitas), kirim 3 Roti Tawar baru dari stok aktif. Ini penukaran, bukan hadiah — Pak Budi tetap harus bayar penuh nilai 30 roti baik, cuma gak ada invoice baru buat 3 roti pengganti ini.

RPC penukaran dipanggil dengan `credit_note_id` = credit note Skenario 6. Cek: credit note itu punya `inventory_returns` (jalur full) → boleh lanjut. Cek qty: 3 diminta ≤ 3 yang diretur di credit note itu → lolos.

3 roti diambil dari `inventory_balances` Roti Tawar — pool tunggal 23 buah @ avg Rp1.300, **bukan** "stok fresh terpisah dari lot retur" lagi, karena gak ada lot sama sekali (lihat catatan realitas di Skenario 6: 3 roti apek udah campur ke pool yang sama). Cost = 3 × Rp1.300 = **Rp3.900**.

Jurnal cost:
```
Debit Harga Pokok Penjualan (HPP)   3.900
  Kredit Persediaan Barang Jadi            3.900
```

**Diskon retur Skenario 6 dibalik** (fix `0037` — sebelum fix ini, Pak Budi dapat diskon Rp6.000 DAN 3 roti pengganti gratis sekaligus, kompensasi ganda): qty ditukar (3) = seluruh qty yang diretur di credit note itu (3), jadi reversal-nya **penuh** — porsi cost retur yang ditukar (3×1.300=3.900) dibagi total cost retur di credit note itu (3.900) = 100% dari diskon Rp6.000 (jumlah reversal-nya sama kayak sebelum FIFO dihapus, karena proporsinya tetap 100% — cuma angka cost dasarnya yang beda).
```
Debit Piutang Usaha                 6.000
  Kredit Retur & Potongan Penjualan        6.000
```

Piutang Usaha Pak Budi: 54.000 (outstanding pasca-retur Skenario 6) + 6.000 (diskon dibalik) = **60.000 outstanding** — balik ke nilai invoice penuh, karena akhirnya Pak Budi diganti barang (bukan didiskon). Persediaan Roti Tawar: 23 (sisa Skenario 6) − 3 (keluar buat ganti) = **20 buah** @ Rp1.300 = Rp26.000 — balik ke qty yang sama kayak sebelum retur terjadi, tapi sekarang gak ada jejak lot mana yang "asli" vs "pengganti" — semua udah 1 pool campur, konsisten sama catatan di Skenario 6.

## Uang Muka / DP — customer baru (pesanan custom, bukan warung langganan)

Selain 3 warung langganan di atas (kirim rutin, termin), CV Roti Barokah kadang terima **pesanan custom** (kue ulang tahun/pernikahan) dari perorangan — beda pola dari warung: bayar DP di muka pas pesan, sisanya dilunasin pas ambil.

| Customer | Kontak | `payment_term_days` | `credit_limit` | `overdue_threshold_days` |
|---|---|---|---|---|
| Ibu Dewi | 0812-xxxx-0004 | 7 (default, jarang kepake — pelunasan biasanya langsung pas ambil) | NULL | NULL |
| Pak Joko | 0812-xxxx-0005 | 7 (default) | NULL | NULL |

## Skenario 7 — DP diterima & diterapkan penuh ke invoice (Ibu Dewi, kue ulang tahun custom)

28 Desember 2026: Ibu Dewi pesan kue ulang tahun custom Rp2.000.000, rencana ambil 10 Januari 2027. Bayar DP Rp500.000 di muka.
Jurnal: Kas di Bank (D) 500.000 | Uang Muka Penjualan (K) 500.000. Piutang Usaha & Pendapatan belum kesentuh.

10 Januari 2027: kue jadi & diambil. Invoice diterbitkan **penuh** Rp2.000.000.
Jurnal: Piutang Usaha (D) 2.000.000 | Pendapatan Penjualan Toko (K) 2.000.000

DP langsung diterapkan ke invoice ini:
Jurnal: Uang Muka Penjualan (D) 500.000 | Piutang Usaha (K) 500.000
Outstanding: 2.000.000 − 500.000 = **1.500.000**.

15 Januari 2027: Ibu Dewi lunasin sisa Rp1.500.000 (`record_ar_payment` biasa, gak ada yang beda).
Jurnal: Kas di Bank (D) 1.500.000 | Piutang Usaha (K) 1.500.000. Status invoice: **lunas**.

## Skenario 8 — DP hangus, order dibatalin sebelum invoice ada (Pak Joko, kue pernikahan custom)

2 Januari 2027: Pak Joko pesan kue pernikahan custom Rp3.000.000, bayar DP Rp1.000.000 di muka. Bahan khusus (fondant custom) langsung dibeli Bu Nur hari itu juga.
Jurnal: Kas di Bank (D) 1.000.000 | Uang Muka Penjualan (K) 1.000.000

5 Januari 2027: acara pernikahannya batal, Pak Joko batalin pesanan. Belum ada invoice yang pernah dibuat sama sekali (kuenya belum jadi). Sesuai kebijakan Bu Nur, DP gak direfund (bahan udah kadung dibeli) — dicatat hangus.
Jurnal: Uang Muka Penjualan (D) 1.000.000 | **Pendapatan Lain-lain** (K) 1.000.000

Catatan: ini **bukan** Pendapatan Penjualan Toko — gak ada roti/kue yang kejual, ini kompensasi pembatalan.

## Skenario 9 — Invoice dengan DP-application ternyata salah input, dibatalkan (Ibu Dewi, pesanan kedua)

20 Januari 2027: Ibu Dewi pesan kue custom kedua, harga seharusnya Rp1.000.000. Bayar DP Rp300.000 di muka.
Jurnal: Kas di Bank (D) 300.000 | Uang Muka Penjualan (K) 300.000

25 Januari 2027: kue jadi. Staff yang input invoice **salah ketik nominal** — kepencet Rp1.800.000, bukan Rp1.000.000.
Jurnal (salah): Piutang Usaha (D) 1.800.000 | Pendapatan Penjualan Toko (K) 1.800.000

DP Rp300.000 langsung diterapkan ke invoice yang salah ini:
Jurnal: Uang Muka Penjualan (D) 300.000 | Piutang Usaha (K) 300.000. Outstanding (masih salah): 1.500.000.

Bu Nur cek ulang nota, ketauan invoice-nya keliru. `cancel_ar_invoice` dipanggil — RPC ini **otomatis membalikkan 2 jurnal sekaligus**:
```
Reversal invoice:            Pendapatan Penjualan Toko (D) 1.800.000 | Piutang Usaha (K) 1.800.000
Reversal DP-application:     Piutang Usaha (D) 300.000              | Uang Muka Penjualan (K) 300.000
```
Hasil akhir: Piutang Usaha customer ini balik ke **0**, Uang Muka Penjualan balik ke **300.000** (DP-nya otomatis kebuka lagi, status "belum dipakai") — persis kondisi sebelum invoice yang salah itu dibuat, gak ada yang nyangkut.

Invoice yang benar (Rp1.000.000) diterbitkan ulang, DP Rp300.000 yang sama diterapkan lagi ke invoice baru ini. Outstanding: 700.000.

## Skenario 10 — Kelebihan bayar jadi saldo kredit (Warung Bu Imas)

28 Agustus 2026 (setelah periode Jan-25 Agustus 2026 ditutup, lihat `docs/story/financial-reports.md`): kirim roti ke Warung Bu Imas, invoice Rp700.000, `due_date` 4 September (net-7).
Jurnal: Piutang Usaha (D) 700.000 | Pendapatan Penjualan Grosir (K) 700.000

2 September 2026: Bu Imas transfer **Rp750.000** (salah baca nominal). Gak ada invoice lain outstanding buat Bu Imas. Payment dicatat 1 event, dialokasikan Rp700.000 penuh ke invoice ini, sisa Rp50.000 gak punya invoice buat nyantol → jadi saldo kredit.
Jurnal (1 payment event, 3 baris):
```
Kas di Bank (D) 750.000
  Piutang Usaha (K) 700.000
  Saldo Kredit Customer (K) 50.000
```
Status invoice: **lunas**. Saldo kredit Bu Imas: **Rp50.000** (belum dipakai).

## Skenario 11 — Saldo kredit dipakai motong invoice berikutnya (Bu Imas, lanjutan Skenario 10)

5 September 2026: Bu Imas pesan lagi, invoice Rp300.000, `due_date` 12 September.
Jurnal: Piutang Usaha (D) 300.000 | Pendapatan Penjualan Grosir (K) 300.000

Bu Nur inget Bu Imas ada saldo kredit Rp50.000, dipakai motong invoice ini duluan:
Jurnal: Saldo Kredit Customer (D) 50.000 | Piutang Usaha (K) 50.000. Outstanding invoice jadi Rp250.000. Saldo kredit Bu Imas: **Rp0** (habis terpakai).

10 September 2026: Bu Imas transfer sisa Rp250.000 pas.
Jurnal: Kas di Bank (D) 250.000 | Piutang Usaha (K) 250.000. Status invoice: **lunas**.

(Kalau Bu Imas minta saldo kreditnya di-refund tunai alih-alih dipakai: Saldo Kredit Customer (D) 50.000 | Kas di Bank (K) 50.000 — jurnal alternatif, gak dipakai di skenario ini.)

## Skenario 12 — Piutang tak tertagih (write-off), pesanan custom yang kabur (Bu Rina)

Selain Ibu Dewi & Pak Joko (yang selalu bayar DP di muka), 1 Februari 2027 ada pesanan custom dari **Bu Rina** (0812-xxxx-0006, referral dari Ibu Dewi) — kue ulang tahun anak Rp1.500.000. Karena referral dari langganan yang udah dipercaya, Bu Nur bikin pengecualian: kirim langsung hari itu juga **tanpa minta DP**. `payment_term_days` default 7 (`due_date` 8 Februari 2027), `credit_limit`/`overdue_threshold_days` NULL (customer baru, gak dibatasi — sama pola Ibu Dewi/Pak Joko).

Jurnal: Piutang Usaha (D) 1.500.000 | Pendapatan Penjualan Toko (K) 1.500.000

Setelah due date lewat, Bu Nur follow-up berkali-kali lewat WhatsApp — gak pernah dibales. Bulan berikutnya nomornya udah gak aktif, alamat yang dikasih pas pesan ternyata gak ditemuin. Ditunggu sampai **1 Juni 2027** (4 bulan sejak jatuh tempo), gak ada respons sama sekali — Bu Nur mutusin piutang ini gak akan pernah tertagih.

RPC `write_off_ar_invoice` dipanggil: `invoice_id` = invoice Bu Rina, `writeoff_date = 2027-06-01`, `amount = 1.500.000` (penuh — belum ada payment/retur/DP/kredit apa pun yang nyentuh invoice ini, jadi sisa outstanding riilnya emang penuh Rp1.500.000).

Jurnal:
```
Debit Beban Piutang Tak Tertagih   1.500.000
  Kredit Piutang Usaha                    1.500.000
```

Piutang Usaha Bu Rina: 1.500.000 (invoice) − 1.500.000 (write-off) = **0 outstanding**. Status invoice berubah dari **belum** jadi **dihapusbukukan** — beda dari **lunas** (piutang ini gak pernah beneran dibayar, cuma diakui hilang). Pendapatan Penjualan Toko 1.500.000 dari 1 Februari **tetap berdiri** gak dibalik — penjualannya beneran kejadian, cuma piutangnya yang gak bisa dicairkan. Laba Rugi periode Juni 2027 kena beban baru Rp1.500.000 (bukan periode Februari saat penjualan awal terjadi).

## Skenario 13 — Saldo kredit dari retur (Warung Kang Ade, lanjutan Skenario 5)

5 September 2026 (Skenario 5): retur Rp50.000 dari Warung Kang Ade, invoice 12 Juli (Rp900.000) udah lunas penuh sejak 26 Juli. Waktu itu, outstanding invoice-nya jadi **-50.000** — Bu Nur "berutang" ke Kang Ade, tapi belum ada mekanisme resmi buat mencairkannya (gap yang baru ditutup fitur ini).

Begitu fitur ini ada, `create_ar_credit_note` otomatis mendeteksi: sisa outstanding sebelum retur ini = 0 (invoice udah lunas penuh), nominal retur 50.000 — semuanya jadi excess. Jurnal reklasifikasi otomatis kebentuk:
```
Debit Piutang Usaha                50.000
  Kredit Saldo Kredit Retur Customer      50.000
```
1 baris `ar_return_credits` lahir: Kang Ade punya saldo Rp50.000, siap dipakai/direfund.

10 September 2026: Kang Ade gak ada rencana order lagi dalam waktu dekat, minta uangnya balik langsung daripada nunggu dipakai motong tagihan berikutnya. RPC `refund_ar_return_credit` dipanggil:
```
Debit Saldo Kredit Retur Customer  50.000
  Kredit Kas di Bank                      50.000
```
Saldo kredit retur Kang Ade: **Rp0** (habis, direfund tunai).

*(Catatan implementasi: karena retur Kang Ade ini sendiri terjadi SEBELUM fitur AR Return Credit dibangun — tercatat pas fitur retur pertama kali dibuat, jauh sebelum gap ini disadari — jurnal reklasifikasi & baris `ar_return_credits` di atas di-backfill manual lewat migration seed, bukan otomatis dari `create_ar_credit_note` versi lama. Kejadian bisnisnya tetap sama: excess Rp50.000, tanggal yang sama, cuma jalur teknisnya beda dari retur yang terjadi SETELAH fitur ini ada.)*

## Skenario 14 — Batas retur per customer (Warung Bu Imas)

1 Oktober 2026: Bu Nur mulai kerepotan nge-track retur yang diajukan lama banget setelah roti dikirim — barangnya udah pasti gak layak tapi customer tetap nagih potongan. Bu Nur mutusin kasih kebijakan eksplisit ke Warung Bu Imas: `return_window_days = 14` (customer lain dibiarin `NULL`/gak dibatasi dulu, belum jadi masalah buat mereka).

`update customers set return_window_days = 14 where name = 'Warung Bu Imas'` — cuma ngaruh ke invoice **baru** Bu Imas ke depan (snapshot ke `ar_invoices.return_window_days` pas dibuat), gak retroaktif ke invoice lama dia (Skenario 1, 10, 11) yang `return_window_days`-nya tetap `NULL` (dibuat sebelum kebijakan ini ada).

**Uji kasus (ditolak)**: seandainya Bu Imas coba ngajuin retur Rp30.000 di 1 Oktober 2026 buat invoice 28 Agustus 2026 (Skenario 10, Rp700.000) — invoice itu dibuat **sebelum** kebijakan 14 hari berlaku, jadi `ar_invoices.return_window_days`-nya `NULL`, dan retur ini **tetap diterima** (gak ada batas). Tapi kalau invoice itu **seandainya** dibuat setelah 1 Oktober (jadi udah ke-snapshot 14 hari), retur di hari ke-34 bakal ditolak: `raise exception` sebelum jurnal apa pun dibuat, pesan jelas nyebut telat 20 hari dari batas.

*(Skenario ini sengaja gak dieksekusi sebagai SQL nyata di migration seed — bakal gagalin transaksi migration kalau beneran dijalanin sampai exception. Cukup didokumentasikan naratif, sama pola skenario credit hold Pak Budi di atas.)*

## Simulasi Interface (rencana)

Setelah schema (`ar-schema.md`) dibangun + migration diterapkan, web app bakal punya halaman `/customers` (CRUD customer + termin), `/ar-invoices` (list + form bikin invoice, otomatis hitung `due_date`), `/ar-payments` (form bayar dengan pilih 1+ invoice outstanding buat dialokasikan, validasi gak boleh over-allocate — plus tampilin sisa Rp yang jadi saldo kredit kalau ada excess), dan `/ar-deposits` (catat DP masuk + aksi terapkan ke invoice/hanguskan). Saldo kredit customer (pakai/refund) menyusul di halaman customer detail atau inline di `/ar-invoices`, pola sama tombol "Terapkan DP". Aksi "Hapusbukukan" (write-off) inline di `/ar-invoices/[id]`, sama pola tombol "Retur"/"Terapkan DP" — cuma muncul kalau invoice masih ada outstanding & belum dibatalkan. Halaman `/ar-return-credits` (list+detail, pola sama `/ar-customer-credits`) buat saldo kredit yang lahir dari retur negatif — lahir otomatis, gak ada form "bikin baru". Detail flow menyusul pas fase UI dikerjakan.

## Lanjutan Story

Fase berikutnya (Accounts Payable) bakal kebalikannya — CV Barokah yang berutang ke 2 supplier tepung/gula (entry 10 Juli di `general-ledger.md`, Utang Usaha), pola invoice/payment/allocation-nya bakal mirror AR ini dari sisi utang.
