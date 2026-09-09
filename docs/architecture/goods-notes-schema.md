# Goods Notes (Penerimaan & Pengiriman Barang) — Struktur Data

Konsep bisnisnya ada di `docs/domain/inventory.md` bagian "Penjualan & Pengakuan HPP" (pengiriman) dan
"Purchase Order & Sales Order (Order) & Penerimaan Barang (3-Way Matching)" (penerimaan). File ini
fokus ke struktur datanya. Detail teknis (SQL, nama fungsi persis) ada di
`supabase/migrations/0018_goods_notes_schema.sql`.

**Migration final (2026-09-07):** `supabase/migrations/0018_goods_notes_schema.sql` —
konsolidasi dari migration incremental lama (sudah dihapus, historinya ada di `git log`).

Goods Note adalah 1 tabel generic buat 2 kejadian fisik yang berlawanan arah, dibedakan kolom `type`
(mirror `transactions-schema.md`): **INBOUND** — dulu disebut Goods Receipt Note (GRN), barang **masuk**
dari supplier, titik di mana Persediaan bertambah dan Utang Usaha muncul. **OUTBOUND** — dulu disebut
Goods Issue, barang jadi **keluar** karena terjual, titik di mana HPP akhirnya diakui (1 transaksi
memicu 2 jurnal sekaligus — Piutang/Pendapatan dari invoice, dan HPP/Persediaan dari konsumsi stok).
Kedua arah boleh berasal dari Order (lihat `orders-schema.md`, `direction='PURCHASE'` buat INBOUND,
`direction='SALE'` buat OUTBOUND) atau dibuat langsung tanpa order. Selalu dibuat bersamaan dengan
transaksi finansialnya (Bill buat INBOUND, Invoice buat OUTBOUND) — lihat `transactions-schema.md`.

Penggabungan tabel ini TIDAK menggabungkan alur pembuatannya — masih 2 RPC terpisah
(`create_goods_receipt` buat INBOUND, `create_goods_issue` buat OUTBOUND) karena efek jurnalnya
beneran beda (INBOUND cuma update Persediaan, OUTBOUND bikin 2 jurnal Piutang+HPP). Yang digabung
cuma tabel penyimpanannya.

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `goods_notes` | Header bukti penerimaan/pengiriman barang, dibedakan `type` | `transactions-schema.md` (wajib), Journal Entry (wajib cuma OUTBOUND), `orders-schema.md` (opsional) |
| `goods_note_lines` | Baris item yang diterima/keluar (qty & biaya) | `goods_notes`, `orders-schema.md` (opsional), `items-schema.md` |

## Konsep Inti

**Struktur `goods_notes`**

| Kolom | Isinya | Catatan |
|---|---|---|
| `type` | `INBOUND` (dulu GRN) atau `OUTBOUND` (dulu Goods Issue) | Menentukan arah fisik & kolom mana yang wajib terisi |
| `transaction_id` | Tagihan (Bill, INBOUND) atau Invoice (OUTBOUND) yang dibuat bersamaan | **Selalu wajib** — tiap Goods Note pasti punya transaksi pasangannya |
| `journal_entry_id` | Jurnal HPP (Debit HPP, Kredit Persediaan Barang Jadi) | Wajib diisi **HANYA OUTBOUND** — INBOUND selalu NULL karena jurnal Persediaan udah tercakup di jurnal transaksinya sendiri, bukan cacat data |
| `source_ref` | Nomor dokumen internal | Wajib diisi **HANYA OUTBOUND** — INBOUND gak pernah punya nomor dokumen sendiri (cukup `delivery_note_ref` + nomor Bill-nya) |
| `order_id` | Order asal, kalau ada | Opsional — INBOUND harus dari Purchase Order kalau diisi, OUTBOUND harus dari Sales Order |
| `delivery_note_ref` | Nomor Surat Jalan dari counterparty | Murni catatan referensi teks — dalam praktiknya cuma keisi sisi INBOUND |
| `note_date` | Tanggal kejadian fisik (terima/kirim) | — |

**Struktur `goods_note_lines`**

| Kolom | Isinya | Catatan |
|---|---|---|
| `order_line_id` | Baris Order asal, kalau ada | Opsional — kalau kosong, jalur langsung tanpa order |
| `item_id`, `qty` | Barang, qty yang diterima/dikirim | — |
| `unit_cost` | Harga beli riil per unit | Wajib diisi **HANYA INBOUND** — input manual, boleh beda dari harga di order line (selisih murni informasional) |
| `total_cost` | Total biaya pokok (extended, bukan per-unit) | Wajib diisi **HANYA OUTBOUND** — dihitung dari harga rata-rata tertimbang saat konsumsi (Weighted Average, `inventory-ledger-schema.md`), bukan input manual |
| `unit_price` | Harga jual per unit | Cuma keisi sisi OUTBOUND jalur langsung (POS/walk-in tanpa Sales Order) — kalau ada `order_line_id`, harga tetap bersumber dari `order_lines.unit_price` |

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Catat penerimaan barang (INBOUND, + tagihan sekaligus) | `create_goods_receipt` | 1 panggilan: (1) tentukan supplier — dari order kalau diisi, atau manual kalau langsung; (2) bikin Bill + jurnal Debit Persediaan/Kredit Utang Usaha; (3) insert `goods_notes`(`type='INBOUND'`)+`goods_note_lines`; (4) hitung ulang `avg_cost` & update saldo Persediaan per item | Order tujuan (kalau diisi) harus Purchase Order dan belum dibatalkan; qty diterima per baris order gak boleh melebihi sisa dipesan; jalur langsung wajib supplier manual |
| Catat pengiriman barang (OUTBOUND, + invoice + pengakuan HPP sekaligus) | `create_goods_issue` | 1 panggilan: (1) bikin invoice + jurnal Debit Piutang/Kredit Pendapatan; (2) konsumsi tiap barang jadi dari stok (Weighted Average); (3) bikin jurnal **kedua** — Debit HPP, Kredit Persediaan Barang Jadi; (4) insert `goods_notes`(`type='OUTBOUND'`)+`goods_note_lines`; (5) catat mutasi keluar ke Kartu Stok | Sales Order tujuan (kalau diisi) harus `direction='SALE'` dan belum dibatalkan; qty keluar per baris order gak boleh melebihi sisa dipesan; qty keluar gak boleh melebihi stok tersedia |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| HPP diakui persis pas barang jadi keluar, bukan pas utang dibayar atau pas barang diproduksi | `create_goods_issue` selalu bikin jurnal HPP di titik ini, terpisah dari jurnal invoice |
| Pembelian selalu masuk Persediaan (aset), gak pernah langsung jadi Beban | `create_goods_receipt` selalu mengarah ke akun Persediaan sebagai debit utama |
| Pengurangan/penambahan stok gak boleh melebihi batas wajar | Weighted Average menolak konsumsi kalau saldo gak cukup; trigger anti-over-fulfill menolak qty yang ngelewatin sisa order |
| Penerimaan/pengiriman dari Order gak boleh melebihi qty yang masih tersisa dari yang dipesan | 1 trigger anti-over-fulfill generic, bandingkan total sudah terpenuhi + qty baru terhadap `qty_ordered`, per baris order — otomatis cuma bandingin 1 arah karena `order_line_id` gak bisa dipakai lintas arah |
| Jalur langsung tanpa Order gak punya batas pembanding | Trigger anti-over-fulfill di-skip total kalau baris gak menunjuk order line |
| Order cuma bisa dipakai sesuai arahnya (INBOUND cuma dari PO, OUTBOUND cuma dari SO) | Trigger yang menolak `order_id`/`order_line_id` menunjuk order dengan `direction` yang salah — berlaku di level header DAN baris |
| Order yang sudah dibatalkan gak bisa jadi dasar Goods Note baru | Guard di awal kedua RPC — cek `cancelled_at` order sebelum lanjut |
| Tiap transaksi harus tertelusur ke dokumen sumber | `transaction_id` wajib diisi di `goods_notes`, gak pernah berdiri sendiri |
| Data yang sudah tercatat gak boleh diubah/dihapus diam-diam | Trigger immutability pada `goods_notes` dan `goods_note_lines` |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `goods_notes.transaction_id` | banyak-ke-satu (wajib) | `transactions` (lihat `transactions-schema.md`) |
| `goods_notes.journal_entry_id` | banyak-ke-satu (wajib cuma OUTBOUND) | Journal Entry (`journal-entry-schema.md`) |
| `goods_notes.order_id` | banyak-ke-satu (opsional) | `orders` (arah harus cocok `type`) |
| `goods_note_lines.goods_note_id` | banyak-ke-satu | `goods_notes` |
| `goods_note_lines.order_line_id` | banyak-ke-satu (opsional) | `order_lines` (arah harus cocok `type` header) |
| `goods_note_lines.item_id` | banyak-ke-satu | `items` |
| `goods_note_lines` (tiap insert) | memicu update/konsumsi | Saldo stok (`inventory-ledger-schema.md`) |

Catatan lintas modul: retur customer (pembalikan stok+HPP dari OUTBOUND) dan retur ke supplier
(pembalikan dari INBOUND) didokumentasikan di `returns-schema.md`/`return-credits-schema.md`, bukan
di sini. Tukar/ganti barang pasca-retur (Opsi B, kedua arah) di `replacements-schema.md`.

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat daftar penerimaan/pengiriman barang | Semua user yang sudah login |
| Mencatat penerimaan/pengiriman barang baru | Role `admin` atau `accountant` |
| Mengubah atau menghapus yang sudah tercatat | **Tidak ada seorang pun** — immutable total, koreksi lewat proses retur, bukan edit langsung |
