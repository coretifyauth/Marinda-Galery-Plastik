import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import type { GoodsIssue } from "./schema";

export const DEFAULT_PAGE_SIZE = 10;
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

export type GoodsIssueFilters = {
  dateFrom: string;
  dateTo: string;
  sourceRefSearch: string;
  page: number;
  pageSize: number;
};

const SELECT_COLUMNS =
  "id, invoice_id, journal_entry_id, issue_date, source_ref, created_at, ar_invoices(source_ref, amount, customers(name)), goods_issue_lines(id, item_id, qty_issued, total_cost, items(name, uom))";

export async function fetchGoodsIssues(
  filters: GoodsIssueFilters
): Promise<{ rows: GoodsIssue[]; total: number }> {
  const from = filters.page * filters.pageSize;
  const to = from + filters.pageSize - 1;

  let query = supabase
    .from("goods_issues")
    .select(SELECT_COLUMNS, { count: "exact" })
    .order("issue_date", { ascending: false })
    .range(from, to);

  if (filters.dateFrom) query = query.gte("issue_date", filters.dateFrom);
  if (filters.dateTo) query = query.lte("issue_date", filters.dateTo);

  const sourceRefTerm = filters.sourceRefSearch.trim();
  if (sourceRefTerm) query = query.ilike("source_ref", `%${sourceRefTerm}%`);

  const { data, error, count } = await query;
  if (error) throw new Error(error.message);
  return { rows: (data ?? []) as unknown as GoodsIssue[], total: count ?? 0 };
}

export function useGoodsIssues(filters: GoodsIssueFilters) {
  return useQuery({
    queryKey: ["goods_issues", filters],
    queryFn: () => fetchGoodsIssues(filters),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}
