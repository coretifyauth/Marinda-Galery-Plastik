# Counterparty — Struktur Data & Teknis

Cross-cutting, bukan bagian dari 1 modul tunggal — dipakai bareng Piutang (AR), Utang (AP), Inventory (Order beli/jual), dan Kios (POS). Gak ada `docs/domain/counterparty.md` tersendiri — konsep bisnis "pelanggan" dan "pemasok" tetap dijelaskan di `docs/domain/accounts-receivable.md` dan `docs/domain/accounts-payable.md` masing-masing; halaman ini murni menjelaskan bagaimana KEDUANYA sekarang disimpan di 1 struktur data yang sama di baliknya. Detail teknis penuh (DDL/trigger/RPC): `memory/architecture/data/counterparty-schema.md`.

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `counterparties` | Master data 1 pihak — pelanggan dan pemasok dalam 1 tabel yang sama | — |
| `counterparty_type_mapping` | Peran pihak itu (pelanggan dan/atau pemasok) — 1 pihak boleh punya lebih dari 1 peran sekaligus | `counterparties` |

## Konsep Inti

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `counterparties` | Nama, kontak, termin pembayaran, plus batas kredit & toleransi telat (cuma relevan buat peran pelanggan) | — |
| `counterparty_type_mapping` | 1 baris per peran yang dimiliki 1 pihak | `counterparties` |

"Pelanggan" dan "pemasok" disimpan di 1 tabel yang sama karena strukturnya nyaris identik (cuma beda 2 kolom yang emang cuma relevan buat pelanggan), dan supaya 1 pihak yang sama bisa berperan pelanggan DAN pemasok sekaligus tanpa harus dicatat sebagai 2 entitas berbeda dengan ID berbeda.

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Daftarkan pihak baru | Fungsi pembuatan pihak (1 pemanggilan) | Catat data pihak + perannya (pelanggan atau pemasok) dalam 1 transaksi — gak mungkin ada pihak yang tercatat tanpa peran apa pun | — |
| Hapus pihak | Fungsi hapus pihak | Hapus permanen kalau pihak itu belum pernah dipakai di transaksi manapun; kalau sudah pernah, otomatis diarsipkan (dinonaktifkan) alih-alih gagal total | Ditolak hard-delete kalau masih ada transaksi historis yang menunjuk pihak ini |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Pihak yang cuma terdaftar sebagai pemasok gak boleh muncul/dipakai di transaksi penjualan, dan sebaliknya | Pengaman otomatis di setiap tabel transaksi yang menunjuk pihak — menolak kalau pihak itu belum terdaftar berperan sesuai (lihat submodule "Proteksi Peran per Tabel Transaksi" di bawah) |
| Batas kredit & toleransi telat cuma berlaku ke pelanggan | Kolomnya ada di semua baris (1 struktur data yang sama), tapi cuma dibaca/dicek modul Piutang (AR) — pemasok yang gak punya peran pelanggan gak pernah kena pengecekan ini |
| Riwayat transaksi lama gak pernah hilang begitu pihak dihapus/diarsipkan | Penghapusan pihak yang sudah pernah bertransaksi otomatis jadi arsip (dinonaktifkan), bukan dihapus beneran — transaksi lama tetap tertelusur ke pihak itu |

**Interaksi Antar Tabel**

- `counterparty_type_mapping` menunjuk `counterparties` — 1 pihak bisa punya 2 baris peran (pelanggan + pemasok), tapi setiap kombinasi pihak+peran cuma boleh muncul sekali.
- Peran yang sudah ditetapkan gak pernah diubah (misal dari pelanggan jadi pemasok) — cuma bisa ditambah perannya, bukan diganti.

## Proteksi Peran per Tabel Transaksi

**Peta Data (ERD)**

`transactions`/`payments`/`deposits`/`return_credits`/`orders` adalah tabel generic 1-kolom, dipakai bareng AR & AP dan dibedakan kolom `type`/`direction` (lihat `transactions-schema.md`, `payments-schema.md`, `deposits-schema.md`, `return-credits-schema.md`, `orders-schema.md`) — gak ada kolom `customer_id`/`supplier_id` terpisah di tabel-tabel ini, semuanya 1 kolom `counterparty_id` tunggal, peran wajibnya ditentukan dinamis dari kolom arah di baris yang sama:

| Kolom di tabel transaksi | Peran wajib | Ditentukan dari |
|---|---|---|
| `transactions.counterparty_id` | pelanggan (invoice AR) atau pemasok (bill AP) | Kolom `type` (`INBOUND`/`OUTBOUND`) di baris yang sama |
| `payments.counterparty_id` | pelanggan atau pemasok | Kolom `type` di baris yang sama |
| `deposits.counterparty_id` | pelanggan atau pemasok | Kolom `type` di baris yang sama |
| `return_credits.counterparty_id` | pelanggan atau pemasok | Kolom `type` di baris yang sama |
| `orders.counterparty_id` | pelanggan (arah jual) atau pemasok (arah beli) | Kolom `direction` di baris yang sama |
| `pos_sales.customer_id` (opsional) | pelanggan | Tetap (tabel ini cuma 1 arah) |

`credit_notes` sengaja **tidak** punya kolom pihak sendiri — pihaknya ditelusuri gak langsung lewat `transaction_id` ke `transactions.counterparty_id`, jadi gak butuh pengaman perannya sendiri (peran udah tervalidasi waktu `transactions`-nya dibuat).

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Simpan transaksi apa pun yang menunjuk pihak (invoice/bill, pembayaran, uang muka, retur kredit, penjualan kios, order beli/jual) | Seluruh RPC/insert yang sudah ada di modul masing-masing (**tidak ada RPC baru** khusus untuk ini) | Sebelum baris transaksi tersimpan, sistem cek dulu peran pihak yang ditunjuk sesuai arah baris itu | Ditolak kalau pihak itu belum terdaftar berperan sesuai kebutuhan baris itu — dicek otomatis di level database, bukan cuma disiplin form/kode |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Kesalahan pilih pihak (misal pilih pemasok di form invoice penjualan) gak mungkin lolos ke database | Pengaman otomatis di level database — walau ada bug di kode aplikasi yang lolos validasi UI, insert langsung ke tabel tetap ditolak |
| Kolom pihak yang opsional (mis. penjualan kios tanpa pelanggan tercatat/walk-in) tetap boleh kosong | Pengaman ini cuma aktif kalau kolomnya diisi — kosong tetap diizinkan lolos |

**Interaksi Antar Tabel**

- Semua baris di tabel Peta Data submodule ini menunjuk balik ke `counterparty_type_mapping` (lewat pengaman otomatis di atas), bukan lewat relasi FK biasa — jadi gak kelihatan di ERD sebagai garis penghubung biasa.
- Karena 1 kolom `counterparty_id`/`customer_id` yang sama dipakai bergantian, tiap tabel generic di atas sebenarnya dijaga SEPASANG pengaman (1 buat pelanggan, 1 buat pemasok) yang saling eksklusif — cuma salah satu yang aktif tergantung arah baris itu.

## Dampak ke Piutang (AR) & Utang (AP)

**Peta Data (ERD)**

Tidak ada tabel baru — perhitungan termin pembayaran, batas kredit, dan toleransi telat yang tadinya membaca tabel pelanggan/pemasok terpisah sekarang membaca `counterparties` yang sama untuk kedua arah.

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Terbitkan invoice/bill baru | RPC penerbitan invoice (Piutang)/bill (Utang) yang sudah ada | Termin pembayaran & (khusus invoice) pengecekan batas kredit dihitung dari `counterparties` | — |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Tanggal jatuh tempo dan batas kredit dihitung dari `counterparties` | Logika perhitungannya membaca `counterparties` sebagai sumber data tunggal untuk kedua arah |

**Interaksi Antar Tabel**

- `transactions` dan seluruh tabel turunannya (pembayaran, uang muka, retur) menunjuk `counterparties` untuk kedua arah (piutang maupun utang).
