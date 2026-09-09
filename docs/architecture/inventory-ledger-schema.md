# Inventory Ledger — Struktur Data

Dua hal yang sering ketukar tapi beda fungsi: **saldo stok berjalan** (`inventory_balances` — qty & harga rata-rata SAAT INI per barang) dan **Kartu Stok/riwayat mutasi** (`inventory_movements` — histori kronologis tiap kejadian yang menggerakkan qty). Cross-cutting — dibaca/ditulis dari hampir semua RPC transaksi Inventory (Terima Barang, Produksi, Jual, Retur, Opname, POS). Konsep bisnis metode costing ada di `docs/domain/inventory.md` bagian "Kenapa Butuh Metode Costing", riwayat mutasi ada di bagian "Kartu Stok / Riwayat Mutasi per Item". Detail teknis: `supabase/migrations/0023_inventory_ledger_schema.sql`.

**Migration final (2026-09-07):** `supabase/migrations/0023_inventory_ledger_schema.sql`
(+ `0026_inventory_movements_exactly_one_source_constraint.sql`) — konsolidasi dari migration
incremental lama (sudah dihapus, historinya ada di `git log`). Nomor migration `00XX` yang
disebut di dokumen ini historis.

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `inventory_balances` | Saldo stok tersimpan per barang — qty tersedia + harga rata-rata berjalan (Weighted Average), satu-satunya state costing yang hidup di modul ini | `items` (satu-ke-satu) |
| `inventory_movements` | Kartu Stok — riwayat kronologis tiap mutasi qty 1 barang, 1 baris = 1 kejadian, nunjuk balik ke TEPAT SATU dari 7 kemungkinan dokumen sumber (dijamin database) | `items`, dan satu dari 7 tabel sumber transaksi |

## Saldo Berjalan (Weighted Average Costing)

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `inventory_balances` | Saldo stok tersimpan per barang | `items` (satu-ke-satu) |

**Struktur (kolom yang penting buat dipahami)**

| Kolom | Isinya | Catatan |
|---|---|---|
| `item_id` | PK sekaligus FK ke `items` | Bukan `id` terpisah — struktural mastiin maksimal 1 baris per barang, gak butuh `unique` constraint tambahan |
| `qty_on_hand` | Sisa stok saat ini | Berkurang tiap konsumsi/penjualan, bertambah tiap penerimaan — **satu-satunya kolom di modul ini yang disimpan LANGSUNG**, bukan derived (dihitung ulang dari histori) |
| `avg_cost` | Harga rata-rata per unit saat ini | Berubah tiap ada penerimaan baru (dicampur dengan stok lama), TETAP saat barang keluar/dikonsumsi. Dihitung ulang secara INCREMENTAL tiap transaksi — rekursif, gak bisa diringkas jadi 1 query agregat sederhana kayak `SUM` |

**Metode costing tunggal**: semua barang, tanpa kecuali, pakai metode costing yang sama — Weighted Average (Rata-Rata Tertimbang). Tidak ada kolom atau tabel untuk memilih metode costing per barang — `inventory_balances` cuma menyimpan qty & harga rata-rata berjalan, satu struktur yang berlaku untuk seluruh katalog barang.

**Kenapa disimpan langsung, bukan derived seperti kolom lain di project ini** — beda dari pola cache status AR/AP/Order/POS/Deposit (`transactions-schema.md`, kolom cache yang MASIH bisa dihitung ulang dari nol kapan aja dari agregat `SUM`/`CASE` yang sama persis), `avg_cost` gak bisa dihitung ulang dari nol tanpa memproses riwayat transaksinya berurutan (incremental) — jadi harus disimpan sebagai state, bukan sekadar cache dari agregat.

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Konsumsi stok (dipakai submodule Produksi & Penjualan, bukan dipanggil langsung dari client) | Fungsi bersama konsumsi rata-rata (`consume_weighted_average`) | Mengurangi `qty_on_hand` langsung, `avg_cost` tidak berubah saat konsumsi (cuma berubah saat penerimaan baru) — satu-satunya tempat logika konsumsi stok ditulis, dipakai bareng `production-orders-schema.md` dan Goods Issue biar tidak duplikat logika | Menolak konsumsi yang melebihi `qty_on_hand` yang tersedia |
| Penerimaan barang baru (menambah stok) | Bagian dari RPC penerimaan barang (lihat `goods-receipt-schema.md`) | Menghitung ulang `avg_cost` dari campuran stok lama + stok masuk (`new_avg = (qty_before×avg_before + qty_in×unit_cost_in) / (qty_before+qty_in)`), lalu menambah `qty_on_hand` | — |
| Penyesuaian ke hasil hitung fisik | `record_stock_opname` (`stock-opname-schema.md`) | Langsung set `qty_on_hand` ke hasil hitung fisik — **satu-satunya jalur yang menulis `qty_on_hand` TANPA lewat kejadian transaksi eksplisit** (semua RPC lain selalu lewat kejadian jelas: penerimaan, produksi, jual, retur, write-off). `avg_cost` tidak disentuh | — |

**Aturan Bisnis → RPC**

| Aturan (dari `docs/domain`) | Dijaga oleh |
|---|---|
| Semua barang pakai satu metode costing yang sama (Rata-Rata Tertimbang) | Tidak ada kolom pemilihan metode per barang — hanya satu metode yang berlaku untuk semua barang |
| Harga rata-rata dihitung incremental, bukan diringkas dari histori | `inventory_balances` disimpan sebagai state langsung (bukan derived), di-update tiap transaksi lewat fungsi konsumsi/penerimaan bersama |
| Konsumsi/pengurangan stok tidak boleh melebihi stok tersedia | `consume_weighted_average` menolak kalau qty yang diminta melebihi `qty_on_hand` |
| Opname murni menyesuaikan qty, bukan harga per unit | `record_stock_opname` sengaja tidak menyentuh `avg_cost` sama sekali |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `inventory_balances` | satu-ke-satu | `items` |
| `inventory_balances` | dikonsumsi lewat `consume_weighted_average` dari | `production-orders-schema.md`, Goods Issue |
| `inventory_balances` | ditambah dari | `goods-receipt-schema.md`, `production-orders-schema.md` (barang jadi hasil produksi) |
| `inventory_balances.qty_on_hand` | disesuaikan langsung oleh | `stock-opname-schema.md` |

## Kartu Stok / Riwayat Mutasi (`inventory_movements`)

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `inventory_movements` | 1 baris = 1 kejadian mutasi qty 1 barang, ditulis sebagai efek samping RPC transaksi yang sudah ada (bukan RPC baru berdiri sendiri) | `items`, dan tepat 1 dari 7 tabel sumber transaksi (penerimaan barang & goods issue & POS — 1 kolom sama, dibedakan arahnya; produksi — hasil & konsumsi, 2 kolom terpisah; retur — dari customer maupun ke pemasok, digabung 1 kolom dibedakan lewat arahnya; opname; penggantian garansi; tukar barang ke pemasok) |

**Struktur (kolom yang penting buat dipahami)**

| Kolom | Isinya | Catatan |
|---|---|---|
| `qty` | Bertanda — positif = masuk, negatif = keluar | Bukan kolom `direction` terpisah, supaya `SUM(qty)` langsung jadi saldo, gak perlu `CASE WHEN` di tiap query |
| `movement_date` | Tanggal transaksi ASLI dari tabel sumbernya (mis. tanggal terima barang, tanggal produksi) | Bukan `created_at` — bisa beda kalau ada input mundur; ini kolom yang dipakai query saldo pembuka & pengurutan histori |
| 7 kolom penunjuk sumber (nullable, tepat 1 terisi per baris) | Jenis mutasinya ditentukan dari kolom mana yang terisi | Dijamin `check(num_nonnulls(...) = 1)` di level database. Sempat tidak aktif untuk sementara (hilang gak sengaja sejak penghapusan salah satu jalur retur lama, gagal dipulihkan karena ada 2 baris data lama yang menyimpang) — sudah dipulihkan setelah data historis dibersihkan total. |
| Saldo berjalan | **TIDAK disimpan** sebagai kolom | Dihitung ulang tiap kali dibaca (saldo pembuka + akumulasi baris di halaman itu) demi akurasi — gak ada risiko nilai tersimpan diam-diam menyimpang dari data mutasi asli |

**Kenapa tabel ledger terpusat, bukan view gabungan** — keputusan arsitektur eksplisit: baca riwayat lebih cepat & konsisten jangka panjang (1 tabel rapi, gak perlu buka ±10 tabel tiap kartu stok dibuka), ditukar biaya awal lebih besar (harus ubah ±9-10 RPC transaksi yang sudah ada + backfill data historis).

**Kenapa composite FK `(source_id, item_id)`, bukan FK 1 kolom** — FK 1 kolom cuma menjamin ID-nya ada di tabel sumber yang benar, gak menjamin `item_id` di baris movement cocok sama `item_id` di baris sumber yang ditunjuk (kelas bug yang rawan muncul karena logika insert disebar ke banyak RPC berbeda). Composite FK bikin database sendiri yang menjamin pasangan itu match, gak perlu trigger validasi tambahan.

Sumber dari `purchase-replacements-schema.md` (opsi "tukar barang" pada retur ke pemasok) punya kolom sumber tersendiri karena RPC-nya ngeluarin barang rusak DAN memasukkan barang pengganti sekaligus (2 kejadian fisik nyata, walau net qty-nya nol karena barangnya sama). Ini juga **satu-satunya kasus 1 baris dokumen sumber = 2 baris Kartu Stok sekaligus** (1 qty negatif buat barang rusak keluar, 1 qty positif buat barang pengganti masuk) — sah karena `check num_nonnulls(...) = 1` dicek per baris LEDGER, bukan per baris dokumen sumber.

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Tiap transaksi yang menggerakkan stok (Terima Barang, Produksi, Jual/Goods Issue, POS, retur dari customer, retur ke pemasok, tulis-jadi-beban, penggantian garansi, tukar barang, opname) | Seluruh RPC transaksi yang **sudah ada** di modul-modul terkait (`goods-receipt-schema.md`, `production-orders-schema.md`, Goods Issue, `stock-opname-schema.md`, `warranty-replacements-schema.md`, `purchase-replacements-schema.md`, `pos-schema.md`) — **tidak ada RPC baru berdiri sendiri** | Selain efek aslinya (jurnal, update `inventory_balances`), tiap RPC itu JUGA insert 1 (atau lebih, khusus kasus tukar barang) baris ke `inventory_movements` — otomatis, tidak butuh langkah tambahan dari user | Baris wajib nunjuk ke SATU dokumen sumber yang benar-benar ada DAN `item_id`-nya cocok — dijamin composite FK + `check num_nonnulls` di level database, gak bisa lolos walau ada salah ketik di kode RPC |
| Pembatalan transaksi POS | `void_pos_transaction` | Insert baris KOMPENSASI (qty positif = pemulihan) yang menunjuk ke baris Goods Issue yang SAMA dengan baris keluar aslinya (sejak POS diunifikasi ke mesin Goods Issue umum — `pos-schema.md`, gak ada lagi kolom sumber POS tersendiri) — ini bukan mencatat mutasi baru, tapi membatalkan efek mutasi lama | Polanya sama seperti tukar barang: 1 dokumen sumber bisa punya lebih dari 1 baris di Kartu Stok |
| Lihat riwayat 1 barang (halaman Kartu Stok) | — (query baca, lewat view join yang me-resolve nama dokumen sumber) | Saldo pembuka halaman dihitung sekali (total `SUM(qty)` sampai titik cutoff), baris-baris di halaman itu ditambah/dikurangi dari situ — supaya buka halaman manapun (baru atau lama) tetap cepat walau riwayat barangnya sudah sangat panjang | — |

**Aturan Bisnis → RPC**

| Aturan (dari `docs/domain`) | Dijaga oleh |
|---|---|
| Kartu Stok gak pernah jadi sumber kebenaran baru — `inventory_balances` tetap yang utama | Baris `inventory_movements` murni catatan pendamping, gak pernah dibaca balik buat menghitung ulang qty/HPP di RPC manapun |
| Cakupan mencakup SEMUA jalur yang menggerakkan stok, bukan cuma jalur inti (beli/produksi/jual) | 8 kolom sumber mencakup juga retur (dari customer maupun ke pemasok, 1 kolom gabungan dibedakan arahnya), penggantian garansi, dan tukar barang |
| Tiap baris riwayat tertelusur ke 1 dokumen sumber yang valid dan barangnya cocok | Composite FK `(source_id, item_id)` + `check num_nonnulls(...) = 1` — dijamin di level database, bukan cuma disiplin kode |
| Riwayat tidak boleh diedit/dihapus | Trigger `block_edit_delete` — 2 lapis proteksi bareng RLS default-deny |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `inventory_movements` | banyak-ke-satu | `items` |
| `inventory_movements` | tiap baris nunjuk ke TEPAT SATU dari 8 kemungkinan | penerimaan barang, produksi (hasil & konsumsi), retur dari customer, opname, goods issue (termasuk POS, sejak diunifikasi ke mesin Goods Issue umum), retur ke pemasok, penggantian garansi, tukar barang ke pemasok |
| Tukar barang ke pemasok (`purchase-replacements-schema.md`, opsi "tukar barang") | SATU-SATUNYA kasus 1 dokumen sumber = 2 baris ledger sekaligus | `inventory_movements` |

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat saldo stok & Kartu Stok | Semua user yang sudah login |
| Menambah/mengubah saldo stok (`inventory_balances`) | Role `admin` atau `accountant` — selalu lewat RPC transaksi, tidak pernah diubah manual langsung |
| Menulis baris Kartu Stok (`inventory_movements`) | Role `admin` atau `accountant` — kecuali RPC penjualan POS yang `security definer`, tetap bisa insert lewat privilege pemilik fungsi walau role kasir sendiri gak punya akses insert langsung |
| Mengedit/menghapus baris Kartu Stok atau saldo stok secara manual | **Tidak ada seorang pun** |
