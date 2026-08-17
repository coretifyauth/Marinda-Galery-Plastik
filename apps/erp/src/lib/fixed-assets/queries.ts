import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import { depreciationMethods, type FixedAsset } from "./schema";

export const DEFAULT_PAGE_SIZE = 10;
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

export type FixedAssetFilters = {
  nameSearch: string;
  depreciationMethod: "" | (typeof depreciationMethods)[number];
  page: number;
  pageSize: number;
};

const SELECT_COLUMNS =
  "id, name, asset_account_id, accumulated_depreciation_account_id, depreciation_expense_account_id, acquisition_cost, salvage_value, useful_life_months, acquisition_date, depreciation_method, depreciation_rate, archived_at";

export async function fetchFixedAssets(
  filters: FixedAssetFilters
): Promise<{ rows: FixedAsset[]; total: number }> {
  const from = filters.page * filters.pageSize;
  const to = from + filters.pageSize - 1;

  let query = supabase
    .from("fixed_assets")
    .select(SELECT_COLUMNS, { count: "exact" })
    .order("acquisition_date")
    .range(from, to);

  const nameTerm = filters.nameSearch.trim();
  if (nameTerm) query = query.ilike("name", `%${nameTerm}%`);
  if (filters.depreciationMethod) query = query.eq("depreciation_method", filters.depreciationMethod);

  const { data, error, count } = await query;
  if (error) throw new Error(error.message);
  return { rows: (data ?? []) as FixedAsset[], total: count ?? 0 };
}

export function useFixedAssets(filters: FixedAssetFilters) {
  return useQuery({
    queryKey: ["fixed_assets", filters],
    queryFn: () => fetchFixedAssets(filters),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}
