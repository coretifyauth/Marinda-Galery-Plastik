import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import type { PosSaleListRow, PosSaleStatus } from "./schema";

export const DEFAULT_PAGE_SIZE = 10;
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

export type PosSaleFilters = {
  dateFrom: string;
  dateTo: string;
  sourceRefSearch: string;
  customerId: string;
  status: PosSaleStatus | "";
  page: number;
  pageSize: number;
};

// pos_sales_with_status (migration 0036) -- status/total udah terhitung server-side, jadi list
// gak perlu lagi fetch nested pos_sale_lines atau query journal_entries.reverses_entry_id
// terpisah cuma buat dihitung ulang di client.
const SELECT_COLUMNS =
  "id, sale_date, source_ref, revenue_journal_entry_id, total, status, counterparties(name), cash_account:accounts!cash_account_id(code, name)";

export async function fetchPosSales(
  filters: PosSaleFilters
): Promise<{ rows: PosSaleListRow[]; total: number }> {
  const from = filters.page * filters.pageSize;
  const to = from + filters.pageSize - 1;

  let query = supabase
    .from("pos_sales_with_status")
    .select(SELECT_COLUMNS, { count: "exact" })
    .order("sale_date", { ascending: false })
    .range(from, to);

  if (filters.dateFrom) query = query.gte("sale_date", filters.dateFrom);
  if (filters.dateTo) query = query.lte("sale_date", filters.dateTo);

  const sourceRefTerm = filters.sourceRefSearch.trim();
  if (sourceRefTerm) query = query.ilike("source_ref", `%${sourceRefTerm}%`);

  if (filters.customerId) query = query.eq("customer_id", filters.customerId);
  if (filters.status) query = query.eq("status", filters.status);

  const { data, error, count } = await query;
  if (error) throw new Error(error.message);
  return { rows: (data ?? []) as unknown as PosSaleListRow[], total: count ?? 0 };
}

export function usePosSales(filters: PosSaleFilters) {
  return useQuery({
    queryKey: ["pos_sales", filters],
    queryFn: () => fetchPosSales(filters),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}
