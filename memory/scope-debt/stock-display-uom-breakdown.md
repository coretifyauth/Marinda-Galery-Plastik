# Tampilan Stok Breakdown Satuan (Box/Pack/Pcs) di ERP & POS

**Modul asal:** Inventory / POS, cross-cutting (Fase 1+). **Status:** Ditunda.

## Kasus

Tampilan stok (`inventory_balances.qty_on_hand`) di ERP maupun POS sekarang cuma nampilin angka satuan dasar mentah (misal "150 pcs"). Harusnya breakdown otomatis dari satuan terbesar ke terkecil pakai `item_units.conversion_factor`, biar gampang dibaca kasir/gudang.

Contoh item dengan satuan pcs (dasar) / pack (1 pack = 12 pcs) / box (1 box = 144 pcs):
- Stok 150 pcs → tampil "1 box, 6 pcs" (150 = 1×144 + 0×12 + 6)
- Stok 166 pcs → tampil "1 box, 1 pack, 4 pcs" (166 = 1×144 + 1×12 + 4×1)

Greedy breakdown: urut satuan dari `conversion_factor` terbesar ke terkecil, tiap satuan ambil `floor(sisa / conversion_factor)`, sisanya lanjut ke satuan berikutnya.

## Kenapa ditunda

Ketauan pas ngerjain fix katalog POS (`apps/pos/src/app/page.tsx`, multi-unit selector di kartu grid) — `qtyOnHand` yang ditampilkan (baik di POS maupun di `/items` ERP) masih angka satuan dasar polos, gak ada logic breakdown ke satuan campuran sama sekali. Ini murni gap tampilan (read-only, gak nyentuh `inventory_balances`/RPC manapun) — beda dari `MultiUomQtyInput` yang urusannya INPUT qty campuran, ini soal OUTPUT/display qty campuran, arah kebalikannya. Ditunda karena belum ada keputusan desain soal:
- Item tanpa `item_units` lengkap (cuma base, atau malah 0 baris) — fallback-nya gimana.
- Satuan yang `conversion_factor`-nya gak bersarang rapi (misal 1 lusin=12 tapi 1 box=100, bukan kelipatan 12) — breakdown greedy bisa nyisain pecahan gak presisi ke satuan dasar kalau urutan konversi gak konsisten.
- Ditaruh di mana: komponen shared dipakai ERP+POS itu 2 Next.js app terpisah, gak ada shared package antar `apps/erp`/`apps/pos` sekarang (lihat `memory/architecture/app/tech-stack-decisions.md`) — perlu keputusan duplikasi logic vs bikin package baru.

## Referensi

- `memory/domain/inventory.md` submodule "Satuan Jual & Harga" (`item_units`, `conversion_factor`)
- `apps/erp/src/components/ui/multi-uom-qty-input.tsx` (pola input kebalikan — qty campuran ke satuan dasar)
- `apps/pos/src/app/page.tsx` (tempat gap ini ketauan, `CatalogItem.qtyOnHand`)
