# Checkbox PPN di POS Gak Ikut Default Pengaturan Pajak

**Modul asal:** POS (Fase 1). **Status:** Ditunda.

## Kasus

Checkbox "Kena PPN" di layar kasir POS (`apps/pos/src/app/page.tsx`) selalu default **tidak tercentang** (`useState(false)`), walau `tax_settings.is_active` sudah di-toggle ON di Pengaturan Pajak. Kasir harus manual centang tiap transaksi kalau memang toko ini wajib PPN semua penjualan — gampang kelewat, transaksi jalan tanpa PPN padahal harusnya kena.

## Kenapa ditunda

Perbaikannya sederhana (`useState(taxSettings?.is_active ?? false)` atau `useEffect` sync begitu `taxSettings` selesai di-load — `loadCatalog` fetch `tax_settings` belakangan lewat `Promise.all`, jadi gak bisa langsung dipakai sebagai initial state sebelum data sampai). Ditunda bareng list backlog UX POS lain ([[pos-ux-efficiency-backlog]]) atas permintaan user — dikumpulin dulu jadi 1 batch pengerjaan, bukan dikerjain terpisah-pisah.

## Referensi

- `apps/pos/src/app/page.tsx` (state `applyTax`, `taxSettings`)
- `memory/domain/pos.md`
