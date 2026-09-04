# Counterparty — Struktur Data & Teknis

Cross-cutting, bukan bagian dari 1 modul tunggal — dipakai bareng Piutang (AR), Utang (AP), Inventory (Order beli/jual), dan Kios (POS). Gak ada `docs/domain/counterparty.md` tersendiri — konsep bisnis "pelanggan" dan "pemasok" tetap dijelaskan di `docs/domain/accounts-receivable.md` dan `docs/domain/accounts-payable.md` masing-masing; halaman ini murni menjelaskan bagaimana KEDUANYA sekarang disimpan di 1 struktur data yang sama di baliknya. Detail teknis penuh (DDL/trigger/RPC): `memory/architecture/data/counterparty-schema.md`.

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `counterparties` | Master data 1 pihak — gabungan tabel pelanggan dan pemasok yang dulu terpisah | — |
| `counterparty_type_mapping` | Peran pihak itu (pelanggan dan/atau pemasok) — 1 pihak boleh punya lebih dari 1 peran sekaligus | `counterparties` |

## Konsep Inti

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `counterparties` | Nama, kontak, termin pembayaran, plus batas kredit & toleransi telat (cuma relevan buat peran pelanggan) | — |
| `counterparty_type_mapping` | 1 baris per peran yang dimiliki 1 pihak | `counterparties` |

Dulu "pelanggan" dan "pemasok" adalah 2 tabel yang sama sekali terpisah. Digabung jadi 1 karena strukturnya nyaris identik (cuma beda 2 kolom yang emang cuma relevan buat pelanggan), dan supaya di masa depan 1 pihak yang sama bisa berperan pelanggan DAN pemasok sekaligus tanpa harus dicatat sebagai 2 entitas berbeda dengan ID berbeda.

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

| Kolom di tabel transaksi | Peran wajib | Modul |
|---|---|---|
| `ar_invoices.customer_id` | pelanggan | Piutang (AR) |
| `ar_payments.customer_id` | pelanggan | Piutang (AR) |
| `ar_deposits.customer_id` | pelanggan | Piutang (AR) |
| `ar_return_credits.customer_id` | pelanggan | Piutang (AR) |
| `pos_sales.customer_id` (opsional) | pelanggan | Kios (POS) |
| `ap_bills.supplier_id` | pemasok | Utang (AP) |
| `ap_payments.supplier_id` | pemasok | Utang (AP) |
| `ap_deposits.supplier_id` | pemasok | Utang (AP) |
| `ap_return_credits.supplier_id` | pemasok | Utang (AP) |
| `orders.counterparty_id` | pelanggan (arah jual) atau pemasok (arah beli), tergantung kolom arah di baris yang sama | Inventory (Order beli/jual — lihat `docs/architecture/inventory-schema.md`) |

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Simpan transaksi apa pun yang menunjuk pihak (invoice, pembayaran, uang muka, retur, penjualan kios, order beli/jual) | Seluruh RPC/insert yang sudah ada di modul masing-masing (**tidak ada RPC baru** khusus untuk ini) | Sebelum baris transaksi tersimpan, sistem cek dulu peran pihak yang ditunjuk | Ditolak kalau pihak itu belum terdaftar berperan sesuai kebutuhan tabel itu — dicek otomatis di level database, bukan cuma disiplin form/kode |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Kesalahan pilih pihak (misal pilih pemasok di form invoice penjualan) gak mungkin lolos ke database | Pengaman otomatis di level database — walau ada bug di kode aplikasi yang lolos validasi UI, insert langsung ke tabel tetap ditolak |
| Kolom pihak yang opsional (mis. penjualan kios tanpa pelanggan tercatat/walk-in) tetap boleh kosong | Pengaman ini cuma aktif kalau kolomnya diisi — kosong tetap diizinkan lolos |

**Interaksi Antar Tabel**

- Semua baris di tabel Peta Data submodule ini menunjuk balik ke `counterparty_type_mapping` (lewat pengaman otomatis di atas), bukan lewat relasi FK biasa — jadi gak kelihatan di ERD sebagai garis penghubung biasa.
- `orders` sengaja dijaga pengaman yang sedikit beda dari 9 tabel lainnya — karena 1 kolom `counterparty_id` yang sama dipakai buat 2 arah (beli/jual), peran wajibnya ditentukan dinamis dari kolom arah di baris itu sendiri, bukan tetap 1 peran per tabel seperti 9 tabel lainnya.

## Dampak ke Piutang (AR) & Utang (AP)

**Peta Data (ERD)**

Tidak ada tabel baru — perhitungan termin pembayaran, batas kredit, dan toleransi telat yang tadinya membaca tabel pelanggan/pemasok terpisah sekarang membaca `counterparties` yang sama untuk kedua arah.

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Terbitkan invoice/bill baru | RPC penerbitan invoice (Piutang)/bill (Utang) yang sudah ada | Termin pembayaran & (khusus invoice) pengecekan batas kredit tetap jalan seperti sebelumnya, cuma sumber datanya sekarang `counterparties` | — |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Tanggal jatuh tempo dan batas kredit tetap dihitung persis sama seperti sebelum penggabungan | Logika perhitungannya 0 perubahan — cuma tabel sumbernya yang beda |

**Interaksi Antar Tabel**

- `ar_invoices`/`ap_bills` dan seluruh tabel turunannya (pembayaran, uang muka, retur, write-off) tetap menunjuk `counterparties` seperti dulu menunjuk tabel pelanggan/pemasok masing-masing — cuma nama tabel tujuannya yang berubah, bentuk relasinya tidak.
