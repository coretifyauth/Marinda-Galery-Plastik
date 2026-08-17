import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import type { PoStatus, PurchaseOrderListRow } from "./schema";

export const DEFAULT_PAGE_SIZE = 10;
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

export type PurchaseOrderFilters = {
  dateFrom: string;
  dateTo: string;
  sourceRefSearch: string;
  supplierId: string;
  status: PoStatus | "";
  page: number;
  pageSize: number;
};

// purchase_orders_with_status (migration 0034) -- status udah terhitung server-side dari
// goods_receipt_lines vs qty_ordered, jadi list gak perlu lagi fetch goods_receipt_lines nested
// cuma buat dihitung ulang di client (halaman create Goods Receipt fetch PO-nya sendiri terpisah
// buat itu, lihat apps/erp/src/app/(app)/goods-receipts/page.tsx).
const SELECT_COLUMNS =
  "id, supplier_id, po_date, expected_date, source_ref, created_at, cancelled_at, status, suppliers(name), purchase_order_lines(id, item_id, qty_ordered, unit_cost_expected, items(name, uom))";

export async function fetchPurchaseOrders(
  filters: PurchaseOrderFilters
): Promise<{ rows: PurchaseOrderListRow[]; total: number }> {
  const from = filters.page * filters.pageSize;
  const to = from + filters.pageSize - 1;

  let query = supabase
    .from("purchase_orders_with_status")
    .select(SELECT_COLUMNS, { count: "exact" })
    .order("po_date", { ascending: false })
    .range(from, to);

  if (filters.dateFrom) query = query.gte("po_date", filters.dateFrom);
  if (filters.dateTo) query = query.lte("po_date", filters.dateTo);

  const sourceRefTerm = filters.sourceRefSearch.trim();
  if (sourceRefTerm) query = query.ilike("source_ref", `%${sourceRefTerm}%`);

  if (filters.supplierId) query = query.eq("supplier_id", filters.supplierId);
  if (filters.status) query = query.eq("status", filters.status);

  const { data, error, count } = await query;
  if (error) throw new Error(error.message);
  return { rows: (data ?? []) as unknown as PurchaseOrderListRow[], total: count ?? 0 };
}

export function usePurchaseOrders(filters: PurchaseOrderFilters) {
  return useQuery({
    queryKey: ["purchase_orders", filters],
    queryFn: () => fetchPurchaseOrders(filters),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}
