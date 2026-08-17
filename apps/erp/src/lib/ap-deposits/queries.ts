import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import type { ApDepositListRow, ApDepositStatus } from "./schema";

export const DEFAULT_PAGE_SIZE = 10;
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

export type ApDepositFilters = {
  dateFrom: string;
  dateTo: string;
  sourceRefSearch: string;
  supplierId: string;
  status: ApDepositStatus | "";
  page: number;
  pageSize: number;
};

// ap_deposits_with_status (migration 0031) -- view yang udah nyediain status/remaining
// terhitung server-side, jadi list gak perlu lagi fetch nested applications/refunds/forfeitures
// cuma buat dihitung ulang di client (itu tetap dipakai di halaman detail [id]/view.tsx).
const SELECT_COLUMNS =
  "id, supplier_id, deposit_date, source_ref, amount, journal_entry_id, created_at, remaining, status, suppliers(name)";

export async function fetchApDeposits(
  filters: ApDepositFilters
): Promise<{ rows: ApDepositListRow[]; total: number }> {
  const from = filters.page * filters.pageSize;
  const to = from + filters.pageSize - 1;

  let query = supabase
    .from("ap_deposits_with_status")
    .select(SELECT_COLUMNS, { count: "exact" })
    .order("deposit_date", { ascending: false })
    .range(from, to);

  if (filters.dateFrom) query = query.gte("deposit_date", filters.dateFrom);
  if (filters.dateTo) query = query.lte("deposit_date", filters.dateTo);

  const sourceRefTerm = filters.sourceRefSearch.trim();
  if (sourceRefTerm) query = query.ilike("source_ref", `%${sourceRefTerm}%`);

  if (filters.supplierId) query = query.eq("supplier_id", filters.supplierId);
  if (filters.status) query = query.eq("status", filters.status);

  const { data, error, count } = await query;
  if (error) throw new Error(error.message);
  return { rows: (data ?? []) as unknown as ApDepositListRow[], total: count ?? 0 };
}

export function useApDeposits(filters: ApDepositFilters) {
  return useQuery({
    queryKey: ["ap_deposits", filters],
    queryFn: () => fetchApDeposits(filters),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}
