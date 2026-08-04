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

## Simulasi Interface (rencana)

Setelah schema (`ar-schema.md`) dibangun + migration diterapkan, web app bakal punya halaman `/customers` (CRUD customer + termin), `/ar-invoices` (list + form bikin invoice, otomatis hitung `due_date`), dan `/ar-payments` (form bayar dengan pilih 1+ invoice outstanding buat dialokasikan, validasi gak boleh over-allocate). Detail flow menyusul pas fase UI dikerjakan.

## Lanjutan Story

Fase berikutnya (Accounts Payable) bakal kebalikannya — CV Barokah yang berutang ke 2 supplier tepung/gula (entry 10 Juli di `general-ledger.md`, Utang Usaha), pola invoice/payment/allocation-nya bakal mirror AR ini dari sisi utang.
