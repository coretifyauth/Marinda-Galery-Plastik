import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import type { BomHeader } from "./schema";

export const DEFAULT_PAGE_SIZE = 10;
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

export type BomFilters = {
  isActive: "" | "true" | "false";
  finishedItemId: string;
  page: number;
  pageSize: number;
};

const SELECT_COLUMNS =
  "id, finished_item_id, output_qty, is_active, created_at, items(name, uom), bom_lines(id, raw_material_item_id, qty_per_batch, items(name, uom))";

export async function fetchBoms(
  filters: BomFilters
): Promise<{ rows: BomHeader[]; total: number }> {
  const from = filters.page * filters.pageSize;
  const to = from + filters.pageSize - 1;

  let query = supabase
    .from("bom_headers")
    .select(SELECT_COLUMNS, { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, to);

  if (filters.isActive) query = query.eq("is_active", filters.isActive === "true");
  if (filters.finishedItemId) query = query.eq("finished_item_id", filters.finishedItemId);

  const { data, error, count } = await query;
  if (error) throw new Error(error.message);
  return { rows: (data ?? []) as unknown as BomHeader[], total: count ?? 0 };
}

export function useBoms(filters: BomFilters) {
  return useQuery({
    queryKey: ["bom_headers", filters],
    queryFn: () => fetchBoms(filters),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}
