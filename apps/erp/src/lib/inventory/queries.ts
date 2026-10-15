import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import type { Item } from "@/lib/items/schema";
import type { ItemUnit } from "@/lib/item-units/schema";
import type { InventoryBalance } from "./schema";

export const DEFAULT_PAGE_SIZE = 100;
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

export type StockPositionFilters = {
  nameSearch: string;
  itemType: "" | "RAW_MATERIAL" | "FINISHED_GOOD";
  categoryId: string;
  brandId: string;
  stock: "" | "ada"; // "ada" = hanya yang qty_on_hand > 0
  page: number;
  pageSize: number;
};

export type StockPositionRow = Item & {
  inventory_balances: Pick<InventoryBalance, "qty_on_hand" | "avg_cost"> | null;
  item_units: ItemUnit[];
};

// Saldo + satuan jual di-embed per item di halaman ini saja (bukan fetch semua item lalu
// .find() di client). "Ada stok" pakai !inner supaya filter qty jalan di server.
const SELECT_COLUMNS =
  "id, name, item_type, uom, inventory_account_id, category_id, brand_id, archived_at, item_units(id, item_id, unit_label, conversion_factor, price, is_base)";

export async function fetchStockPosition(
  filters: StockPositionFilters
): Promise<{ rows: StockPositionRow[]; total: number }> {
  const from = filters.page * filters.pageSize;
  const to = from + filters.pageSize - 1;
  const balances =
    filters.stock === "ada"
      ? "inventory_balances!inner(qty_on_hand, avg_cost)"
      : "inventory_balances(qty_on_hand, avg_cost)";

  let query = supabase
    .from("items")
    .select(`${SELECT_COLUMNS}, ${balances}`, { count: "exact" })
    .is("archived_at", null)
    .order("name")
    .range(from, to);

  const nameTerm = filters.nameSearch.trim();
  if (nameTerm) query = query.ilike("name", `%${nameTerm}%`);
  if (filters.itemType) query = query.eq("item_type", filters.itemType);
  if (filters.categoryId) query = query.eq("category_id", filters.categoryId);
  if (filters.brandId) query = query.eq("brand_id", filters.brandId);
  if (filters.stock === "ada") query = query.gt("inventory_balances.qty_on_hand", 0);

  const { data, error, count } = await query;
  if (error) throw new Error(error.message);
  return { rows: (data ?? []) as unknown as StockPositionRow[], total: count ?? 0 };
}

export function useStockPosition(filters: StockPositionFilters) {
  return useQuery({
    queryKey: ["stock_position", filters],
    queryFn: () => fetchStockPosition(filters),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}
