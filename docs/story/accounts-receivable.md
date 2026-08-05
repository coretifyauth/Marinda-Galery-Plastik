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

Piutang Usaha Kang Ade: 900.000 (invoice) − 900.000 (bayar lunas) − 50.000 (retur) = **−50.000** (saldo kredit — Bu Nur "berutang" 50.000 ke Kang Ade, penanganannya belum di-scope, lihat `memory/scope-debt/ar-overpayment-saldo-kredit.md`).

## Skenario 6 — Retur, full/stok+HPP (Warung Pak Budi, lanjutan `docs/story/inventory.md` Tahap 7)

Basis: 25 Agustus 2026, Pak Budi beli 30 Roti Tawar @Rp2.000 = Rp60.000 lewat `create_goods_issue`, HPP 30×Rp1.250 = Rp37.500 dari Lot #P1 (`docs/story/inventory.md`).

28 Agustus 2026: 3 dari 30 roti apek, Pak Budi balikin. RPC retur dipanggil, `qty_returned = 3`. Cek: invoice ini punya baris `goods_issues` → **jalur full**.

Cost per unit asli = 37.500 / 30 = Rp1.250/buah (snapshot, bukan harga sekarang). Nominal retur = 3 × (60.000/30) = Rp6.000. Cost retur = 3 × 1.250 = Rp3.750.

Jurnal:
```
Debit Retur & Potongan Penjualan   6.000
  Kredit Piutang Usaha                    6.000

Debit Persediaan Barang Jadi       3.750
  Kredit Harga Pokok Penjualan            3.750
```

3 buah Roti Tawar masuk lot baru (`source_type = SALES_RETURN`, `unit_cost = 1.250`). Piutang Usaha Pak Budi: 60.000 (invoice, belum dibayar) − 6.000 (retur) = **54.000 outstanding**. Persediaan Roti Tawar: 20 (sisa Tahap 7) + 3 (retur) = **23 buah**.

## Skenario 6b — Penggantian barang gratis pasca-retur (Pak Budi, lanjutan Skenario 6)

29 Agustus 2026: Pak Budi minta ganti 3 roti fresh buat gantiin 3 roti apek kemarin — bukan cuma potongan tagihan, dia tetap mau 30 roti utuh buat dijual. Bu Nur setuju (garansi kualitas), kirim 3 Roti Tawar baru dari stok aktif.

RPC penggantian dipanggil dengan `credit_note_id` = credit note Skenario 6. Cek: credit note itu punya `inventory_returns` (jalur full) → boleh lanjut. Cek qty: 3 diminta ≤ 3 yang diretur di credit note itu → lolos.

3 roti diambil dari stok fresh (FIFO, lot aktif sisa Tahap 7, **bukan** lot `SALES_RETURN` yang baru masuk dari retur kemarin — roti apek gak dipakai ganti lagi). Cost tetap Rp1.250/buah.

Jurnal:
```
Debit Harga Pokok Penjualan (HPP)   3.750
  Kredit Persediaan Barang Jadi            3.750
```

Gak ada jurnal ke Piutang Usaha atau Pendapatan — Piutang Usaha Pak Budi tetap **54.000 outstanding** (gak berubah dari Skenario 6). Persediaan Roti Tawar: 23 (sisa Skenario 6) − 3 (keluar buat ganti) = **20 buah** — balik ke jumlah yang sama kayak sebelum retur terjadi, tapi sekarang 3 di antaranya adalah roti pengganti baru, bukan 3 yang lama.

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

## Simulasi Interface (rencana)

Setelah schema (`ar-schema.md`) dibangun + migration diterapkan, web app bakal punya halaman `/customers` (CRUD customer + termin), `/ar-invoices` (list + form bikin invoice, otomatis hitung `due_date`), `/ar-payments` (form bayar dengan pilih 1+ invoice outstanding buat dialokasikan, validasi gak boleh over-allocate), dan `/ar-deposits` (catat DP masuk + aksi terapkan ke invoice/hanguskan). Detail flow menyusul pas fase UI dikerjakan.

## Lanjutan Story

Fase berikutnya (Accounts Payable) bakal kebalikannya — CV Barokah yang berutang ke 2 supplier tepung/gula (entry 10 Juli di `general-ledger.md`, Utang Usaha), pola invoice/payment/allocation-nya bakal mirror AR ini dari sisi utang.
