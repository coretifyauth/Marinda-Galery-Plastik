# Pembayaran — Struktur Data

Pelunasan piutang dan pelunasan utang disimpan di 1 tabel generic `payments`, dibedakan kolom arah (`type`: `OUTBOUND` = piutang berkurang, `INBOUND` = utang berkurang) — mirror pola tabel induknya, `transactions` (lihat `docs/architecture/transactions-schema.md`). Baca `docs/domain/accounts-receivable.md` (bagian "AR Payment") dan `docs/domain/accounts-payable.md` (bagian pelunasan utang) buat konteks lengkap. Detail teknis penuh (DDL/trigger/RPC persis) ada di `supabase/migrations/0016_payments_schema.sql`, plus `0054_payment_rounding.sql` (metode bayar + selisih pembulatan, lihat section "Selisih Pembulatan Pelunasan" di bawah).

> **Migration final (2026-09-07):** `supabase/migrations/0016_payments_schema.sql` -- konsolidasi dari migration incremental lama (0001-0084, sudah dihapus). Nomor migration `00XX` yang disebut di seluruh dokumen ini HISTORIS (isinya tetap akurat sebagai catatan evolusi keputusan, lihat `git log` kalau perlu baca file aslinya) -- SQL final yang AKTIF di database sekarang ada di file yang disebut di atas.

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
| `type` | `OUTBOUND` (pelunasan piutang) / `INBOUND` (pelunasan utang) | Pembeda arah jurnal — OUTBOUND: Debit Kas, Kredit Piutang; INBOUND: Debit Utang, Kredit Kas |
| `counterparty_id` | Pihak yang membayar/dibayar | `OUTBOUND` wajib pihak berperan pelanggan, `INBOUND` wajib pihak berperan pemasok |
| `transaction_id` | Invoice/tagihan spesifik yang dilunasi | Wajib nunjuk 1 transaksi tertentu — **gak ada bayar gabungan** untuk beberapa invoice/tagihan sekaligus |
| `payment_date` | Tanggal pembayaran diterima/dilakukan | — |
| `amount` | Nilai yang **melunasi** transaksi kali ini (dikurangkan dari sisa tagihan) | Boleh kurang dari sisa tagihan (cicil), **gak boleh lebih** (overpay ditolak). Sejak `0054` bisa beda dari uang riil yang pindah — selisihnya di `rounding_amount` |
| `payment_method` | `TUNAI` / `BANK` — cara uang berpindah | Fakta yang dicatat saat bayar (sejak `0054`); sumber akun kas (lewat Default Akun `cash.tunai`/`cash.bank`) dan satuan pembulatan. NULL cuma baris lama yang akun kasnya gak bisa dipetakan |
| `rounding_amount` | Selisih pembulatan dari sudut pandang perusahaan | `+` = Pendapatan Selisih Pembulatan, `−` = Beban Selisih Pembulatan, `0` = gak ada. Uang riil = `amount + rounding_amount` (OUTBOUND) / `amount − rounding_amount` (INBOUND) |
| `cash_tendered`, `change_given` | Uang diterima & kembalian yang diserahkan | Cuma kasir POS metode TUNAI, NULL di jalur lain. Selalu berpasangan, kembalian ≤ uang diterima |
| `journal_entry_id` | Jurnal yang tercipta bareng pembayaran ini | Setiap pembayaran wajib punya 1 jurnal pendamping |

Sama seperti `transactions`, baris `payments` **gak bisa diubah atau dihapus** setelah tersimpan — bersifat permanen begitu tercatat.

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Catat pelunasan piutang | `record_payment('OUTBOUND', ..., p_payment_method, ...)` | Insert 1 baris `payments` + 1 jurnal (Debit Kas/Bank, Kredit Piutang Usaha, + baris selisih pembulatan kalau ada) sekaligus, lewat fungsi inti `_post_payment` | Nilai bayar gak boleh melebihi sisa piutang riil (`ar_invoice_remaining`), kecuali pelunasan dengan pembulatan — dicek sebelum jurnal apa pun dibuat |
| Catat pelunasan utang | `record_payment('INBOUND', ..., p_payment_method, ...)` | Insert 1 baris `payments` + 1 jurnal (Debit Utang Usaha, Kredit Kas/Bank, + baris selisih pembulatan kalau ada) sekaligus, lewat `_post_payment` | Nilai bayar gak boleh melebihi sisa utang riil (`ap_bill_remaining`), kecuali pelunasan dengan pembulatan — dicek sebelum jurnal apa pun dibuat |

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

## Selisih Pembulatan Pelunasan

Konsep bisnisnya: `docs/domain/accounts-payable.md` submodule "Selisih Pembulatan Pelunasan" (AR mirror di `accounts-receivable.md`, kasir di `pos.md` submodule "Kembalian & Selisih Pembulatan Kasir"). SQL: `supabase/migrations/0054_payment_rounding.sql`.

**Peta Data (ERD)**

Gak ada tabel baru. Perubahan:

| Objek | Perubahan | Terhubung ke |
|---|---|---|
| `payments` | +4 kolom: `payment_method`, `rounding_amount`, `cash_tendered`, `change_given` (lihat tabel struktur di atas) | — (gak ada FK baru) |
| `app_settings` | +2 kolom: `rounding_unit_cash` (default 100), `rounding_unit_bank` (default 1) | lihat `app-settings-schema.md` |
| `accounts` | +2 akun template: `4500` Pendapatan Selisih Pembulatan (revenue), `6300` Beban Selisih Pembulatan (expense) — baris data, bukan tabel | lihat `coa-schema.md` |
| `app_default_account_settings` | +2 role: `rounding.revenue`, `rounding.expense` | lihat `default-account-settings-schema.md` |

Keputusan desain terpenting: **`payments.amount` gak berubah arti** — tetap "nilai yang melunasi transaksi". Karena itu semua yang membaca `amount` (`ar_invoice_remaining`/`ap_bill_remaining`, `recompute_transaction_status`, `void_pos_transaction`, `cancel_*`, view status) tetap benar tanpa diubah. Uang riil diturunkan dari `amount ± rounding_amount`, dan tercatat di baris kas jurnalnya.

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Satuan pembulatan per metode | `payment_rounding_unit(method)` | Baca `rounding_unit_cash`/`rounding_unit_bank` dari `app_settings` | NULL kalau metode gak valid/aplikasi belum di-setup — pemanggil menolak |
| Inti pencatatan (dipakai bersama) | `_post_payment(...)` | Insert `payments` + 1 jurnal: sisi kontrol (Piutang/Utang) = nilai pelunasan, sisi kas = uang riil (baris dilewati kalau Rp0), selisih ke akun `rounding.revenue` (untung) / `rounding.expense` (rugi). Akun kas diturunkan dari metode bayar lewat Default Akun | Nilai pelunasan > 0 dan ≤ sisa tagihan; rugi selalu < satuan metode; untung < satuan kecuali jalur kasir tunai; tanpa metode bayar (row outbox POS lama) wajib tanpa selisih |
| Catat pelunasan AR/AP | `record_payment(p_type, p_counterparty_id, p_payment_date, p_amount, p_source_ref, p_payment_method, p_control_account_id, p_transaction_id)` | `p_amount` = uang riil. Sama dengan sisa → biasa; sama dengan sisa dibulatkan ke bawah/atas ke kelipatan satuan → **lunas** + selisih; kurang → cicilan | Lebih dari sisa (selain pembulatan ke atas) ditolak; Rp0 cuma sah kalau sisa < satuan (sisa receh lama ditutup tanpa uang) |
| Checkout kasir | `create_pos_sale(..., p_payment_method, p_cash_tendered, p_change_given)` | Lihat `pos-schema.md` section "Kembalian & Selisih Pembulatan Kasir" | — |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Bill/invoice tetap sesuai nota, pembulatan cuma di pelunasan | Gak ada perubahan di `create_transaction`; pembulatan hanya di `record_payment`/`create_pos_sale` |
| Yang dicatat selalu uang riil | `p_amount` = uang riil; baris kas jurnal = uang riil |
| Satuan pembulatan dari metode bayar, bukan dari akun | `payment_method` disimpan; satuan dari `app_settings`; akun kas diturunkan dari metode (bukan sebaliknya) |
| 2 akun terpisah, bukan netto | `rounding.revenue` dan `rounding.expense` — role Default Akun terpisah |
| Selisih ikut terbalik kalau pembayaran dibalik | Baris pembulatan ada di jurnal pembayaran yang sama (`journal_entry_id`) |
| Selisih besar bukan pembulatan | Pagar "rugi < satuan" & "untung < satuan (non-kasir)" di `_post_payment` |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `payments.payment_method` | menentukan (lewat role `cash.tunai`/`cash.bank`) | akun kas di `journal_lines` pembayaran |
| `payments.rounding_amount` | dijurnal ke (lewat role `rounding.revenue`/`rounding.expense`) | `journal_lines` pembayaran yang sama |
| `record_payment`/`create_pos_sale` | baca konfigurasi, gak ada FK | `app_settings.rounding_unit_*` |

Data lama: `payment_method` baris yang sudah ada di-backfill sekali dari akun kas di jurnalnya (satu-satunya tempat akun dipakai menurunkan metode — data historis memang gak pernah menyimpan metodenya; akun yang dipetakan ke kedua role dibiarkan NULL).

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat daftar pembayaran (piutang & utang) | Semua user yang sudah login |
| Mencatat pembayaran baru | Role `admin` atau `accountant` |
| Mengubah atau menghapus pembayaran yang sudah tercatat | **Tidak ada seorang pun** — pembayaran bersifat permanen begitu tersimpan |
