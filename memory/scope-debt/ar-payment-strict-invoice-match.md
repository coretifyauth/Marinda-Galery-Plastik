# AR — Payment Wajib Persis 1 Invoice (No Partial, No Combine, No Overpay-to-Credit)

**Modul asal:** Accounts Receivable (Fase 3, sudah live). **Status:** Ditunda.

## Kasus

Keputusan bisnis baru (2026-08-07): customer **gak boleh bayar sembarangan** — tiap payment wajib persis cocok sama 1 invoice yang ada (gak kurang, gak lebih). Ini kebalikan total dari desain AR yang jalan sekarang, yang sengaja mendukung 3 hal:

1. **1 payment nutup banyak invoice sekaligus** — warung transfer sekali buat nutup beberapa invoice kiriman minggu itu.
2. **1 invoice dilunasi lewat beberapa payment (cicilan)** — dibayar bertahap di waktu berbeda.
3. **Kelebihan bayar diserap jadi saldo kredit customer** — bukan ditolak, dicatat ke `ar_customer_credits` buat dipakai nutup invoice berikutnya.

Ketauan lewat diskusi nelusurin alur kerja AR yang ada — user sengaja milih versi paling ketat ("Versi B") setelah dikasih 2 opsi (A: cuma larang overpay-jadi-saldo-bebas, B: wajib 1:1 penuh).

## Kenapa ditunda

Nerapin ini **bukan nambah fitur, tapi bongkar & hapus** struktur yang udah dipakai production:

- `ar_payment_allocations` (jembatan many-to-many payment↔invoice) jadi gak relevan sama sekali kalau wajib 1:1 — perlu dihapus total, `ar_payments` ganti punya `invoice_id` langsung + constraint `amount` = persis sisa invoice itu.
- Trigger `ar_payment_allocations_no_over_allocation` ikut dihapus (gak ada lagi konsep "alokasi" buat dijaga).
- 3 tabel keluarga overpayment (`ar_customer_credits`, `ar_customer_credit_applications`, `ar_customer_credit_refunds`) dihapus total — `record_ar_payment` harus `raise exception` keras kalau `amount` gak persis sama sisa invoice, bukan nerima kelebihan dan nyimpennya.
- RPC `record_ar_payment` (`0027_ar_customer_credits.sql`) perlu ditulis ulang total: param `p_allocations` (jsonb array) diganti `p_invoice_id` tunggal, param `p_customer_credit_account_id` hilang.
- Seed demo yang udah ada (`0008_seed_demo_ar.sql`, `0025_seed_demo_ar_deposits.sql`, `0028_seed_demo_ar_customer_credits.sql`) mensimulasikan skenario cicilan/gabung-bayar/overpayment — semuanya jadi ilegal di aturan baru, perlu ditinjau ulang atau dihapus.
- Narasi bisnis yang udah ditulis di `docs/domain/accounts-receivable.md` bagian "Kenapa Butuh Tabel Alokasi" secara eksplisit bilang 3 skenario ini nyata terjadi di CV Barokah — dokumen itu perlu direvisi bareng migration, bukan dibiarin nyebut skenario yang udah dilarang.
- Interaksi `cancel_ar_invoice`/DP-application/return-credit yang sekarang loop "unwind semua alokasi aktif" (lihat `memory/architecture/data/ar-schema.md`) perlu ditinjau ulang juga — logic-nya diasumsikan alokasi bisa banyak, kalau wajib 1:1 sebagian logic itu jadi mati/perlu disederhanakan.

Belum digarap karena butuh ERD ulang dulu (proses `new-feature`/non-negotiable `AGENTS.md`: bahas dampak ke modul lain dulu sebelum ubah schema), dan karena ini perubahan **mundur** (hapus fleksibilitas yang udah dipakai), bukan nambah — resikonya beda dari fitur baru biasa: data histori (payment yang udah nyicil/gabung) perlu diputuskan nasibnya (biarin apa adanya sebagai "data lama", atau dipaksa migrasi).

## Referensi

- `docs/domain/accounts-receivable.md` — bagian "Kenapa Butuh Tabel Alokasi" (skenario yang mau dihapus)
- `memory/architecture/data/ar-schema.md` — DDL `ar_payment_allocations`, `ar_customer_credits`, RPC `record_ar_payment`
