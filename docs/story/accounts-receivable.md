# Story — Accounts Receivable: CV Roti Barokah

Fase 3. Konteks bisnis: `docs/story/company-profile.md`. Konsep: `docs/domain/accounts-receivable.md`. Schema: `docs/architecture/ar-schema.md`. Lanjutan langsung dari `docs/story/general-ledger.md` — entry 7 Juli (Piutang Usaha ke Warung Pak Budi) sekarang dapet identitas customer & jadwal pelunasan.

## Customer (master data)

3 warung langganan CV Roti Barokah, tiap warung punya termin sendiri (kesepakatan Bu Nur):

| Customer | Kontak | `payment_term_days` |
|---|---|---|
| Warung Pak Budi | 0812-xxxx-0001 | 14 (net-14, langganan lama) |
| Warung Bu Imas | 0812-xxxx-0002 | 7 (net-7) |
| Warung Kang Ade | 0812-xxxx-0003 | 7 (net-7) |

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

## Efek ke saldo Piutang Usaha per 30 Juli 2026

| Customer | Invoice | Dibayar | Outstanding | Status |
|---|---|---|---|---|
| Warung Bu Imas | 500.000 | 500.000 | 0 | Lunas |
| Warung Kang Ade | 900.000 | 900.000 | 0 | Lunas |
| Warung Pak Budi | 1.200.000 | 0 | 1.200.000 | **Telat 9 hari** |

Total saldo akun `Piutang Usaha` di General Ledger per 30 Juli 2026: **Rp1.200.000** (cuma sisa Warung Pak Budi — dua yang lain udah lunas, ke-nol-in lewat jurnal pelunasan masing-masing).

## Simulasi Interface (rencana)

Setelah schema (`ar-schema.md`) dibangun + migration diterapkan, web app bakal punya halaman `/customers` (CRUD customer + termin), `/ar-invoices` (list + form bikin invoice, otomatis hitung `due_date`), dan `/ar-payments` (form bayar dengan pilih 1+ invoice outstanding buat dialokasikan, validasi gak boleh over-allocate). Detail flow menyusul pas fase UI dikerjakan.

## Lanjutan Story

Fase berikutnya (Accounts Payable) bakal kebalikannya — CV Barokah yang berutang ke 2 supplier tepung/gula (entry 10 Juli di `general-ledger.md`, Utang Usaha), pola invoice/payment/allocation-nya bakal mirror AR ini dari sisi utang.
