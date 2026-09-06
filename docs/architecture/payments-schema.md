# Pembayaran — Struktur Data

Pelunasan piutang dan pelunasan utang disimpan di 1 tabel generic `payments`, dibedakan kolom arah (`type`: `INBOUND` = piutang berkurang, `OUTBOUND` = utang berkurang) — mirror pola tabel induknya, `transactions` (lihat `docs/architecture/transactions-schema.md`). Baca `docs/domain/accounts-receivable.md` (bagian "AR Payment") dan `docs/domain/accounts-payable.md` (bagian pelunasan utang) buat konteks lengkap. Detail teknis penuh (DDL/trigger/RPC persis) ada di `memory/architecture/data/payments-schema.md`.

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `payments` | 1 baris = 1 pembayaran (piutang berkurang atau utang berkurang) | `counterparties`, `transactions`, `journal_entries` |

## Konsep Inti

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `payments` | Nilai yang dibayar, pihak terkait, transaksi (invoice/tagihan) yang dilunasi | `counterparties.id`, `transactions.id`, `journal_entries.id` |

**Struktur `payments` (kolom yang penting buat dipahami)**

| Kolom | Isinya | Catatan |
|---|---|---|
| `type` | `INBOUND` (pelunasan piutang) / `OUTBOUND` (pelunasan utang) | Pembeda arah jurnal — INBOUND: Debit Kas, Kredit Piutang; OUTBOUND: Debit Utang, Kredit Kas |
| `counterparty_id` | Pihak yang membayar/dibayar | `INBOUND` wajib pihak berperan pelanggan, `OUTBOUND` wajib pihak berperan pemasok |
| `transaction_id` | Invoice/tagihan spesifik yang dilunasi | Wajib nunjuk 1 transaksi tertentu — **gak ada bayar gabungan** untuk beberapa invoice/tagihan sekaligus |
| `payment_date` | Tanggal pembayaran diterima/dilakukan | — |
| `amount` | Nilai yang dibayar kali ini | Boleh kurang dari sisa tagihan (cicil), **gak boleh lebih** (overpay ditolak) |
| `journal_entry_id` | Jurnal yang tercipta bareng pembayaran ini | Setiap pembayaran wajib punya 1 jurnal pendamping |

Sama seperti `transactions`, baris `payments` **gak bisa diubah atau dihapus** setelah tersimpan — bersifat permanen begitu tercatat.

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Catat pelunasan piutang | `record_payment('INBOUND', ...)` | Insert 1 baris `payments` + 1 jurnal (Debit Kas/Bank, Kredit Piutang Usaha) sekaligus | Nilai bayar gak boleh melebihi sisa piutang riil (`ar_invoice_remaining`) — dicek sebelum jurnal apa pun dibuat |
| Catat pelunasan utang | `record_payment('OUTBOUND', ...)` | Insert 1 baris `payments` + 1 jurnal (Debit Utang Usaha, Kredit Kas/Bank) sekaligus | Nilai bayar gak boleh melebihi sisa utang riil (`ap_bill_remaining`) — dicek sebelum jurnal apa pun dibuat |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Pembayaran boleh dicicil (kurang dari sisa tagihan), 1 invoice/tagihan boleh dibayar berkali-kali dari waktu ke waktu | `record_payment` gak mensyaratkan `amount` sama dengan sisa tagihan — status "sebagian" tetap sah |
| Overpay ditolak keras — gak ada kelebihan bayar yang jadi saldo mengambang | `record_payment` memvalidasi `amount` terhadap `ar_invoice_remaining`/`ap_bill_remaining` sebelum insert, `raise exception` kalau lebih |
| Pembayaran wajib nunjuk 1 invoice/tagihan spesifik, gak ada bayar gabungan lintas transaksi | Kolom `transaction_id` wajib diisi, RPC cuma menerima 1 target per pemanggilan |
| Salah pilih pihak (bayar piutang tapi pihak ternyata pemasok, atau sebaliknya) gak boleh lolos | Guard peran pihak (`counterparty_role_guard`) sama seperti di `transactions` |
| Status invoice/tagihan (lunas/sebagian/belum) selalu dihitung ulang, bukan diisi manual | Tiap pembayaran baru otomatis memicu `recompute_transaction_status` lewat trigger |
| Pembayaran yang sudah tercatat gak boleh diedit/dihapus | RLS gak ada policy update/delete + trigger penjaga kedua (`block_edit_delete`) |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `payments.counterparty_id` | banyak-ke-satu | `counterparties` |
| `payments.transaction_id` | banyak-ke-satu | `transactions` (`transactions-schema.md`) |
| `payments.journal_entry_id` | satu-ke-satu | `journal_entries` |

## Konsistensi Arah Pembayaran

Kolom `payments.type` sebenarnya nilainya bisa diturunkan dari `transactions.type` milik `transaction_id`-nya (1 transaksi cuma punya 1 arah), tapi tetap disimpan langsung di `payments` supaya guard peran pihak dan perhitungan sisa tagihan gak perlu selalu JOIN balik ke `transactions`. Konsekuensinya: sistem butuh 1 pengaman tambahan biar 2 kolom ini gak pernah beda sendiri-sendiri.

**Peta Data (ERD)**

Gak ada tabel baru — ini soal 1 kolom (`payments.type`) yang isinya harus selalu senada dengan `transactions.type` di baris yang ditunjuk `transaction_id`.

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Simpan pembayaran baru | (bagian dari `record_payment` / insert ke `payments`) | — | Ditolak kalau `type` yang dikirim gak sama dengan `type` milik transaksi yang ditunjuk `transaction_id` — mencegah kombinasi yang lolos dari guard peran pihak tapi sebenarnya salah arah |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Pembayaran gak boleh tercatat dengan arah yang gak nyambung sama transaksi aslinya | Trigger konsistensi tipe, jalan sebelum insert, terpisah dari guard peran pihak |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `payments.type` | harus senada dengan | `transactions.type` (lewat `transaction_id`) |

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat daftar pembayaran (piutang & utang) | Semua user yang sudah login |
| Mencatat pembayaran baru | Role `admin` atau `accountant` |
| Mengubah atau menghapus pembayaran yang sudah tercatat | **Tidak ada seorang pun** — pembayaran bersifat permanen begitu tersimpan |
