# Scan Barcode Lewat Kamera HP/Tablet di POS

**Modul asal:** POS (Fase 1+). **Status:** Ditunda.

## Kasus

Input scan di layar kasir (`apps/pos/src/app/page.tsx`) sekarang cuma `<input type="text">` biasa yang nunggu keystroke — cocok buat scanner fisik mode HID (keyboard emulation, USB/Bluetooth), tapi gak ada jalur scan pakai kamera device (HP/tablet) sama sekali. Kasir yang gak punya scanner fisik terpaksa cari manual dari grid atau ketik kode barcode manual.

## Kenapa ditunda

Butuh akses kamera browser (`navigator.mediaDevices.getUserMedia` atau native `BarcodeDetector` API) + UI overlay kamera buat arahin barcode ke frame — komponen baru, bukan sekadar tambah baris di form yang udah ada. Perlu keputusan juga: pakai `BarcodeDetector` native (dukungan browser belum universal, Safari/iOS masih terbatas) vs library JS pihak ketiga (nambah dependency). Ditunda bareng batch backlog UX POS lain ([[pos-ux-efficiency-backlog]]), ketauan pas user nanya alat scan apa yang dipakai sekarang (2026-08-14) — jawabannya scanner fisik HID doang, kamera belum ke-cover.

## Referensi

- `apps/pos/src/app/page.tsx` (`handleScanSubmit`, `scanInputRef`)
- `memory/domain/inventory.md` submodule "Kode Scan Barang (Barcode/QR per Satuan Jual)"
- [[pos-ux-efficiency-backlog]] — batch backlog UX POS yang sama
