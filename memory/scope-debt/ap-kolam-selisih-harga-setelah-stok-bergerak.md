# Selisih nilai nota setelah stok bergerak belum punya jalur koreksi

**Modul asal:** Accounts Payable / Inventory — "Tagihan Dulu, Barang Menyusul" (kolam tagihan). **Status:** Ditunda.

## Kasus

Tagihan barang dibuat dari nominal perkiraan Rp10 juta, barang masuk dicatat, sebagian sudah terjual. Notanya baru datang dengan nilai Rp10,2 juta. Satu barang masuk terikat tepat satu tagihan dan tidak ada revisi harga, jadi satu-satunya koreksi adalah **batal-ulang**: batalkan barang masuk, batalkan tagihan, buat ulang dengan nilai benar. Itu hanya jalan kalau tagihan belum punya pembayaran/retur/uang muka dan stok cukup untuk dibalik (`cancel_goods_receipt` menolak kalau stok sudah terjual; `cancel_ap_bill` menolak kalau ada pembayaran). Begitu stok sudah bergerak, tidak ada jalur untuk menaikkan nilai tagihan dan biaya persediaan.

## Kenapa ditunda

Alur lama (0056) menanganinya dengan koreksi HPP lintas periode (`qty_unbilled`, `spill_value`, jurnal koreksi) yang sengaja dibuang karena kompleks dan membuka banyak kasus tepi (avg cost negatif, pembatalan harus berurutan terbalik). Menggantinya butuh keputusan desain baru: tagihan tambahan di atas tagihan yang ada, atau dokumen "nota debit" yang menambah kolam dan menyesuaikan nilai barang masuk yang sudah ada. Dipilih ditunda karena belum ada kasus nyata dan batal-ulang mencakup kasus yang paling umum (nota datang tidak lama setelah barang, stok belum terjual).

## Referensi

- `docs/domain/accounts-payable.md` — submodule "Tagihan Dulu, Barang Menyusul (Kolam Tagihan)", poin "Nota telat = barang belum bisa dicatat" dan Aturan Bisnis (selisih nilai setelah stok bergerak).
- `docs/domain/inventory.md` — submodule "Barang Masuk dari Tagihan".
- `docs/architecture/goods-notes-schema.md` — "Keterbatasan yang diketahui".
