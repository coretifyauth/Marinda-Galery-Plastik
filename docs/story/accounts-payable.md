# Story — Accounts Payable: CV Roti Barokah

Fase 4. Konteks bisnis: `docs/story/company-profile.md`. Konsep: `docs/domain/accounts-payable.md`. Schema: `docs/architecture/ap-schema.md` (menyusul). Lanjutan langsung dari `docs/story/general-ledger.md` — entry 10 Juli (Utang Usaha ke supplier tepung & gula) sekarang dapet identitas supplier & jadwal pelunasan, sama kayak Warung Pak Budi di sisi AR.

## Supplier (master data)

2 supplier bahan baku langganan CV Roti Barokah, termin ditentuin **supplier**, bukan Bu Nur (kebalikan dari AR):

| Supplier | Kontak | `payment_term_days` |
|---|---|---|
| Toko Tepung Makmur | 022-xxxx-1001 | 14 (net-14) |
| Toko Gula Sejahtera | 022-xxxx-1002 | 7 (net-7, supplier lebih kecil, termin lebih ketat) |

## Skenario 1 — Bill lunas tepat waktu (Toko Gula Sejahtera)

12 Juli 2026: ambil gula dari Toko Gula Sejahtera, bill Rp300.000, `due_date` = 12+7 = **19 Juli 2026**.
Jurnal: Persediaan Bahan Baku (D) 300.000 | Utang Usaha (K) 300.000

19 Juli 2026: Barokah bayar pas Rp300.000.
Jurnal: Utang Usaha (D) 300.000 | Kas di Bank (K) 300.000
Status bill: **lunas**.

## Skenario 2 — Bayar sebagian / cicil (Toko Tepung Makmur)

15 Juli 2026: ambil tepung tambahan, bill Rp1.000.000, `due_date` = 15+14 = **29 Juli 2026**.
Jurnal: Persediaan Bahan Baku (D) 1.000.000 | Utang Usaha (K) 1.000.000

20 Juli 2026: Barokah baru sanggup bayar Rp600.000.
Jurnal: Utang Usaha (D) 600.000 | Kas di Bank (K) 600.000. Status: **sebagian**.

27 Juli 2026: lunasin sisa Rp400.000 (2 hari sebelum due).
Jurnal: Utang Usaha (D) 400.000 | Kas di Bank (K) 400.000. Status: **lunas**.

## Skenario 3 — Bayar gabungan ke 1 supplier (Toko Gula Sejahtera)

3 bill kecil, ambil gula 3x dalam seminggu:
- 20 Juli: Rp100.000
- 22 Juli: Rp80.000
- 24 Juli: Rp90.000

27 Juli 2026: Barokah bayar sekali Rp270.000 buat nutup ketiganya.
1 payment, 1 jurnal (Utang Usaha (D) 270.000 | Kas di Bank (K) 270.000), 3 baris alokasi.
Ketiga bill sekarang lunas.

*(Catatan: skenario ini sebelumnya 1 payment lewat tabel jembatan `ap_payment_allocations`, 3 baris alokasi ke 3 bill sekaligus — "bayar gabungan". Migration `0011_ap_payment_single_bill.sql` (2026-08-08) mencabut kemampuan itu demi selaras filosofi AR: payment sekarang wajib nunjuk 1 bill spesifik. Skenario yang sama sekarang jadi 3 payment terpisah — 27 Juli 2026: Rp100.000 ke bill 20 Juli, Rp80.000 ke bill 22 Juli, Rp90.000 ke bill 24 Juli, masing-masing 1 jurnal sendiri — hasil akhirnya identik (ketiga bill lunas, total kas keluar Rp270.000), cuma jejak transaksinya 3 baris bukan 1.)*

## Skenario 4 — Bill lama, telat bayar (Toko Tepung Makmur — lanjutan dari `general-ledger.md`)

10 Juli 2026 (sudah tercatat di Fase 2): ambil tepung & gula dari Toko Tepung Makmur, bill Rp800.000, `due_date` = 10+14 = **24 Juli 2026**.
Jurnal (sudah ada): Persediaan Bahan Baku (D) 800.000 | Utang Usaha (K) 800.000

Hari ini (30 Juli 2026): **belum ada pembayaran sama sekali**. `due_date` 24 Juli udah lewat 6 hari.
Query aging: `due_date < 2026-07-30 and status != lunas` → bill ini muncul, **telat 6 hari**, outstanding Rp800.000. Beda dari aging di AR — di sini maknanya "bill yang HARUS segera dibayar", bukan "piutang yang harus ditagih". Resikonya: Toko Tepung Makmur bisa nahan kiriman tepung berikutnya kalau makin lama gak dibayar.

## Skenario 5 — Bill salah input, dibatalkan (Toko Gula Sejahtera)

24 Juli 2026: bill Rp50.000 ke Toko Gula Sejahtera ternyata salah input (dobel catat dari bill Rp90.000 di skenario 3).
Belum ada payment yang dialokasikan ke bill ini, jadi bisa langsung dibatalkan via RPC `cancel_ap_bill` — reversing entry: Utang Usaha (D) 50.000 | Persediaan Bahan Baku (K) 50.000. Bill asli tetap ada di histori, status jadi **dibatalkan**, keluar dari daftar outstanding.

## Efek ke saldo Utang Usaha per 30 Juli 2026

| Supplier | Bill | Dibayar | Outstanding | Status |
|---|---|---|---|---|
| Toko Gula Sejahtera | 300.000 | 300.000 | 0 | Lunas |
| Toko Tepung Makmur | 1.000.000 | 1.000.000 | 0 | Lunas |
| Toko Gula Sejahtera | 270.000 (3 bill gabungan) | 270.000 | 0 | Lunas |
| Toko Tepung Makmur | 800.000 | 0 | 800.000 | **Telat 6 hari** |
| Toko Gula Sejahtera | 50.000 | - | 0 | Dibatalkan |

Total saldo akun `Utang Usaha` di General Ledger per 30 Juli 2026: **Rp800.000** (cuma sisa Toko Tepung Makmur — sama pola kayak AR yang nyisain Rp1.200.000 dari Warung Pak Budi, dua-duanya kebetulan berasal dari entry 7 & 10 Juli yang udah ada sebelum modul AR/AP dibangun).

## Skenario 6 — Retur (Opsi A: kurangi utang), bill belum lunas (Toko Gula Sejahtera)

Lanjutan cerita cross-modul dari `docs/story/inventory.md` Tahap 3 (8 Agustus 2026: GRN+Bill 20kg Gula Pasir @ Rp13.000 = Rp260.000, due **15 Agustus 2026**, item-tracked lewat GRN — jadi retur ini lewat **jalur full**).

29 Agustus 2026: Barokah cek ulang stok, 4kg dari kiriman itu ternyata basah kena air pas disimpan. Toko Gula Sejahtera setuju **kurangi tagihan** (Opsi A). Nilai retur = 4kg × avg_cost Gula Pasir saat itu (**Rp12.500/kg**, angka terakhir dari `inventory.md` Tahap 5/6) = **Rp50.000**.

Jurnal: `Debit Utang Usaha 50.000 / Kredit Persediaan Bahan Baku 50.000` — **tanpa akun kontra** (beda dari AR, lihat `docs/domain/accounts-payable.md`).

Efek: Utang Usaha bill ini turun dari Rp260.000 → **Rp210.000** (bill masih belum dibayar sama sekali). `inventory_balances` Gula Pasir: qty_on_hand 39kg → **35kg** (avg_cost tetap Rp12.500/kg, konsumsi gak ngubah rata-rata).

## Skenario 7 — Retur (Opsi A), bill udah lunas penuh → jadi Piutang Retur Supplier (Toko Gula Sejahtera)

Pakai bill lama **Skenario 1** di atas (12 Juli 2026, Rp300.000, **lunas** 19 Juli 2026) — bill ini dibuat sebelum modul Inventory ada, jadi **gak ada GRN**, retur lewat **jalur financial-only**.

30 Agustus 2026: setelah dinego ulang, Toko Gula Sejahtera setuju potong Rp50.000 dari nota lama itu karena sebagian kualitasnya kurang bagus. Karena bill ini udah lunas (outstanding = Rp0), seluruh Rp50.000 jadi **excess**:

1. Jurnal retur (tetap jalan dulu): `Debit Utang Usaha 50.000 / Kredit Persediaan Bahan Baku 50.000` → Utang Usaha bill ini jadi **minus Rp50.000**.
2. Jurnal reklasifikasi otomatis (excess = Rp50.000, karena `sisa_outstanding_sebelum_retur = 0`): `Debit Piutang Retur Supplier 50.000 / Kredit Utang Usaha 50.000` → Utang Usaha balik ke **Rp0**, `ap_return_credits` baru: **Rp50.000** (akun asset `1350`, Toko Gula Sejahtera "berutang" balik ke Barokah).

## Skenario 8 — Retur (Opsi B: tukar barang), independen dari status bayar (Toko Gula Sejahtera)

Lanjutan Tahap 5 di `inventory.md` (20 Agustus 2026: GRN+Bill 20kg Gula Pasir @ Rp12.000 = Rp240.000, due **27 Agustus 2026**, **belum dibayar**).

31 Agustus 2026: 3kg dari kiriman ini juga basah. Kali ini Toko Gula Sejahtera pilih **ganti barang langsung** (Opsi B) buat jaga hubungan baik, bukan kurangi tagihan. Nilai = 3kg × Rp12.500 = **Rp37.500**.

Jurnal: `Debit Persediaan Bahan Baku 37.500 (gula baru) / Kredit Persediaan Bahan Baku 37.500 (gula rusak)` — **net nol**, **Utang Usaha bill ini tetap penuh Rp240.000** (gak berubah sama sekali, Barokah tetap wajib bayar penuh pas jatuh tempo 27 Agustus). `inventory_balances` Gula Pasir: 3kg keluar + 3kg masuk → qty_on_hand tetap **35kg**, avg_cost tetap Rp12.500/kg.

## Skenario 9 & 10 — Piutang Retur Supplier dipakai sebagian + dicairkan sebagian (Toko Gula Sejahtera)

2 September 2026: Barokah beli lagi 10kg Gula Pasir dari Toko Gula Sejahtera, bill baru Rp120.000 (due 9 September). Saldo `ap_return_credits` dari **Skenario 7** (Rp50.000) dipakai **sebagian**:

- **Diterapkan Rp30.000** ke bill baru ini: `Debit Utang Usaha 30.000 / Kredit Piutang Retur Supplier 30.000` → sisa utang bill baru jadi **Rp90.000** (masih harus dibayar cash/transfer biasa).
- **Sisa Rp20.000 dicairkan tunai**: `Debit Kas di Bank 20.000 / Kredit Piutang Retur Supplier 20.000`.

Saldo `ap_return_credits` dari Skenario 7 sekarang **habis** (Rp30.000 + Rp20.000 = Rp50.000, pas nominal awalnya) — guard no-over-use mencegah dipakai/dicairkan lebih dari itu.

## Simulasi Interface (rencana)

Sama pola AR: setelah schema (`ap-schema.md`) dibangun + migration diterapkan, web app bakal punya halaman `/suppliers` (CRUD supplier + termin), `/ap-bills` (list + form bikin bill, pilih akun debit manual — Persediaan atau Beban tergantung jenis pembelian), dan `/ap-payments` (form bayar dengan pilih 1+ bill outstanding buat dialokasikan). Detail flow menyusul pas fase UI dikerjakan.

## Lanjutan Story

Fase berikutnya (Inventory) bakal mulai ngitung HPP roti dari bahan baku yang udah dicatat di sini (Persediaan Bahan Baku dari bill Tepung Makmur & Gula Sejahtera) jadi barang jadi — butuh weighted average karena harga tepung naik-turun (`company-profile.md`).
