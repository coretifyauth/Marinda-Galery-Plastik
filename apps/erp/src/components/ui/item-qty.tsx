"use client";

import { useItemUnitMap } from "@/lib/item-units/use-item-unit-map";
import { formatStockBreakdown } from "@/lib/stock-display";

/**
 * Qty (satuan dasar) dalam kombinasi satuan barang: "1 ikat 3 bungkus (234 lembar)". Satuan diambil dari cache
 * `useItemUnitMap`; sebelum termuat (atau barang tanpa item_units) tampil "{qty} {uom}" biasa.
 */
export function ItemQty({ itemId, qty, uom }: { itemId: string | null | undefined; qty: number; uom: string }) {
  const units = useItemUnitMap();
  return <>{formatStockBreakdown(qty, uom, (itemId && units.get(itemId)) || [])}</>;
}
