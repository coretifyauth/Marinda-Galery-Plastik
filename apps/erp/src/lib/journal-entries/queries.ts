import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import type { JournalEntry } from "./schema";

export const DEFAULT_PAGE_SIZE = 10;
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

export type JournalEntryFilters = {
  dateFrom: string;
  dateTo: string;
  descriptionSearch: string;
  sourceRefSearch: string;
  page: number;
  pageSize: number;
};

const SELECT_COLUMNS =
  "id, entry_date, description, source_ref, reverses_entry_id, created_at, journal_lines(id, journal_entry_id, account_id, debit, credit, accounts(code, name))";

export async function fetchJournalEntries(
  filters: JournalEntryFilters
): Promise<{ rows: JournalEntry[]; total: number }> {
  const from = filters.page * filters.pageSize;
  const to = from + filters.pageSize - 1;

  let query = supabase
    .from("journal_entries")
    .select(SELECT_COLUMNS, { count: "exact" })
    .order("entry_date", { ascending: false })
    .range(from, to);

  if (filters.dateFrom) query = query.gte("entry_date", filters.dateFrom);
  if (filters.dateTo) query = query.lte("entry_date", filters.dateTo);

  const descriptionTerm = filters.descriptionSearch.trim();
  if (descriptionTerm) query = query.ilike("description", `%${descriptionTerm}%`);

  const sourceRefTerm = filters.sourceRefSearch.trim();
  if (sourceRefTerm) query = query.ilike("source_ref", `%${sourceRefTerm}%`);

  const { data, error, count } = await query;
  if (error) throw new Error(error.message);
  return { rows: (data ?? []) as unknown as JournalEntry[], total: count ?? 0 };
}

export function useJournalEntries(filters: JournalEntryFilters) {
  return useQuery({
    queryKey: ["journal_entries", filters],
    queryFn: () => fetchJournalEntries(filters),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}
