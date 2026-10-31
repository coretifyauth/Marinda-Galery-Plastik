# PPN Masukan tagihan barang tidak disesuaikan kalau barang batal datang

**Modul asal:** Accounts Payable / Tax — "Tagihan Dulu, Barang Menyusul" (kolam tagihan). **Status:** Ditunda.

## Kasus

Tagihan barang dengan PPN Masukan dibuat dari nota supplier: PPN dihitung dan dijurnal penuh (Debit PPN Masukan) saat tagihan dibuat, di luar kolam barang. Kalau sebagian barangnya tidak pernah datang dan sisa kolam dilepas (pembulatan atau uang muka), PPN atas bagian barang yang batal itu tetap tercatat sebagai PPN Masukan. Tidak ada penyesuaian pajak saat pelepasan kolam.

## Kenapa ditunda

Secara perpajakan PPN Masukan diakui dari faktur pajak yang diterima, bukan dari barang yang datang, jadi perlakuan sekarang konsisten dengan faktur supplier. Penyesuaian yang benar (nota retur/faktur pajak pengganti dari supplier) adalah keputusan perpajakan dan butuh dokumen koreksi sendiri; Koreksi Tagihan (`adjust_ap_bill`, migration `0060`) sudah mencatat nota kredit tapi hanya menyesuaikan nilai barang, belum PPN-nya. Belum ada kasus nyata.

## Referensi

- `docs/domain/accounts-payable.md` — submodule "Tagihan Dulu, Barang Menyusul (Kolam Tagihan)" dan "Kategori Campur & PPN".
- `docs/architecture/goods-notes-schema.md` — "Keterbatasan yang diketahui" (PPN Masukan).
