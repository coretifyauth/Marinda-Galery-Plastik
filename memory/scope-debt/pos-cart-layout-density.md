# Layout Keranjang POS Kurang Lega

**Modul asal:** POS (Fase 1+). **Status:** Ditunda.

## Kasus

Panel keranjang di layar kasir (`apps/pos/src/app/page.tsx`) kepenuhan — baris item numpuk sempit (nama, qty +/−, hapus semua di 1 baris `gap-1`), dan area scroll daftar item ($item.length$ baris) berebut tinggi sama section di bawahnya (biaya tambahan, PPN, ringkasan total, metode bayar, pelanggan) yang selalu full-expanded walau lagi gak dipakai. Kasir kesulitan liat banyak baris item sekaligus pas keranjang penuh.

2 pendekatan dipilih user buat digarap (2026-08-14), dari beberapa opsi yang didiskusikan:
- **Baris item dibikin lebih lega** — padding/font diperbesar, qty selector dirapihin biar gak numpuk.
- **Bagian bawah keranjang (biaya tambahan/PPN/metode bayar/pelanggan) di-collapse** jadi accordion/expand-on-demand, biar area scroll daftar item dapet tinggi maksimal.

Opsi lain yang didiskusikan tapi TIDAK dipilih: lebar panel keranjang ditambah (`w-96`→lebih lebar), grid produk dipersempit ke 2 kolom, panel resizable drag-divider.

## Kenapa ditunda

User minta planning dulu, belum implementasi (2026-08-14) — digabung ke batch backlog UX POS yang sama ([[pos-ux-efficiency-backlog]]). Murni perubahan UI lokal `apps/pos/src/app/page.tsx`, gak butuh migration/schema baru.

## Referensi

- `apps/pos/src/app/page.tsx` (panel keranjang, baris `cart.map`, section biaya tambahan/PPN/pembayaran)
- [[pos-ux-efficiency-backlog]] — batch backlog UX POS yang sama
