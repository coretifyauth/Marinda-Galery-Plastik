# Backlog Efisiensi UX Kasir POS

**Modul asal:** POS (Fase 1+). **Status:** Ditunda.

## Kasus

Layar kasir (`apps/pos/src/app/page.tsx`) jalan (grid katalog + keranjang + checkout), tapi belum dioptimasi buat kecepatan kerja kasir sehari-hari. User minta list opsi improvement (2026-08-14), dipilih 9 item buat digarap belakangan (bukan sekarang):

1. **Search/filter box** — grid sekarang gak ada pencarian, kasir scroll manual nyari item.
2. **Kategori/tab item** — `items.category_id`/`item_categories` udah ada di schema (`0023_item_categories_brands.sql`), belum dipakai buat kelompokin grid POS.
3. **Qty +/− langsung dari kartu grid** — sekarang nambah qty >1 harus klik kartu berkali-kali atau geser ke panel keranjang.
5. **Keyboard shortcut** — mapping yang didiskusikan: `1`-`9` pilih/tambah kartu ke-N di grid, `Enter` checkout, `Esc` kosongin cart, `Backspace` hapus baris terakhir cart, `+`/`-` ubah qty baris terakhir, `/` atau `Ctrl+F` fokus search (item 1), `F2` toggle metode bayar. Keputusan yang perlu diambil sebelum implementasi: shortcut angka 1-9 ikut posisi grid (bisa geser kalau search/filter aktif, berisiko bingung) vs badge angka statis per item (butuh mekanisme pin terpisah).
6. **Numpad qty custom** — input angka manual per baris cart (bukan cuma +/−1), berguna buat qty besar (mis. beli 1 lusin sekaligus).
8. **Preview total & kembalian** — input "Uang Diterima" pas metode Tunai, hitung kembalian real-time, validasi gak boleh kurang dari total.
9. **Riwayat transaksi cepat / cetak ulang struk** — panel list `pos_sales` transaksi terakhir + tombol cetak ulang, reuse pola print-window (`window.open()+window.print()`) yang sudah dipakai buat label barcode `item_units`.
10. **Auto-fokus scan input abis checkout** — sekarang `scanInputRef` cuma `autoFocus` pas mount awal, gak balik fokus otomatis abis transaksi sukses, motong alur scan-scan-checkout-scan.
11. **Struk digital** — belum ada mekanisme cetak/kirim struk sama sekali. 2 sub-opsi gak exclusive: print thermal (reuse pola `window.print()` item 9) dan kirim WhatsApp (butuh keputusan: API WhatsApp Business resmi berbayar, vs cukup `wa.me` link manual + teks struk yang kasir kirim sendiri).

## Kenapa ditunda

User eksplisit minta planning dulu, belum implementasi (2026-08-14) — 9 item ini prioritas dipilih dari list awal yang lebih panjang (item 4 "reorder item terlaris", 7 "favorit per kasir", 12 "split payment" GAK dipilih, masih di luar scope). Sebagian besar (1/2/3/6/8/10) murni perubahan UI lokal `apps/pos/src/app/page.tsx`, gak butuh migration baru. Item 9/11 butuh keputusan desain kecil (cakupan riwayat, mekanisme kirim WhatsApp) sebelum dikerjain. Item 5 butuh 1 keputusan UX (basis penomoran shortcut) sebelum diimplementasi.

## Referensi

- `apps/pos/src/app/page.tsx`
- `memory/domain/pos.md`
- [[pos-ppn-default-checkbox]] — bug terpisah, ditunda bareng batch yang sama
