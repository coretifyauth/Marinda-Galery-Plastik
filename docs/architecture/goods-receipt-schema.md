# Goods Receipt (Penerimaan Barang) — Struktur Data

Konsep bisnisnya ada di `docs/domain/inventory.md` bagian "Purchase Order & Sales Order (Order) & Penerimaan Barang (3-Way Matching)". File ini fokus ke struktur datanya. Detail teknis (SQL, nama fungsi persis) ada di `memory/architecture/data/goods-receipt-schema.md`.

Goods Receipt Note (GRN) adalah bukti penerimaan barang fisik dari supplier — ini titik di mana Persediaan beneran bertambah dan Utang Usaha muncul. GRN boleh berasal dari sebuah Order (lihat `orders-schema.md`, `direction='PURCHASE'`) untuk dicocokkan qty/harganya, atau dibuat langsung tanpa order sama sekali untuk kasus beli dadakan. GRN dan tagihan (Bill) dibuat **bersamaan** dalam 1 langkah — lihat `transactions-schema.md` untuk struktur `transactions`/jurnal yang dipakai.

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `goods_receipt_notes` | Header bukti penerimaan barang | `orders-schema.md` (opsional), `transactions-schema.md` (wajib) |
| `goods_receipt_lines` | Baris item yang diterima (qty & harga riil) | `goods_receipt_notes`, `orders-schema.md` (opsional), `items-schema.md` |

## Konsep Inti

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `goods_receipt_notes` | 1 baris = 1 kejadian penerimaan barang, selalu berpasangan 1-1 dengan 1 tagihan (Bill) | `orders` (opsional), `transactions` (wajib) |
| `goods_receipt_lines` | 1 baris = 1 item yang diterima dalam 1 GRN | `goods_receipt_notes`, `order_lines` (opsional), `items` |

**Struktur `goods_receipt_notes`**

| Kolom | Isinya | Catatan |
|---|---|---|
| `order_id` | Order (PO) asal, kalau ada | Opsional — kosong berarti beli dadakan tanpa order |
| `bill_id` | Tagihan (Bill) yang dibuat bersamaan | **Selalu wajib** — tiap GRN pasti punya tagihan pasangannya |
| `delivery_note_ref` | Nomor Surat Jalan dari supplier | Murni catatan referensi teks, bukan entity tersendiri |
| `receipt_date` | Tanggal barang diterima | — |

**Struktur `goods_receipt_lines`**

| Kolom | Isinya | Catatan |
|---|---|---|
| `order_line_id` | Baris order (PO) asal, kalau ada | Opsional — kalau kosong, gak ada apa pun buat dibandingkan (jalur langsung) |
| `item_id`, `qty_received`, `unit_cost` | Barang, qty riil diterima, harga riil per unit | Ini angka **riil**, boleh beda dari `unit_price` yang tercatat di order line — selisih harga cuma informasional, gak diblokir |

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Catat penerimaan barang (+ tagihan sekaligus) | `create_goods_receipt` | 1 panggilan memicu semuanya: (1) tentukan supplier — dari order kalau `order_id` diisi, atau manual kalau langsung; (2) bikin Bill + jurnal Debit Persediaan/Kredit Utang Usaha (reuse `create_ap_bill`, lihat `transactions-schema.md`), termasuk hitung PPN kalau diminta; (3) insert `goods_receipt_notes` + `goods_receipt_lines`; (4) hitung ulang harga rata-rata tertimbang (`avg_cost`) dan update saldo Persediaan per item (lihat `inventory-ledger-schema.md`) | Order tujuan (kalau diisi) harus `direction='PURCHASE'` dan belum dibatalkan; qty diterima per baris order gak boleh melebihi sisa yang masih dipesan; jalur langsung wajib menyebutkan supplier manual |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Penerimaan barang dari Order gak boleh melebihi qty yang masih tersisa dari yang dipesan | Trigger anti-over-receipt — bandingkan total sudah diterima + qty baru terhadap `qty_ordered` di baris order, per item |
| Penerimaan langsung tanpa Order gak punya batas pembanding | Trigger anti-over-receipt di-skip total kalau baris gak menunjuk order line |
| Pembelian selalu masuk Persediaan (aset), gak pernah langsung jadi Beban | `create_goods_receipt` selalu mengarah ke akun Persediaan sebagai debit utama; beban tambahan (ongkir dll) dicatat terpisah lewat baris debit ekstra, bukan menggantikan kategori Persediaan |
| Penerimaan langsung wajib menyebutkan supplier secara manual | `create_goods_receipt` menolak jalan kalau `order_id` kosong dan supplier manual gak diisi/gak valid |
| Order yang sudah dibatalkan gak bisa jadi dasar GRN baru | Guard di awal `create_goods_receipt` — cek `cancelled_at` order sebelum lanjut |
| Order cuma bisa dipakai sesuai arahnya (GRN cuma boleh dari PO, bukan SO) | Trigger yang menolak `order_id` menunjuk order dengan `direction` selain `PURCHASE` |
| Tiap transaksi harus tertelusur ke dokumen sumber | GRN selalu punya `delivery_note_ref` + `bill_id` wajib — gak pernah berdiri sendiri tanpa tagihan |
| Data yang sudah tercatat gak boleh diubah/dihapus diam-diam | Trigger immutability pada `goods_receipt_notes` dan `goods_receipt_lines` |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `goods_receipt_notes.order_id` | banyak-ke-satu (opsional) | `orders` (harus `direction='PURCHASE'`) |
| `goods_receipt_notes.bill_id` | banyak-ke-satu (wajib) | `transactions` (lihat `transactions-schema.md`) |
| `goods_receipt_lines.grn_id` | banyak-ke-satu | `goods_receipt_notes` |
| `goods_receipt_lines.order_line_id` | banyak-ke-satu (opsional) | `order_lines` |
| `goods_receipt_lines.item_id` | banyak-ke-satu | `items` |
| `goods_receipt_lines` (tiap insert) | memicu update | `inventory_balances` (`inventory-ledger-schema.md`) |

Catatan desain: GRN dan Bill dibuat bersamaan (1 langkah) karena proses pembeliannya masih informal — nota dianggap bukti kirim + tagihan sekaligus. Ini artinya belum ada akun perantara "Barang Diterima Belum Ditagih" untuk kasus barang datang duluan, tagihan resmi menyusul — kalau proses pembeliannya nanti berkembang butuh jeda waktu, ini jadi hal yang perlu didesain ulang.

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat daftar penerimaan barang | Semua user yang sudah login |
| Mencatat penerimaan barang baru | Role `admin` atau `accountant` |
| Mengubah atau menghapus penerimaan barang yang sudah tercatat | **Tidak ada seorang pun** — immutable total, koreksi lewat proses lain (mis. retur ke supplier), bukan edit langsung |
