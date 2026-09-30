import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import type { ArInvoiceListRow, ArInvoiceOrigin, ArInvoiceStatus } from "./schema";

export const DEFAULT_PAGE_SIZE = 10;
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

export type ArInvoiceFilters = {
  dateFrom: string;
  dateTo: string;
  sourceRefSearch: string;
  customerId: string;
  status: ArInvoiceStatus | "";
  origin: ArInvoiceOrigin | "";
  page: number;
  pageSize: number;
};

// ar_invoices_with_status (migration 0033, kolom origin ditambah 0038) -- status/outstanding/
// returned/origin udah terhitung server-side, jadi list gak perlu lagi fetch nested
// ar_payments/ar_credit_notes/dst/goods_issues cuma buat dihitung ulang di client (itu tetap
// dipakai di halaman detail [id]/view.tsx).
const SELECT_COLUMNS =
  "id, customer_id, invoice_date, due_date, description, source_ref, amount, journal_entry_id, created_at, outstanding, returned, status, origin, created_by, counterparties(name)";

export async function fetchArInvoices(
  filters: ArInvoiceFilters
): Promise<{ rows: ArInvoiceListRow[]; total: number }> {
  const from = filters.page * filters.pageSize;
  const to = from + filters.pageSize - 1;

  let query = supabase
    .from("ar_invoices_with_status")
    .select(SELECT_COLUMNS, { count: "exact" })
    .order("invoice_date", { ascending: false })
    .range(from, to);

  if (filters.dateFrom) query = query.gte("invoice_date", filters.dateFrom);
  if (filters.dateTo) query = query.lte("invoice_date", filters.dateTo);

  const sourceRefTerm = filters.sourceRefSearch.trim();
  if (sourceRefTerm) query = query.ilike("source_ref", `%${sourceRefTerm}%`);

  if (filters.customerId) query = query.eq("customer_id", filters.customerId);
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.origin) query = query.eq("origin", filters.origin);

  const { data, error, count } = await query;
  if (error) throw new Error(error.message);
  return { rows: (data ?? []) as unknown as ArInvoiceListRow[], total: count ?? 0 };
}

export function useArInvoices(filters: ArInvoiceFilters) {
  return useQuery({
    queryKey: ["ar_invoices", filters],
    queryFn: () => fetchArInvoices(filters),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}
