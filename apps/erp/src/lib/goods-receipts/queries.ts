import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import type { GoodsReceiptNote } from "./schema";

export const DEFAULT_PAGE_SIZE = 10;
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

export type GoodsReceiptFilters = {
  dateFrom: string;
  dateTo: string;
  purchaseOrderId: string;
  page: number;
  pageSize: number;
};

const SELECT_COLUMNS =
  "id, purchase_order_id, bill_id, delivery_note_ref, receipt_date, created_at, purchase_orders(source_ref, suppliers(name)), ap_bills(source_ref, amount), goods_receipt_lines(id, item_id, qty_received, unit_cost, items(name, uom))";

export async function fetchGoodsReceipts(
  filters: GoodsReceiptFilters
): Promise<{ rows: GoodsReceiptNote[]; total: number }> {
  const from = filters.page * filters.pageSize;
  const to = from + filters.pageSize - 1;

  let query = supabase
    .from("goods_receipt_notes")
    .select(SELECT_COLUMNS, { count: "exact" })
    .order("receipt_date", { ascending: false })
    .range(from, to);

  if (filters.dateFrom) query = query.gte("receipt_date", filters.dateFrom);
  if (filters.dateTo) query = query.lte("receipt_date", filters.dateTo);

  if (filters.purchaseOrderId) query = query.eq("purchase_order_id", filters.purchaseOrderId);

  const { data, error, count } = await query;
  if (error) throw new Error(error.message);
  return { rows: (data ?? []) as unknown as GoodsReceiptNote[], total: count ?? 0 };
}

export function useGoodsReceipts(filters: GoodsReceiptFilters) {
  return useQuery({
    queryKey: ["goods_receipt_notes", filters],
    queryFn: () => fetchGoodsReceipts(filters),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}
