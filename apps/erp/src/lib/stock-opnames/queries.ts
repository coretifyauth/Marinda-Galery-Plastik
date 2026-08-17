import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import type { StockOpname } from "./schema";

export const DEFAULT_PAGE_SIZE = 10;
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

export type StockOpnameFilters = {
  dateFrom: string;
  dateTo: string;
  sourceRefSearch: string;
  page: number;
  pageSize: number;
};

const SELECT_COLUMNS =
  "id, opname_date, source_ref, created_at, stock_opname_lines(id, item_id, qty_system, qty_actual, unit_cost, journal_entry_id, items(name, uom))";

export async function fetchStockOpnames(
  filters: StockOpnameFilters
): Promise<{ rows: StockOpname[]; total: number }> {
  const from = filters.page * filters.pageSize;
  const to = from + filters.pageSize - 1;

  let query = supabase
    .from("stock_opnames")
    .select(SELECT_COLUMNS, { count: "exact" })
    .order("opname_date", { ascending: false })
    .range(from, to);

  if (filters.dateFrom) query = query.gte("opname_date", filters.dateFrom);
  if (filters.dateTo) query = query.lte("opname_date", filters.dateTo);

  const sourceRefTerm = filters.sourceRefSearch.trim();
  if (sourceRefTerm) query = query.ilike("source_ref", `%${sourceRefTerm}%`);

  const { data, error, count } = await query;
  if (error) throw new Error(error.message);
  return { rows: (data ?? []) as unknown as StockOpname[], total: count ?? 0 };
}

export function useStockOpnames(filters: StockOpnameFilters) {
  return useQuery({
    queryKey: ["stock_opnames", filters],
    queryFn: () => fetchStockOpnames(filters),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}
