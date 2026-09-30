# Transaksi (Piutang & Utang) — Struktur Data

Piutang timbul dan utang timbul disimpan di 1 tabel generic `transactions`, dibedakan kolom arah (`type`: `OUTBOUND` = piutang, `INBOUND` = utang). Baca `docs/domain/accounts-receivable.md` (Piutang) dan `docs/domain/accounts-payable.md` (Utang) buat konteks bisnis lengkap; detail teknis penuh (DDL/trigger/RPC persis) ada di `supabase/migrations/0015_transactions_schema.sql`.

> **Migration final (2026-09-07):** `supabase/migrations/0015_transactions_schema.sql` -- konsolidasi dari migration incremental lama (0001-0084, sudah dihapus). Nomor migration `00XX` yang disebut di seluruh dokumen ini HISTORIS (isinya tetap akurat sebagai catatan evolusi keputusan, lihat `git log` kalau perlu baca file aslinya) -- SQL final yang AKTIF di database sekarang ada di file yang disebut di atas.

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `transactions` | Piutang timbul (`type='OUTBOUND'`) atau utang timbul (`type='INBOUND'`) — 1 baris = 1 invoice/tagihan | `counterparties`, `journal_entries` |
| `transaction_lines` | Baris kategori tambahan (dan PPN) di dalam 1 transaksi | `transactions`, `accounts` |
| `charge_categories` | Katalog kategori tambahan (kolom `module`: `ar`=pendapatan piutang, `ap`=beban utang, `pos`=checkout kasir) | `accounts` |

## Konsep Inti

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `transactions` | Nilai transaksi, pihak terkait, jatuh tempo, sisa tagihan, status | `counterparties.id`, `journal_entries.id` |
| `transaction_lines` | Baris kategori VARIABEL (pendapatan tambahan atau beban tambahan) + baris PPN, per transaksi | `transactions.id`, `accounts.id` |

**Struktur `transactions` (kolom yang penting buat dipahami)**

| Kolom | Isinya | Catatan |
|---|---|---|
| `type` | `OUTBOUND` (piutang) / `INBOUND` (utang) | Satu-satunya pembeda arah; menentukan debit/kredit mana yang kena Piutang Usaha vs Utang Usaha |
| `counterparty_id` | Pihak terkait | `OUTBOUND` wajib pihak berperan pelanggan, `INBOUND` wajib pihak berperan pemasok — dicek otomatis, gak bisa salah pilih |
| `date` / `due_date` | Tanggal transaksi & jatuh tempo | `due_date` dihitung sekali dari termin pembayaran pihak terkait **saat transaksi dibuat**, disimpan sebagai snapshot — kalau terminnya berubah belakangan, transaksi lama gak ikut geser |
| `amount` | Nilai total transaksi | Harus lebih dari 0 |
| `outstanding` / `returned` | Sisa tagihan riil / total nilai retur | Kolom turunan, dihitung ulang otomatis tiap ada kejadian yang mempengaruhi (pembayaran, retur, dst) — gak pernah diisi manual |
| `status` | lunas / sebagian / belum / dibatalkan | Turunan juga, gak pernah di-set manual |
| `origin` | `financial_only` / `order` / `goods_movement` | Asal-usul transaksi: murni catatan finansial, lahir dari Order (SO/PO), atau dari pergerakan barang fisik di luar Order |
| `supplier_document_ref` | Nomor nota asli dari supplier | Cuma keisi kalau `type='INBOUND'` — satu-satunya kolom yang cuma relevan untuk salah satu arah, sisanya sama struktur antara piutang dan utang |
| `journal_entry_id` | Jurnal yang tercipta bareng transaksi ini | Setiap transaksi wajib punya 1 jurnal pendamping |
| `discount_amount` | Total diskon yang sudah baked-in ke `amount` | Murni breakdown tampilan (subtotal/diskon/total) — TIDAK dipakai `create_transaction` buat menghitung ulang saldo jurnal, `p_lines` yang dikirim ke situ sudah net dari awal. OUTBOUND: akumulasi diskon per baris (`promotion-item-discount-rules-schema.md`). INBOUND: nominal manual admin saat bikin Bill/Goods Receipt |

Transaksi **gak bisa diubah atau dihapus** setelah tersimpan (sama seperti Jurnal Umum) — koreksi salah input pakai jurnal pembalik, bukan edit langsung.

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Buat piutang baru (invoice ke customer) | `create_transaction('OUTBOUND', ...)` | Insert 1 baris `transactions` + baris kategori di `transaction_lines` + 1 jurnal (Debit Piutang Usaha, Kredit Pendapatan) sekaligus dalam 1 transaksi database | Minimal 1 baris kategori, tiap baris nilainya harus lebih dari 0; pihak tujuan wajib berperan pelanggan |
| Buat utang baru (tagihan dari supplier) | `create_transaction('INBOUND', ...)` | Sama seperti di atas, arah jurnal kebalik (Debit Beban/Persediaan, Kredit Utang Usaha) | Sama seperti di atas, pihak tujuan wajib berperan pemasok |
| Hitung PPN otomatis | Bagian dari `create_transaction` (kalau diminta) | Tarif PPN diambil dari pengaturan pajak di sistem, ditambahkan ke Piutang/Utang Usaha — gak pernah dipercaya dari input form | — |
| Batalkan piutang yang salah input | `cancel_ar_invoice` | Bikin jurnal pembalik (akun sama, debit/kredit ketuker) + otomatis membalik jurnal uang muka yang masih aktif ke invoice itu | Ditolak kalau invoice udah punya pembayaran apa pun — gak bisa dibatalkan lewat jalur ini, harus jalur lain. **Belum ada guard retur maupun guard goods-movement (Goods Issue)** — lihat `memory/scope-debt/cancel-ar-invoice-goods-movement-guard.md` |
| Batalkan utang yang salah input | `cancel_ap_bill` | Bikin jurnal pembalik (akun sama, debit/kredit ketuker) | Ditolak kalau tagihan udah punya pembayaran, ATAU udah punya retur (credit note) apa pun, ATAU berasal dari penerimaan barang (GRN) -- barang yang udah masuk stok gak boleh "dihapus" utangnya tanpa lewat Retur AP (sebelumnya cuma peringatan manual di tutorial) |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Piutang timbul = 1 jurnal Debit Piutang Usaha / Kredit Pendapatan; utang timbul = kebalikannya | `create_transaction`, arah ditentukan parameter `p_type` |
| Jatuh tempo dihitung sekali dari termin pihak terkait saat transaksi dibuat, gak ikut berubah kalau termin berubah belakangan | Kolom `due_date` diisi sebagai snapshot oleh RPC, bukan dihitung ulang tiap dibaca |
| Salah pilih pihak (pilih pemasok di form piutang, atau sebaliknya) gak boleh lolos | Guard peran pihak (`counterparty_role_guard`) — OUTBOUND wajib pelanggan, INBOUND wajib pemasok, dicek di level database |
| Tidak ada mekanisme Credit Hold (tolak invoice baru kalau customer kelewat batas kredit) | Gak ada pengecekan ini di `create_transaction`; gak ada kolom batas kredit di data pelanggan |
| Tidak ada mekanisme Piutang Tak Tertagih (write-off) | Gak ada jalur RPC untuk ini di sistem |
| Staf gak bebas pilih akun pembukuan buat kategori tambahan, harus dari daftar yang disiapkan admin | Katalog `charge_categories` (lihat submodule "Kategori Tambahan & PPN") |
| Transaksi yang sudah tersimpan gak boleh diedit/dihapus, cuma boleh dibalik | RLS gak ada policy update/delete + trigger penjaga kedua (`transactions_block_edit_delete_or_sync` — bolehkan UPDATE cuma kolom turunan `outstanding`/`returned`/`status`/`origin`, blok sekutu dan perubahan kolom bisnis inti, pola sama kayak `orders`/`deposits`) |
| Pembatalan transaksi harus tetap tertelusur ke dokumen aslinya | `cancel_ar_invoice`/`cancel_ap_bill` gak menghapus/mengubah baris asli — cuma menambah jurnal pembalik baru |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `transactions.counterparty_id` | banyak-ke-satu | `counterparties` |
| `transactions.journal_entry_id` | satu-ke-satu | `journal_entries` |
| `transaction_lines.transaction_id` | banyak-ke-satu | `transactions` |
| `transaction_lines.account_id` | banyak-ke-satu | `accounts` |
| `payments.transaction_id` (`payments-schema.md`) | banyak-ke-satu | `transactions` |
| `returns.transaction_id` (`returns-schema.md`) | banyak-ke-satu | `transactions` |
| `deposit_applications.transaction_id` (`deposits-schema.md`) | banyak-ke-satu | `transactions` |

## Kategori Tambahan & PPN

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `charge_categories` | Daftar kategori tambahan yang boleh dipakai di form piutang/utang/kasir (kolom `module`: `ar`/`ap`/`pos`) | `accounts` |

Katalog ini murni data master buat mengisi dropdown di form — gak ada relasi kunci asing (foreign key) dari `transaction_lines` balik ke sini. Begitu staf pilih kategori di dropdown, yang dikirim ke `create_transaction` cuma `account_id` mentahnya, sama seperti pola satuan barang (`item_units`) di modul Inventory. Dulu 3 tabel terpisah per module (satu per AR/AP/POS) — digabung jadi 1 tabel karena strukturnya identik, dibedakan kolom `module` saja.

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Tambah/ubah kategori pendapatan atau beban tambahan | — (insert/update langsung ke katalog) | Kategori baru muncul di dropdown form transaksi | RLS: cuma role `admin` |
| Nonaktifkan kategori lama | — (isi tanggal arsip) | Kategori gak lagi muncul di dropdown, tapi transaksi lama yang sudah memakainya tetap utuh | Gak ada penghapusan permanen — arsip saja |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Staf gak boleh mengetik/pilih akun pembukuan bebas untuk kategori tambahan | Dropdown cuma menampilkan isi katalog ini (difilter `module`); RPC tetap cuma menerima `account_id`, gak ada validasi tambahan di server soal "boleh gak akun ini dipakai" — kedisiplinan ada di level UI + admin yang mengelola katalog |
| Kategori pendapatan dan kategori beban gak pernah tertukar formnya | Difilter kolom `module` (`ar`/`ap`/`pos`) — satu muncul di form piutang, satu di form utang, satu di checkout kasir, gak pernah campur |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `charge_categories.account_id` | banyak-ke-satu | `accounts` |

## Sisa Tagihan & Status

**Peta Data (ERD)**

Gak ada tabel baru — bagian ini menjelaskan bagaimana kolom turunan `transactions.outstanding`, `transactions.returned`, dan `transactions.status` dihitung ulang otomatis.

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Hitung sisa piutang riil 1 invoice | `ar_invoice_remaining` | Nilai invoice dikurangi pembayaran, dikurangi retur, dikurangi uang muka yang masih aktif dipakai, ditambah balik saldo kredit dari retur yang belum dipakai | — (fungsi baca saja) |
| Hitung sisa utang riil 1 tagihan | `ap_bill_remaining` | Sama seperti di atas, versi utang | — (fungsi baca saja) |
| Perbarui status & kolom turunan 1 transaksi | `recompute_transaction_status` | Menghitung ulang `outstanding`/`returned`/`status`/`origin` dan menyimpannya balik ke baris `transactions` | Dipanggil otomatis lewat trigger tiap ada kejadian baru (pembayaran, retur, uang muka, dst) yang menyentuh transaksi itu — staf gak pernah memicunya manual |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Status invoice/tagihan (lunas/sebagian/belum) selalu dihitung ulang dari data riil, bukan status yang diisi manual | `recompute_transaction_status`, dipicu otomatis oleh trigger di semua tabel yang mempengaruhinya |
| Pembayaran boleh dicicil, gak boleh melebihi sisa tagihan (overpay ditolak) | `ar_invoice_remaining`/`ap_bill_remaining` dipakai `record_payment` (`payments-schema.md`) sebagai batas atas sebelum jurnal dibuat |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `recompute_transaction_status` | dipicu oleh insert di | `payments`, `returns`, `deposit_applications`, `goods_notes`, `goods_note_lines` (`replacements` TIDAK memicu ini — ganti/tukar barang gak pernah menyentuh status/outstanding transaksi asalnya sama sekali, lihat `replacements-schema.md`) |
| `ar_invoice_remaining`/`ap_bill_remaining` | membaca | `transactions`, `payments`, `returns`, `deposit_applications`, `return_credits` |

## Tampilan Terpisah untuk Piutang & Utang

Walau datanya sekarang 1 tabel fisik (`transactions`), sistem tetap menyediakan 2 tampilan (view) terpisah — `ar_invoices_with_status` (piutang) dan `ap_bills_with_status` (utang) — supaya layar dan laporan yang sudah ada gak perlu diubah sama sekali. Ini murni soal cara baca data, bukan struktur baru; keduanya cuma menyaring `transactions` berdasar `type`.

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat daftar transaksi (piutang & utang) | Semua user yang sudah login |
| Membuat transaksi baru (piutang atau utang) | Role `admin` atau `accountant` |
| Mengubah atau menghapus transaksi yang sudah tersimpan | **Tidak ada seorang pun** — koreksi cuma lewat pembatalan (jurnal pembalik), bukan edit langsung |
| Mengelola katalog kategori tambahan (pendapatan/beban) | Role `admin` |
