# Kirim & Penuhi Sales Order (Bertahap)

## Kapan Melakukan Ini

Saat barang pesanan dari Sales Order benar-benar dikirim ke pelanggan — boleh dikirim penuh sekaligus atau bertahap (misal karena stok belum cukup semua, atau pelanggan minta dicicil pengirimannya). Setiap kali dikirim, **AR Invoice baru langsung terbit** senilai qty yang dikirim saat itu — tidak menunggu SO terpenuhi 100%.

## Prasyarat

- Login dengan role **admin** atau **accountant**.
- Sales Order-nya sudah ada dan belum terkirim penuh — kalau belum ada, buat dulu lewat [buat-sales-order.md](buat-sales-order.md).
- Stok barang yang mau dikirim mencukupi.

## Langkah-Langkah

1. Buka detail Sales Order (`/sales-orders/[id]`), tab **Pengiriman (Goods Issue + Invoice)**.
2. Klik tombol **Kirim / Penuhi**.
3. Baca catatan di modal: tiap kali dikirim, invoice baru terbit senilai qty yang dikirim **sekarang**, bukan nunggu SO ini terpenuhi penuh.
4. Isi **Tanggal Kirim/Invoice** dan **Deskripsi** (mis. "Kirim tahap 1 dari SO ini").
5. Untuk tiap baris **Item (sisa SO)**, isi **Qty Kirim** — boleh kurang dari sisa (dikirim bertahap lagi nanti), boleh sekaligus semua sisa.
6. Klik **Simpan** (kalau semua item sisa SO sudah nol, form akan menampilkan "sudah terkirim penuh" dan tidak ada lagi yang bisa dikirim).

## Hasil Akhir

- AR Invoice baru otomatis terbit untuk qty yang dikirim kali ini saja (bisa dilihat di menu AR Invoices).
- Stok barang berkurang, HPP tercatat — sama seperti [jual-barang-goods-issue.md](jual-barang-goods-issue.md), tapi terhubung ke SO ini.
- Status SO berubah jadi **PARTIALLY_FULFILLED** (kalau masih ada sisa qty belum dikirim) atau **FULLY_FULFILLED** (kalau semua qty sudah dikirim).
- Invoice yang terbit dari tiap pengiriman ini bisa dibayar terpisah, masing-masing lewat langkah [terima-pembayaran-ar.md](../accounts-receivable/terima-pembayaran-ar.md).

## Kesalahan Umum

- **Berharap 1 invoice besar terbit untuk seluruh SO** — tidak, tiap kali kirim (fulfillment) menerbitkan invoice terpisah senilai qty yang dikirim saat itu; kalau dikirim 3 tahap, jadi 3 invoice terpisah.
- **Mencoba kirim lebih dari sisa qty SO** — field Qty Kirim otomatis terbatas maksimum sisa yang belum dikirim per item.
- **Bingung SO tidak muncul lagi untuk dikirim** — kalau statusnya sudah FULLY_FULFILLED atau CANCELLED, tidak ada lagi yang bisa dikirim dari SO itu; susulan pesanan harus jadi SO baru.
