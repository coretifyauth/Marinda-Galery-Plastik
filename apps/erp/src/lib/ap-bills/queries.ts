import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import type { ApBillListRow, ApBillOrigin, ApBillStatus } from "./schema";

export const DEFAULT_PAGE_SIZE = 10;
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

export type ApBillFilters = {
  dateFrom: string;
  dateTo: string;
  sourceRefSearch: string;
  supplierDocumentRefSearch: string;
  supplierId: string;
  status: ApBillStatus | "";
  origin: ApBillOrigin | "";
  page: number;
  pageSize: number;
};

// ap_bills_with_status (migration 0032, kolom origin ditambah 0038) -- status/outstanding/origin
// udah terhitung server-side, jadi list gak perlu lagi fetch nested
// ap_payments/ap_credit_notes/ap_deposit_applications/goods_receipt_notes cuma buat dihitung
// ulang di client (itu tetap dipakai di halaman detail [id]/view.tsx).
const SELECT_COLUMNS =
  "id, supplier_id, bill_date, due_date, description, source_ref, supplier_document_ref, amount, journal_entry_id, created_at, outstanding, status, origin, suppliers(name)";

export async function fetchApBills(
  filters: ApBillFilters
): Promise<{ rows: ApBillListRow[]; total: number }> {
  const from = filters.page * filters.pageSize;
  const to = from + filters.pageSize - 1;

  let query = supabase
    .from("ap_bills_with_status")
    .select(SELECT_COLUMNS, { count: "exact" })
    .order("bill_date", { ascending: false })
    .range(from, to);

  if (filters.dateFrom) query = query.gte("bill_date", filters.dateFrom);
  if (filters.dateTo) query = query.lte("bill_date", filters.dateTo);

  const sourceRefTerm = filters.sourceRefSearch.trim();
  if (sourceRefTerm) query = query.ilike("source_ref", `%${sourceRefTerm}%`);

  const supplierDocumentRefTerm = filters.supplierDocumentRefSearch.trim();
  if (supplierDocumentRefTerm) query = query.ilike("supplier_document_ref", `%${supplierDocumentRefTerm}%`);

  if (filters.supplierId) query = query.eq("supplier_id", filters.supplierId);
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.origin) query = query.eq("origin", filters.origin);

  const { data, error, count } = await query;
  if (error) throw new Error(error.message);
  return { rows: (data ?? []) as unknown as ApBillListRow[], total: count ?? 0 };
}

export function useApBills(filters: ApBillFilters) {
  return useQuery({
    queryKey: ["ap_bills", filters],
    queryFn: () => fetchApBills(filters),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}
