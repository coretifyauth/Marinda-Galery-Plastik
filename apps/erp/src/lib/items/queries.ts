import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import type { Item } from "./schema";

export const DEFAULT_PAGE_SIZE = 10;
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

export type ItemFilters = {
  nameSearch: string;
  itemType: "" | "RAW_MATERIAL" | "FINISHED_GOOD";
  categoryId: string;
  brandId: string;
  page: number;
  pageSize: number;
};

const SELECT_COLUMNS =
  "id, name, item_type, uom, inventory_account_id, category_id, brand_id, archived_at";

export async function fetchItems(filters: ItemFilters): Promise<{ rows: Item[]; total: number }> {
  const from = filters.page * filters.pageSize;
  const to = from + filters.pageSize - 1;

  let query = supabase
    .from("items")
    .select(SELECT_COLUMNS, { count: "exact" })
    .order("name")
    .range(from, to);

  const nameTerm = filters.nameSearch.trim();
  if (nameTerm) query = query.ilike("name", `%${nameTerm}%`);
  if (filters.itemType) query = query.eq("item_type", filters.itemType);
  if (filters.categoryId) query = query.eq("category_id", filters.categoryId);
  if (filters.brandId) query = query.eq("brand_id", filters.brandId);

  const { data, error, count } = await query;
  if (error) throw new Error(error.message);
  return { rows: (data ?? []) as Item[], total: count ?? 0 };
}

export function useItems(filters: ItemFilters) {
  return useQuery({
    queryKey: ["items", filters],
    queryFn: () => fetchItems(filters),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}
