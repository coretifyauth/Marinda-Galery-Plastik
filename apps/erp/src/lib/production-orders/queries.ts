import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import type { ProductionOrder } from "./schema";

export const DEFAULT_PAGE_SIZE = 10;
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

export type ProductionOrderFilters = {
  dateFrom: string;
  dateTo: string;
  sourceRefSearch: string;
  bomHeaderId: string;
  page: number;
  pageSize: number;
};

const SELECT_COLUMNS =
  "id, bom_header_id, qty_produced, production_date, source_ref, journal_entry_id, created_at, bom_headers(items(name)), production_order_lines(id, item_id, qty_consumed, total_cost, items(name, uom))";

export async function fetchProductionOrders(
  filters: ProductionOrderFilters
): Promise<{ rows: ProductionOrder[]; total: number }> {
  const from = filters.page * filters.pageSize;
  const to = from + filters.pageSize - 1;

  let query = supabase
    .from("production_orders")
    .select(SELECT_COLUMNS, { count: "exact" })
    .order("production_date", { ascending: false })
    .range(from, to);

  if (filters.dateFrom) query = query.gte("production_date", filters.dateFrom);
  if (filters.dateTo) query = query.lte("production_date", filters.dateTo);

  const sourceRefTerm = filters.sourceRefSearch.trim();
  if (sourceRefTerm) query = query.ilike("source_ref", `%${sourceRefTerm}%`);

  if (filters.bomHeaderId) query = query.eq("bom_header_id", filters.bomHeaderId);

  const { data, error, count } = await query;
  if (error) throw new Error(error.message);
  return { rows: (data ?? []) as unknown as ProductionOrder[], total: count ?? 0 };
}

export function useProductionOrders(filters: ProductionOrderFilters) {
  return useQuery({
    queryKey: ["production_orders", filters],
    queryFn: () => fetchProductionOrders(filters),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}
