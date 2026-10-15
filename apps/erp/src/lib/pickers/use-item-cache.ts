import { useCallback, useState } from "react";
import type { Item } from "@/lib/items/schema";
import type { ItemUnit } from "@/lib/item-units/schema";
import type { ItemWithUnits } from "./search";

// Cache item+satuan yang SUDAH dipilih di form (bukan seluruh katalog). Form tetap bisa
// items.find(...) / itemUnits.filter(...) sync untuk item di barisnya.
export function useItemCache() {
  const [items, setItems] = useState<Item[]>([]);
  const [itemUnits, setItemUnits] = useState<ItemUnit[]>([]);

  const remember = useCallback((it: ItemWithUnits) => {
    const { item_units, ...item } = it;
    setItems((prev) => (prev.some((x) => x.id === item.id) ? prev : [...prev, item as Item]));
    setItemUnits((prev) => [...prev.filter((u) => u.item_id !== item.id), ...item_units]);
  }, []);

  return { items, itemUnits, remember };
}
