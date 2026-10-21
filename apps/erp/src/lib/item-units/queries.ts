import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import type { ItemUnit } from "./schema";

// Satuan (item_units) buat sekumpulan item sekaligus -- dipakai form yang barisnya sudah
// ditentukan dari dokumen asal (retur, tukar barang, pengiriman SO), bukan dipilih lewat
// ItemPicker (yang sudah bawa item_units sendiri lewat useItemCache).
export async function fetchItemUnitsForItems(itemIds: string[]): Promise<ItemUnit[]> {
  if (itemIds.length === 0) return [];
  const { data, error } = await supabase
    .from("item_units")
    .select("id, item_id, unit_label, conversion_factor, price, is_base, barcode")
    .in("item_id", itemIds);
  if (error) throw new Error(error.message);
  return (data ?? []) as ItemUnit[];
}

export function useItemUnitsForItems(itemIds: string[]) {
  const key = [...new Set(itemIds)].sort();
  return useQuery({
    queryKey: ["item_units_for_items", key],
    queryFn: () => fetchItemUnitsForItems(key),
    enabled: key.length > 0,
    staleTime: 60_000,
  });
}
