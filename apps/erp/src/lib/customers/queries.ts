import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import type { Customer } from "./schema";

export const DEFAULT_PAGE_SIZE = 10;
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

export type CustomerFilters = {
  nameSearch: string;
  contactSearch: string;
  archivedFilter: "" | "active" | "archived";
  page: number;
  pageSize: number;
};

const SELECT_COLUMNS =
  "id, name, contact, payment_term_days, credit_limit, overdue_threshold_days, archived_at";

export async function fetchCustomers(
  filters: CustomerFilters
): Promise<{ rows: Customer[]; total: number }> {
  const from = filters.page * filters.pageSize;
  const to = from + filters.pageSize - 1;

  let query = supabase
    .from("customers")
    .select(SELECT_COLUMNS, { count: "exact" })
    .order("name")
    .range(from, to);

  const nameTerm = filters.nameSearch.trim();
  if (nameTerm) query = query.ilike("name", `%${nameTerm}%`);

  const contactTerm = filters.contactSearch.trim();
  if (contactTerm) query = query.ilike("contact", `%${contactTerm}%`);

  if (filters.archivedFilter === "active") query = query.is("archived_at", null);
  if (filters.archivedFilter === "archived") query = query.not("archived_at", "is", null);

  const { data, error, count } = await query;
  if (error) throw new Error(error.message);
  return { rows: (data ?? []) as Customer[], total: count ?? 0 };
}

export function useCustomers(filters: CustomerFilters) {
  return useQuery({
    queryKey: ["customers", filters],
    queryFn: () => fetchCustomers(filters),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}
