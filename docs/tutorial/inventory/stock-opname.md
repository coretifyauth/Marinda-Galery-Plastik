# Stock Opname (Penyesuaian Stok Fisik)

## Kapan Melakukan Ini

Setelah hitung fisik stok gudang (rutin atau insidental) dan ditemukan selisih antara catatan sistem dengan hasil hitung fisik — baik selisih kurang (barang hilang/susut) maupun selisih lebih (barang tercatat kurang dari kenyataan).

## Prasyarat

- Login dengan role **admin** atau **accountant**.
- Sudah punya hasil hitung fisik terbaru per item yang mau disesuaikan.

## Langkah-Langkah

1. Buka menu **Stock Opnames** (`/stock-opnames`).
2. Klik tombol **+ New**. Modal **Catat Sesi Opname** terbuka.
3. Baca catatan: isi hasil hitung fisik per item — **item yang hasilnya sama dengan catatan sistem otomatis dilewati**, tidak perlu dihapus dari daftar atau memaksakan isi kalau memang tidak ada selisih.
4. Isi **Tanggal Opname**.
5. Untuk tiap baris item yang mau dicek: pilih **Item**, lihat **Qty Sistem** (ditampilkan otomatis, read-only, untuk perbandingan), lalu isi **Hasil Hitung per Satuan** — qty fisik yang benar-benar ditemukan, boleh pakai satuan apa pun (base atau satuan jual lain).
6. Klik **Simpan**.

## Hasil Akhir

- Untuk tiap item yang hasil hitungnya **beda** dari sistem, jurnal per baris otomatis terbentuk (tidak di-netting jadi 1 angka gabungan, tiap item punya jurnalnya sendiri):
  - **Selisih kurang** (fisik < sistem): debit Akun Beban Selisih Persediaan, kredit Akun Persediaan.
  - **Selisih lebih** (fisik > sistem): debit Akun Persediaan, kredit Akun Pendapatan Selisih Persediaan.
- Item yang hasil hitungnya sama dengan sistem **tidak menghasilkan jurnal apa pun** (tidak ada aktivitas tercatat untuk item itu).
- Setelah opname, saldo stok sistem langsung mengikuti hasil hitung fisik yang baru.

## Kesalahan Umum

- **Mengisi ulang qty yang sebenarnya sama dengan sistem** — tidak masalah kalau dilakukan (tidak menghasilkan jurnal karena selisihnya nol), tapi tidak perlu, cukup lewati baris itu.
- **Salah satuan saat isi Hasil Hitung** — pastikan satuan yang dipilih di field itu sesuai dengan cara stafnya menghitung fisik (mis. hitung per lusin vs per buah), karena ini memengaruhi konversi ke satuan dasar yang tersimpan.
- **Menggabungkan selisih beberapa item jadi 1 nominal manual** — sistem sudah otomatis membuat jurnal terpisah per item, tidak perlu (dan tidak bisa) di-netting manual jadi 1 baris gabungan.
