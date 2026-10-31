# Goods Notes (Penerimaan & Pengiriman Barang) — Struktur Data

Konsep bisnisnya ada di `docs/domain/inventory.md` bagian "Penjualan & Pengakuan HPP" (pengiriman) dan
"Purchase Order & Sales Order (Order) & Penerimaan Barang (3-Way Matching)" (penerimaan). File ini
fokus ke struktur datanya. Detail teknis (SQL, nama fungsi persis) ada di
`supabase/migrations/0018_goods_notes_schema.sql`.

**Migration final (2026-09-07):** `supabase/migrations/0018_goods_notes_schema.sql` —
konsolidasi dari migration incremental lama (sudah dihapus, historinya ada di `git log`).

Goods Note adalah 1 tabel generic buat 2 kejadian fisik yang berlawanan arah, dibedakan kolom `type`
(mirror `transactions-schema.md`): **INBOUND** — dulu disebut Goods Receipt Note (GRN), barang **masuk**
dari supplier, titik di mana Persediaan bertambah (Utang Usaha sudah muncul lebih dulu di tagihannya). **OUTBOUND** — dulu disebut
Goods Issue, barang jadi **keluar** karena terjual, titik di mana HPP akhirnya diakui (1 transaksi
memicu 2 jurnal sekaligus — Piutang/Pendapatan dari invoice, dan HPP/Persediaan dari konsumsi stok).
Kedua arah boleh berasal dari Order (lihat `orders-schema.md`, `direction='PURCHASE'` buat INBOUND,
`direction='SALE'` buat OUTBOUND) atau dibuat langsung tanpa order. OUTBOUND selalu dibuat bersamaan dengan
invoice-nya; INBOUND dibuat dari tagihan (Bill) yang sudah ada — lihat `transactions-schema.md`.

Penggabungan tabel ini TIDAK menggabungkan alur pembuatannya — masih 2 RPC terpisah
(`create_goods_receipt` buat INBOUND, `create_goods_issue` buat OUTBOUND) karena efek jurnalnya
beneran beda (INBOUND cuma update Persediaan, OUTBOUND bikin 2 jurnal Piutang+HPP). Yang digabung
cuma tabel penyimpanannya.

> **Status (2026-10-22): sisi INBOUND sudah diganti total di live.** Migration `0056_goods_received_not_invoiced.sql` (barang masuk dipisah dari tagihan) sempat terpasang,
> lalu diganti: barang masuk tanpa tagihan **dihapus**; barang masuk selalu dibuat dari tepat satu tagihan barang. Desain
> pengganti ada di section `## Barang Masuk dari Tagihan (Tagihan Dulu, Barang Menyusul)` di bawah (migration `0057`, `0058`, dan `0059`,
> sudah diapply ke live 2026-10-22). Sisi OUTBOUND tidak berubah. Konsep bisnis:
> `docs/domain/accounts-payable.md` submodule "Tagihan Dulu, Barang Menyusul" dan `docs/domain/inventory.md` submodule "Barang Masuk dari Tagihan".

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
| `transaction_id` | Tagihan (Bill, INBOUND) atau Invoice (OUTBOUND) | **Wajib** — INBOUND: tagihan barang tempat barang masuk itu dibuat (tepat satu); OUTBOUND: invoice yang dibuat bersamaan. `0056` melonggarkannya untuk INBOUND; rancangan `0057` menegakkannya lagi lewat trigger INSERT |
| `journal_entry_id` | Jurnal HPP (OUTBOUND: Debit HPP, Kredit Persediaan Barang Jadi) | OUTBOUND wajib. INBOUND lama (`bundled`): NULL, jurnal Persediaan ada di jurnal tagihannya. INBOUND alur baru: Debit Persediaan / Kredit Pembelian Belum Diterima |
| `source_ref` | Nomor dokumen internal | OUTBOUND wajib. INBOUND lama: NULL. INBOUND alur baru: nomor `GRN` dari penomoran dokumen `goods_receipts` |
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
| `discount_rule_id`, `discount_amount` | Diskon barang (lihat `promotion-item-discount-rules-schema.md`) | **OUTBOUND**: resolusi FRESH dari aturan aktif saat baris ini dibuat (bukan diwarisi dari `order_lines`), sudah baked-in ke `unit_price`/jumlah yang dikirim ke `create_goods_issue` — murni audit trail. **INBOUND**: porsi dari diskon header (nominal manual admin, lihat submodule "Diskon Pembelian" di bawah) yang diproratakan `create_goods_receipt` ke baris ini berdasar `qty * unit_cost` — satu-satunya kasus di mana kolom ini dipakai buat aritmatika (mengoreksi `avg_cost`) |
| `bundle_promo_rule_id` | "Beli N Gratis X" (lihat `promotion-bundle-rules-schema.md`) | Cuma OUTBOUND — `discount_amount` di atas bisa nampung kontribusi dari `promotion_item_discount_rules` DAN `promotion_bundle_rules` sekaligus (dijumlah, dibatasi gak lebih dari `qty*unit_price` baris itu). Dari jalur POS, diisi `create_pos_sale` sendiri (server-side); dari Sales Order/Goods Issue manual, dari resolusi TypeScript client (informational, sama pola `discount_rule_id`) |
| `manual_discount_amount` | Diskon manual kasir POS (lihat `pos-schema.md` bagian "Diskon Manual Kasir") | Cuma OUTBOUND dari POS, default `0`, `CHECK >= 0`. **Terpisah dari `discount_amount`** (diskon otomatis) biar laporan bisa membedakan potongan promo vs nego kasir. Porsi baris ini dari 1 nominal per transaksi, dibagi proporsional oleh `create_pos_sale`. Sudah baked-in ke jurnal (murni audit trail); kasirnya = `goods_notes.created_by` |

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Catat penerimaan barang (INBOUND) | `create_goods_receipt` | Barang masuk dibuat **dari satu tagihan barang** (jurnal Debit Persediaan / Kredit Pembelian Belum Diterima, `avg_cost` langsung dihitung) — lihat section "Barang Masuk dari Tagihan" di bawah | Lihat section di bawah |
| Batalkan penerimaan barang (INBOUND) | `cancel_goods_receipt` (barang masuk alur baru) atau `cancel_ap_bill` (tagihan lama alur `bundled`; migration `0052`/`0053`) | Barang masuk alur baru: jurnal dibalik, stok dan `avg_cost` dikurangi, kolam tagihan kembali. Tagihan lama: jurnal tagihan dibalik dan stok dikurangi (`avg_cost` dari nilai persediaan sisa), status "dibatalkan" diturunkan dari status tagihan (tabel immutable, tak ada kolom status) | Lihat section di bawah; untuk tagihan lama: ditolak kalau tagihan punya pembayaran/retur/DP/tukar barang, sudah pernah dibatalkan, atau stok item tinggal < qty diterima |
| Batalkan pengiriman barang (OUTBOUND) | `cancel_ar_invoice` (invoice pasangannya; migration `0052`) | Jurnal invoice + jurnal HPP dibalik; tiap baris: `qty_on_hand` ditambah balik (`avg_cost` tetap — konsumsi gak pernah mengubahnya), mutasi kompensasi (qty positif) ke Kartu Stok berlabel "Pembatalan Barang Keluar"; status Sales Order dihitung ulang | Ditolak kalau invoice punya pembayaran/retur/penggantian barang atau sudah pernah dibatalkan. Qty yang dibatalkan dibebaskan dari SO. Invoice POS yang sudah lunas tetap lewat `void_pos_transaction` |
| Catat pengiriman barang (OUTBOUND, + invoice + pengakuan HPP sekaligus) | `create_goods_issue` | 1 panggilan: (1) bikin invoice + jurnal Debit Piutang/Kredit Pendapatan (nilai per baris sudah net diskon, dihitung & dikirim client sebelum RPC dipanggil); (2) konsumsi tiap barang jadi dari stok (Weighted Average, gak kepengaruh diskon jual — HPP soal cost barang keluar, bukan harga jual); (3) bikin jurnal **kedua** — Debit HPP, Kredit Persediaan Barang Jadi; (4) insert `goods_notes`(`type='OUTBOUND'`)+`goods_note_lines` (termasuk `discount_rule_id`/`discount_amount` per baris, audit trail); (5) catat mutasi keluar ke Kartu Stok | Sales Order tujuan (kalau diisi) harus `direction='SALE'` dan belum dibatalkan; qty keluar per baris order gak boleh melebihi sisa dipesan; qty keluar gak boleh melebihi stok tersedia |

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
| Diskon penjualan gak pernah jadi baris jurnal terpisah (trade discount) | `create_goods_issue` cuma menyimpan `discount_rule_id`/`discount_amount`/`manual_discount_amount` per baris (audit trail) — nilai yang dijurnal sudah net dari `p_credit_lines`, RPC gak menghitung ulang. `transactions.discount_amount` mengakumulasi `discount_amount` + `manual_discount_amount` |
| Diskon pembelian gak boleh bikin nilai Persediaan (GL) menyimpang dari valuasi Kartu Stok (`avg_cost`) | `create_goods_receipt` memprorata `p_discount_amount` ke tiap baris SEBELUM menghitung `avg_cost`, bukan cuma mengurangi angka agregat |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `goods_notes.transaction_id` | banyak-ke-satu (wajib) | `transactions` (lihat `transactions-schema.md`) |
| `goods_notes.journal_entry_id` | banyak-ke-satu (wajib cuma OUTBOUND) | Journal Entry (`journal-entry-schema.md`) |
| `goods_notes.order_id` | banyak-ke-satu (opsional) | `orders` (arah harus cocok `type`) |
| `goods_note_lines.goods_note_id` | banyak-ke-satu | `goods_notes` |
| `goods_note_lines.order_line_id` | banyak-ke-satu (opsional) | `order_lines` (arah harus cocok `type` header) |
| `goods_note_lines.item_id` | banyak-ke-satu | `items` |
| `goods_note_lines.discount_rule_id` | banyak-ke-satu, opsional | `promotion_item_discount_rules` (`promotion-item-discount-rules-schema.md`), cuma keisi buat `type='OUTBOUND'` |
| `goods_note_lines.bundle_promo_rule_id` | banyak-ke-satu, opsional | `promotion_bundle_rules` (`promotion-bundle-rules-schema.md`), cuma keisi buat `type='OUTBOUND'` |
| `goods_note_lines` (tiap insert) | memicu update/konsumsi | Saldo stok (`inventory-ledger-schema.md`) |

Catatan lintas modul: retur customer (pembalikan stok+HPP dari OUTBOUND) dan retur ke supplier
(pembalikan dari INBOUND) didokumentasikan di `returns-schema.md`/`return-credits-schema.md`, bukan
di sini. Tukar/ganti barang pasca-retur (Opsi B, kedua arah) di `replacements-schema.md`.

## Barang Masuk dari Tagihan (Tagihan Dulu, Barang Menyusul)

Konsep bisnis: `docs/domain/accounts-payable.md` submodule "Tagihan Dulu, Barang Menyusul (Kolam Tagihan)" dan `docs/domain/inventory.md` submodule "Barang Masuk dari Tagihan". **Sudah diapply ke live (2026-10-22)** — migration `0057` (alur baru), `0058` (pembersihan, dengan arsip di skema `archive`), dan `0059` (view baca saja); lulus tes di database lokal (`supabase/tests/tagihan-dulu-barang-menyusul/`) dan review `schema-reviewer`.

Menggantikan seluruh desain "Barang Masuk Belum Ditagih" (0056): tidak ada lagi barang masuk tanpa tagihan.

### Keputusan

- **Barang masuk (INBOUND) selalu dibuat dari tepat satu tagihan barang.** Tautannya `goods_notes.transaction_id`, bukan tabel penghubung. Satu tagihan → banyak barang masuk; satu barang masuk → satu tagihan, tidak bisa dibagi atau dipindah.
- **Tagihan barang punya kolam**: bagian barang dari tagihan, disimpan di tabel pendamping append-only `ap_bill_goods_pools` (bukan kolom di `transactions` — tabel itu immutable dan `create_transaction` dipakai banyak jalur).
- **Alokasi tidak berjurnal.** Jurnal hanya dari tagihan dan barang masuk: tagihan Debit **Pembelian Belum Diterima** / Kredit Utang Usaha; barang masuk Debit Persediaan / Kredit Pembelian Belum Diterima.
- `avg_cost` langsung dihitung saat barang masuk (rata-rata tertimbang dari biaya bersih, lewat `inventory_add_billed`). Tidak ada stok belum ditagih, harga perkiraan, revisi harga, atau koreksi HPP lintas periode.
- Akun **Pembelian Belum Diterima** adalah akun baru berkategori **aset**. Akun 2150 (Barang Diterima Belum Ditagih, 0056) tidak lagi dirujuk Default Akun, tapi barisnya **tidak dihapus** karena sudah punya jurnal.
- Tidak ada perubahan pada database live sampai migration lolos uji lokal dan review, dan user yang menjalankan apply.

### Peta Data (ERD) — tabel baru/berubah

```
transactions (tagihan AP, type=INBOUND)
   │ 1                                   │ 1
   ├──── 0..1  ap_bill_goods_pools       ├──── n  bill_pool_releases ──── 0..1 deposits
   │           (kolam awal)              │        (pelepasan sisa kolam)
   │ 1
   └──── n  goods_notes (INBOUND)  ── 1..n goods_note_lines
                │ 0..1
                └── goods_note_cancellations
```

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `ap_bill_goods_pools` (baru) | 1 baris per tagihan barang: `transaction_id` (PK, FK), `amount` (> 0, nilai bagian barang = kolam awal), `created_at`, `created_by`. Immutable | `transactions` |
| `bill_pool_releases` (baru) | Pelepasan sisa kolam: `kind` (`pembulatan` / `uang_muka`), `amount` (> 0), `journal_entry_id` (wajib), `deposit_id` (hanya `uang_muka`). Immutable. Sisa kolam turun sebesar `amount` | `transactions`, `journal_entries`, `deposits` |
| `goods_notes` (INBOUND) | `transaction_id` jadi **wajib untuk baris INBOUND baru** (dijaga trigger saat INSERT, bukan `NOT NULL`, karena baris `deferred` lama yang sudah dibatalkan tidak punya tagihan dan tabelnya immutable). `journal_entry_id` dan `source_ref` terisi (nomor `GRN` dari penomoran dokumen `goods_receipts`). `counterparty_id` tetap (supplier = supplier tagihan) | `transactions`, `counterparties` |
| `goods_note_lines` (INBOUND) | `unit_cost` wajib > 0. `discount_amount` per baris = diskon item + bagian diskon header yang diproratakan | — |
| `goods_note_cancellations` | Tetap: penanda barang masuk yang dibatalkan + jurnal pembaliknya | `goods_notes`, `journal_entries` |
| Akun baru + Default Akun `inventory.purchase_not_received` | Akun **Pembelian Belum Diterima** (aset), dipetakan lewat Default Akun | `default-account-settings-schema.md` |

**Sisa kolam** (view `ap_bill_goods_pool_status`, `security_invoker = true`, diturunkan — tidak disimpan):
`sisa = pool.amount − Σ nilai bersih barang masuk aktif tagihan itu − Σ bill_pool_releases.amount`, dengan nilai bersih baris = `round(qty × unit_cost, 2) − discount_amount`. Barang masuk aktif = belum ada di `goods_note_cancellations`.

**Dibuang di `0058`** (setelah `0057` terbukti jalan): `goods_note_billings`, `goods_note_billing_allocations`, `goods_note_revisions`, `goods_note_revision_lines`, view `goods_notes_with_billing_status` dan `goods_note_line_current_cost`, fungsi `grni_spill_allocation`, `revise_goods_receipt`, `create_ap_bill_from_goods_receipts`, kolom `goods_notes.inbound_flow`, kolom `inventory_balances.qty_unbilled` dan `spill_value`, serta Default Akun lama `inventory.goods_received_not_invoiced`. Kategori ini hanya dibuang **setelah** isinya diamankan (lihat "Jaminan data").

### Alur Teknis (RPC)

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Buat tagihan barang | `create_ap_bill_with_goods_pool` (baru) | Membungkus `create_transaction('INBOUND', …)`: baris debit pertama = Pembelian Belum Diterima sebesar bagian barang (`p_goods_amount`), lalu baris biaya tambahan/PPN seperti tagihan biasa, lawan Utang Usaha. Insert `ap_bill_goods_pools` di transaksi yang sama | `p_goods_amount > 0`; supplier valid |
| Catat barang masuk | `create_goods_receipt` (signature baru: `p_bill_id` menggantikan param supplier; `p_order_id` opsional) | (1) kunci baris tagihan (`pg_advisory_xact_lock`); (2) supplier dari tagihan; (3) diskon header diproratakan (`grn_prorate_discount`); (4) total nilai bersih ≤ sisa kolam; (5) jurnal Debit Persediaan / Kredit Pembelian Belum Diterima; (6) insert `goods_notes` + `goods_note_lines`, Kartu Stok +qty; (7) per item `inventory_add_billed(item, qty, net_unit_cost)` | Tagihan INBOUND, belum dibatalkan, punya kolam; PO (kalau ada) belum dibatalkan, supplier sama, qty ≤ sisa; `unit_cost > 0`; `assert_period_open` |
| Batalkan barang masuk | `cancel_goods_receipt` (ditulis ulang) | Membalik jurnal (Debit Pembelian Belum Diterima / Kredit Persediaan), stok dan `avg_cost` dikurangi (rumus pembalikan nilai, sama dengan jalur tagihan lama), Kartu Stok kompensasi, insert `goods_note_cancellations`. Kolam otomatis kembali (diturunkan) | Stok item cukup dan nilai persediaan sisa cukup dibalik; belum ada retur/tukar atas item itu di tagihannya; periode terbuka |
| Lepas sisa kolam | `release_ap_bill_pool` (baru) | `kind='pembulatan'`: Debit Beban Selisih Pembulatan / Kredit Pembelian Belum Diterima. `kind='uang_muka'`: jurnal Debit Uang Muka Pembelian / Kredit Pembelian Belum Diterima, lalu insert `deposits` (sumber = pelepasan kolam). Insert `bill_pool_releases` | Pembulatan: harus seluruh sisa kolam dan sisa < satuan pembulatan bank (`payment_rounding_unit('BANK')`, default Rp1). Uang muka: `amount ≤ min(sisa, dibayar − terpakai)`, dengan dibayar = pembayaran + uang muka aktif yang diterapkan ke tagihan itu, terpakai = nilai bersih barang masuk aktif |
| Batalkan tagihan | `cancel_ap_bill` (diperluas) | Tagihan barang: membalik jurnal tagihan. Tagihan lama (`bundled`): cabang pembalikan stok (0053) tetap, kini membaca `goods_notes.transaction_id` | Guard lama (pembayaran/retur/DP/tukar barang) tetap. **Baru:** tagihan barang ditolak kalau masih punya barang masuk aktif atau pelepasan kolam |
| Retur ke supplier, tukar barang ke supplier | `create_ap_return`, trigger `return_lines_no_over_return_outbound`, `replacement_lines_no_over_claim` | Dibaca lewat `goods_notes.transaction_id` (bukan `goods_note_billings`); batas qty = total qty diterima semua barang masuk aktif di tagihan itu, per item | Tidak berubah selain sumber datanya |
| Status tagihan | `recompute_transaction_status` | `origin` tagihan INBOUND dibaca dari `goods_notes.transaction_id` | — |

### Rumus penting

- Biaya bersih per unit barang masuk: `net_unit_cost = (round(qty × unit_cost, 2) − discount_amount) ÷ qty`. `avg_cost` baru = rata-rata tertimbang `(qty_lama × avg + qty × net_unit_cost) ÷ (qty_lama + qty)`.
- Pembalikan barang masuk (`cancel_goods_receipt`): `nilai_baru = qty_lama × avg − nilai_bersih_baris`, `avg_baru = nilai_baru ÷ (qty_lama − qty)`; ditolak kalau `qty_lama − qty > 0` dan `nilai_baru ≤ 0`.
- Pelepasan uang muka: `batas = max(0, min(sisa_kolam, dibayar − terpakai))`.

### Invarian yang wajib terjaga (dipakai sebagai tes)

1. Per tagihan barang: `Σ nilai bersih barang masuk aktif + Σ pelepasan ≤ pool.amount`; sisa kolam ≥ 0.
2. Saldo akun Pembelian Belum Diterima = jumlah sisa kolam semua tagihan barang aktif (belum dibatalkan).
3. Nilai Persediaan per item di buku besar = `qty_on_hand × avg_cost` (selisih pembulatan sen diterima).
4. Tiap jurnal seimbang; tidak ada baris jurnal bernilai 0.
5. Satu barang masuk punya tepat satu tagihan, dan supplier barang masuk = supplier tagihan.
6. Barang masuk lama (16 `bundled`) dan satu `deferred` yang dibatalkan tidak berubah jurnalnya.

### Migrasi data lama dan jaminan data aman

**Kondisi live (dicek 2026-10-22):** 17 barang masuk INBOUND: 16 alur `bundled` (masing-masing tepat satu baris `goods_note_billings`, 16 = 16) dan 1 alur `deferred` yang **sudah dibatalkan** dan tidak punya tagihan (1 baris `goods_note_cancellations`, 1 baris `transaction_id` kosong). Barang masuk `deferred` aktif 0; revisi harga 0; baris alokasi penagihan 0; `qty_unbilled`/`spill_value` > 0 nol baris; koreksi HPP 0; 2 baris jurnal di akun 2150 (jurnal barang masuk yang dibatalkan dan jurnal pembaliknya, saldo bersih nol).

Prinsip: **0057 hanya menambah dan memigrasikan, tidak menghapus apa pun.** 0058 baru membuang skema mati, dan hanya setelah isinya diamankan dan diverifikasi. **Supabase CLI (`db push`) menjalankan tiap statement terpisah, bukan satu transaksi per file** (ketahuan di apply pertama 0058: `LOCK TABLE` ditolak di luar blok transaksi). Karena itu 0058 dan 0059 dibungkus `begin; … commit;` eksplisit — gagal di tengah berarti seluruhnya dibatalkan. 0057 tidak dibungkus (hanya menambah, dan terpasang penuh di live tanpa error).

| Data / objek | Nasib | Cara mengamankan |
|---|---|---|
| `goods_notes` INBOUND `bundled` (16 baris menurut catatan lama) | Tidak disentuh — `transaction_id` sudah terisi sejak awal | Tes: jumlah baris dan `transaction_id` sebelum = sesudah |
| `goods_notes` INBOUND `deferred` yang sudah dibatalkan (1 baris, tanpa tagihan) | Tidak disentuh — tetap sebagai riwayat dengan `transaction_id` kosong (alasan penegakan lewat trigger INSERT, bukan `NOT NULL`). Nilai `inbound_flow = 'deferred'`-nya disalin ke `archive` sebelum kolomnya dibuang di 0058 | Tes: baris, jurnal, dan pembaliknya tetap utuh. Migration berhenti dengan error kalau ada barang masuk `deferred` yang masih aktif (tidak dibatalkan) |
| `goods_note_billings` | 16 baris, semuanya alur `bundled` dan identik dengan `goods_notes.transaction_id` → dibuang di 0058 | Sebelum drop: salinan ke `archive.goods_note_billings_0058`, jumlah baris arsip = sumber diverifikasi, dan tiap penghubung dicocokkan dengan `goods_notes.transaction_id` (beda = migration batal) |
| `goods_note_billing_allocations` | Hanya foto stok untuk membatalkan tagihan; tidak bernilai akuntansi (koreksi HPP = 0); **0 baris di live** | Selalu disalin ke `archive.goods_note_billing_allocations_0058` sebelum drop (kosong di live) |
| `goods_note_revisions` + `_lines` | 0 baris | Selalu disalin ke `archive.goods_note_revisions_0058` / `goods_note_revision_lines_0058` sebelum drop (kosong di live) |
| `inventory_balances.qty_unbilled` / `spill_value` | Semua 0 | Migration berhenti dengan error kalau ada nilai > 0 |
| Akun 2150 dan jurnal lamanya | Tetap ada (immutable, sudah ada jurnal) | Tidak dihapus; hanya tidak dirujuk Default Akun baru |
| Default Akun `inventory.goods_received_not_invoiced` | Diganti peran baru `inventory.purchase_not_received` | Pemetaan lama disalin ke `archive` |

Skema `archive` tidak diekspos ke API (hanya `public`), jadi data tetap ada tanpa muncul di aplikasi.

**Urutan eksekusi yang aman:** (1) backup database oleh user; (2) query pra-cek (hasil nol di barang masuk belum tertagih); (3) uji `0057`+`0058` di database lokal yang meniru data live (fixture 16 `bundled` + 1 `deferred` dibatalkan + 2 jurnal di 2150: jurnal dan pembaliknya); (4) `0057` + deploy aplikasi baru serentak; (5) verifikasi (jumlah baris, saldo buku besar, saldo stok); (6) `0058` setelah beberapa hari berjalan normal.

### Dampak ke fungsi lain (cek dampak)

| Fungsi/area | Perubahan |
|---|---|
| `consume_weighted_average`, `inventory_restore_stock`, `record_stock_opname`, produksi, tukar barang, `cancel_ar_invoice`, `create_ar_return`, `void_pos_transaction` | **0057: tidak diubah** (`qty_unbilled` selalu 0 sehingga perilakunya sama dengan sebelum 0056). **0058:** disederhanakan setelah kolomnya dibuang |
| `goods_note_is_active` | Barang masuk aktif = tidak ada di `goods_note_cancellations` dan (kalau tagihannya lama `bundled`) tagihannya belum dibatalkan |
| `recompute_order_status`, `goods_note_lines_no_over_fulfill`, `cancel_order` | Tidak berubah (memakai `goods_note_is_active`) |
| `bootstrap_default_accounts` | Ditambah akun Pembelian Belum Diterima + peran Default Akun baru (pola `0054`/`0056`); DB yang sudah ter-onboard dibuatkan akun + peran lewat blok guard `app_settings` |
| Migration `0059` (view baca saja) | `goods_receipts_overview` (daftar/detail barang masuk: status aktif/dibatalkan, tagihan induk, nilai) menggantikan `goods_notes_with_billing_status`; `ap_bills_with_status` mendapat kolom `has_goods_pool` untuk label/filter tipe "Tagihan Barang" di daftar tagihan |
| Halaman aplikasi (sudah ditulis ulang) | `/ap-bills/new/barang` (form Tagihan Barang), `/goods-receipts/new` (barang masuk dari tagihan; `?bill=` dari detail tagihan), Purchase Order → terima barang (pilih tagihan supplier PO), daftar tagihan (tipe + filter), detail tagihan (kartu Kolam Barang: barang masuk, pelepasan sisa dengan konfirmasi), daftar/detail barang masuk (tanpa revisi). Harga hasil konversi satuan dinormalkan UI (`normalizeReceiptLine`: harga dibulatkan ke atas, selisih jadi diskon baris) supaya nilai bersih = nilai nota. Dibuang: halaman Revisi, "Dari Barang Masuk" Dibuang: halaman revisi, "Dari Barang Masuk", penanda merah "belum tertagih" |

### Keterbatasan yang diketahui

- **Sisa kolam yang belum dibayar** ditutup lewat Koreksi Tagihan (`adjust_ap_bill`, lihat `transactions-schema.md`).
- **Selisih harga setelah stok bergerak** dikoreksi lewat Koreksi Barang Masuk; pembagian ke HPP berupa perkiraan kalau harga stok lain jauh berbeda (lihat section di bawah).
- **Satu barang masuk `deferred` yang dibatalkan** tetap berupa riwayat tanpa tagihan; saldonya nol karena jurnalnya sudah dibalik.
- **PPN Masukan** sudah diakui saat tagihan dibuat walau barangnya belum datang — dicatat saja.
- **Pelepasan sisa kolam tidak bisa dibatalkan** (pembulatan maupun uang muka), dan tagihan yang sudah punya pelepasan tidak bisa dibatalkan; nilainya dikoreksi lewat Koreksi Tagihan. UI wajib meminta konfirmasi sebelum melepas.
- **Akun Pembelian Belum Diterima (1370) bisa diposting manual** (jurnal biasa atau baris biaya tambahan yang menunjuk akun itu), yang memecah invarian "saldo = jumlah sisa kolam". Hanya admin yang bisa; UI tagihan tidak menawarkan akun ini di kategori biaya tambahan.
- **Input barang masuk:** qty maksimal 3 desimal dan harga maksimal 2 desimal (sesuai kolom tersimpan); presisi lebih ditolak, bukan dibulatkan.
- **Barang masuk boleh bertanggal sebelum tagihannya**, sehingga akun 1370 bisa bersaldo kredit sementara pada periode itu.
- **View lama `goods_notes_with_billing_status` (0056) tidak benar untuk barang masuk alur baru** (tampil "belum tertagih" tanpa tagihan). UI baru tidak boleh membacanya; view dibuang di 0058.
- **Deploy harus serempak dengan aplikasi:** `create_goods_receipt` lama (7 argumen, 0056) di-drop, jadi UI lama error begitu 0057 diapply.

## Koreksi Barang Masuk

Migration: `supabase/migrations/0060_koreksi_salah_input.sql`. Konsep bisnis: `docs/domain/inventory.md` submodule "Koreksi Barang Masuk".

**Keputusan**

Koreksi = batalkan dokumen lama + buat dokumen baru lewat `create_goods_receipt`, dalam satu transaksi. Dokumen hasil koreksi adalah barang masuk biasa, jadi retur, tukar barang, sisa barang, Purchase Order, dan pembatalan bekerja tanpa cabang khusus. Tabel `goods_note_revisions` lama (0056, dibuang 0058) menyimpan harga efektif di samping dokumen, yang memaksa semua pembaca mengetahuinya; desain itu sengaja gak dipakai lagi.

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `goods_receipt_revisions` | 0..1 baris per dokumen lama: alasan, jumlah koreksi HPP (+ naik, − turun) | `goods_notes.id` (lama, primary key), `goods_notes.id` (baru, unique), `journal_entries.id` (jurnal HPP, kosong kalau gak ada koreksi HPP) |

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Koreksi barang masuk | `revise_goods_receipt` | (1) foto stok tiap item yang terlibat; (2) mutasi kompensasi + jurnal pembalik dokumen lama, tanpa guard stok penuh; (3) `create_goods_receipt` dengan nilai benar; (4) saldo stok final ditimpa dari foto + rumus; (5) jurnal koreksi HPP kalau perlu | Bukan barang masuk lama; belum dibatalkan; alasan dan minimal 1 baris wajib; periode terbuka; sisa barang cukup (dari `create_goods_receipt`); stok cukup dikurangi selisihnya; qty baru gak di bawah yang sudah diretur/ditukar |
| Porsi nilai yang masih di stok | `goods_receipt_stock_share` | Mundur dari stok sekarang lewat `inventory_movements` sesudah dokumen dibuat: tiap mutasi keluar o dari stok Q menyisakan (Q−o)/Q nilai di dalam stok | Dijepit 0–1 |

**Rumus per item** (q0,v0 = lama; q1,v1 = baru; Q,V = stok sebelum koreksi; s = porsi di stok)

- Selisih harga = min(q0,q1) × (v1/q1 − v0/q0). Sisa selisih nilai = selisih qty, seluruhnya di stok.
- Perubahan stok = (selisih nilai − selisih harga) + s × selisih harga. Kalau q0 atau q1 nol, seluruh selisih nilai ke stok.
- Qty baru = Q + q1 − q0. Nilai baru = V + perubahan stok. Qty baru 0 → nilai 0. Nilai baru ≤ 0 padahal qty masih ada → sisa stok dinilai pada harga yang benar.
- Koreksi HPP = selisih nilai − (nilai baru − V), selalu menutup sisanya, jadi jurnal seimbang dan perubahan Persediaan di buku besar sama dengan perubahan nilai stok.

Keterbatasan: `s` menganggap semua mutasi keluar sebagai konsumsi, dan `avg_cost` tersimpan 2 desimal, jadi nilai stok bisa selisih receh dari buku besar (pola yang sama dengan `cancel_goods_receipt`).


## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat daftar penerimaan/pengiriman barang | Semua user yang sudah login |
| Mencatat penerimaan/pengiriman barang baru | Role `admin` atau `accountant` |
| Mengubah atau menghapus yang sudah tercatat | **Tidak ada seorang pun** — immutable total, koreksi lewat Koreksi Barang Masuk atau pembatalan (role `admin`), bukan edit langsung |
