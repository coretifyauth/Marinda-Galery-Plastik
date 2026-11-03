import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchAllItemUnits } from "@/lib/inventory/flow";
import type { StockBreakdownUnit } from "@/lib/stock-display";

/**
 * Satuan (item_units) semua barang, dikelompokkan per item_id — satu query ter-cache dipakai bersama semua
 * halaman, jadi tampilan qty dalam kombinasi satuan tidak perlu mengubah query tiap halaman.
 */
export function useItemUnitMap(): Map<string, StockBreakdownUnit[]> {
  const { data } = useQuery({ queryKey: ["item_units_all"], queryFn: fetchAllItemUnits, staleTime: 60_000 });
  return useMemo(() => {
    const map = new Map<string, StockBreakdownUnit[]>();
    for (const r of data ?? []) {
      const list = map.get(r.item_id) ?? [];
      list.push({ unit_label: r.unit_label, conversion_factor: Number(r.conversion_factor) });
      map.set(r.item_id, list);
    }
    return map;
  }, [data]);
}
