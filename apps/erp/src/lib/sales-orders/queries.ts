import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import type { SalesOrderListRow, SoStatus } from "./schema";

export const DEFAULT_PAGE_SIZE = 10;
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

export type SalesOrderFilters = {
  dateFrom: string;
  dateTo: string;
  sourceRefSearch: string;
  customerId: string;
  status: SoStatus | "";
  page: number;
  pageSize: number;
};

// sales_orders_with_status (migration 0060 -- view terfilter direction='SALE' di atas tabel
// orders) -- status udah terhitung server-side dari goods_issue_lines vs qty_ordered, jadi
// list gak perlu lagi fetch goods_issue_lines nested cuma buat dihitung ulang di client.
const SELECT_COLUMNS =
  "id, counterparty_id, order_date, expected_date, source_ref, created_at, cancelled_at, status, counterparties(name), order_lines(id, item_id, qty_ordered, unit_price, items(name, uom))";

export async function fetchSalesOrders(
  filters: SalesOrderFilters
): Promise<{ rows: SalesOrderListRow[]; total: number }> {
  const from = filters.page * filters.pageSize;
  const to = from + filters.pageSize - 1;

  let query = supabase
    .from("sales_orders_with_status")
    .select(SELECT_COLUMNS, { count: "exact" })
    .order("order_date", { ascending: false })
    .range(from, to);

  if (filters.dateFrom) query = query.gte("order_date", filters.dateFrom);
  if (filters.dateTo) query = query.lte("order_date", filters.dateTo);

  const sourceRefTerm = filters.sourceRefSearch.trim();
  if (sourceRefTerm) query = query.ilike("source_ref", `%${sourceRefTerm}%`);

  if (filters.customerId) query = query.eq("counterparty_id", filters.customerId);
  if (filters.status) query = query.eq("status", filters.status);

  const { data, error, count } = await query;
  if (error) throw new Error(error.message);
  return { rows: (data ?? []) as unknown as SalesOrderListRow[], total: count ?? 0 };
}

export function useSalesOrders(filters: SalesOrderFilters) {
  return useQuery({
    queryKey: ["sales_orders", filters],
    queryFn: () => fetchSalesOrders(filters),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}
