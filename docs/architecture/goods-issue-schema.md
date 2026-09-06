# Goods Issue (Pengiriman Barang & Pengakuan HPP) — Struktur Data

Konsep bisnisnya ada di `docs/domain/inventory.md` bagian "Penjualan & Pengakuan HPP (Goods Issue)". File ini fokus ke struktur datanya. Detail teknis (SQL, nama fungsi persis) ada di `memory/architecture/data/goods-issue-schema.md`.

Goods Issue adalah kebalikan dari Goods Receipt — barang jadi **keluar** dari gudang karena terjual. Ini titik di mana Harga Pokok Penjualan (HPP) akhirnya diakui: 1 transaksi memicu **2 jurnal sekaligus** (Piutang/Pendapatan dari invoice, dan HPP/Persediaan dari konsumsi stok). Goods Issue boleh berasal dari Sales Order (lihat `orders-schema.md`, `direction='SALE'`) atau dibuat langsung tanpa order untuk penjualan spontan. Dibuat bersamaan dengan invoice — lihat `transactions-schema.md` untuk struktur `transactions`/jurnal yang dipakai.

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `goods_issues` | Header bukti pengiriman barang jadi | `transactions-schema.md` (wajib, invoice), Journal Entry (wajib, jurnal HPP), `orders-schema.md` (opsional) |
| `goods_issue_lines` | Baris item barang jadi yang keluar (qty & biaya pokok) | `goods_issues`, `orders-schema.md` (opsional), `items-schema.md` |

## Konsep Inti

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `goods_issues` | 1 baris = 1 kejadian pengiriman barang, selalu berpasangan 1-1 dengan 1 invoice DAN 1 jurnal HPP tambahan | `transactions` (wajib), Journal Entry (wajib), `orders` (opsional) |
| `goods_issue_lines` | 1 baris = 1 item barang jadi yang keluar dalam 1 Goods Issue | `goods_issues`, `order_lines` (opsional), `items` |

**Struktur `goods_issues`**

| Kolom | Isinya | Catatan |
|---|---|---|
| `invoice_id` | Invoice penjualan yang dibuat bersamaan | **Selalu wajib** — tiap Goods Issue pasti punya invoice pasangannya |
| `journal_entry_id` | Jurnal HPP (Debit HPP, Kredit Persediaan Barang Jadi) | Jurnal **kedua**, terpisah dari jurnal invoice (Debit Piutang/Kredit Pendapatan) |
| `issue_date`, `source_ref` | Tanggal pengiriman, nomor referensi dokumen | — |

**Struktur `goods_issue_lines`**

| Kolom | Isinya | Catatan |
|---|---|---|
| `order_line_id` | Baris Sales Order asal, kalau ada | Opsional — kalau kosong, jalur jual langsung tanpa Sales Order |
| `item_id`, `qty_issued`, `total_cost` | Barang jadi, qty keluar, total biaya pokoknya | `total_cost` dihitung dari harga rata-rata tertimbang barang jadi saat itu (Weighted Average, lihat `inventory-ledger-schema.md`) |

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Catat pengiriman barang (+ invoice + pengakuan HPP sekaligus) | `create_goods_issue` | 1 panggilan memicu semuanya: (1) bikin invoice + jurnal Debit Piutang/Kredit Pendapatan (reuse `create_ar_invoice`, lihat `transactions-schema.md`), termasuk PPN kalau diminta; (2) konsumsi tiap barang jadi yang terjual dari stok pakai Weighted Average; (3) bikin jurnal **kedua** — Debit HPP, Kredit Persediaan Barang Jadi, sebesar total biaya pokok yang dikonsumsi; (4) insert `goods_issues` + `goods_issue_lines` | Sales Order tujuan (kalau diisi) harus `direction='SALE'` dan belum dibatalkan; qty keluar per baris order gak boleh melebihi sisa yang masih dipesan; qty keluar gak boleh melebihi stok barang jadi yang tersedia |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| HPP diakui persis pas barang jadi keluar (Goods Issue), bukan pas utang ke supplier dibayar atau pas barang diproduksi | `create_goods_issue` selalu membuat jurnal HPP di titik ini juga, terpisah dari jurnal invoice |
| Pengurangan stok barang jadi gak boleh melebihi qty yang tersedia | Konsumsi Weighted Average menolak kalau saldo stok item gak cukup (lihat `inventory-ledger-schema.md`) |
| Pengiriman dari Sales Order gak boleh melebihi qty yang masih tersisa dari yang dipesan | Trigger anti-over-issue — bandingkan total sudah dikirim + qty baru terhadap `qty_ordered` di baris order, per item |
| Pengiriman langsung tanpa Sales Order gak punya batas pembanding | Trigger anti-over-issue di-skip total kalau baris gak menunjuk order line |
| Tiap pengiriman langsung memunculkan invoice sendiri (Sales Order bisa dicicil, bukan nunggu semua qty terkirim) | `create_goods_issue` dipanggil sekali per pengiriman, masing-masing bikin invoice + Goods Issue sendiri-sendiri, gak menunggu order selesai total |
| Goods Issue harus tertelusur ke invoice yang dibuat bersamaan | `invoice_id` wajib diisi di `goods_issues` |
| Order yang sudah dibatalkan gak bisa jadi dasar Goods Issue baru | Guard di awal `create_goods_issue` — cek `cancelled_at` order sebelum lanjut |
| Order cuma bisa dipakai sesuai arahnya (Goods Issue cuma boleh dari SO, bukan PO) | Trigger yang menolak `order_line_id` menunjuk baris dari order dengan `direction` selain `SALE` |
| Data yang sudah tercatat gak boleh diubah/dihapus diam-diam | Trigger immutability pada `goods_issues` dan `goods_issue_lines` |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `goods_issues.invoice_id` | banyak-ke-satu (wajib) | `transactions` (lihat `transactions-schema.md`) |
| `goods_issues.journal_entry_id` | banyak-ke-satu (wajib) | Journal Entry (`journal-entry-schema.md`) |
| `goods_issue_lines.goods_issue_id` | banyak-ke-satu | `goods_issues` |
| `goods_issue_lines.order_line_id` | banyak-ke-satu (opsional) | `order_lines` (harus dari order `direction='SALE'`) |
| `goods_issue_lines.item_id` | banyak-ke-satu | `items` |
| `goods_issue_lines` (tiap insert) | memicu konsumsi | Saldo stok barang jadi (`inventory-ledger-schema.md`) |

Catatan lintas modul: kalau barang yang keluar lewat Goods Issue ini diretur customer, pembalikan stok+HPP-nya (proporsional, pakai harga pokok snapshot asli, bukan harga sekarang) didokumentasikan di modul Piutang Usaha — lihat `credit-notes-schema.md`/`return-credits-schema.md`, bukan di sini.

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat daftar pengiriman barang | Semua user yang sudah login |
| Mencatat pengiriman barang baru | Role `admin` atau `accountant` |
| Mengubah atau menghapus pengiriman barang yang sudah tercatat | **Tidak ada seorang pun** — immutable total, koreksi lewat proses retur, bukan edit langsung |
