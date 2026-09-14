import { supabase } from "@/lib/supabase/client";

export type ResolvedAccount = { id: string; code: string; name: string };

/** Fetch semua app_default_account_settings, dikembalikan sebagai map role_key -> akun
 * terselesaikan. Dipanggil sekali per halaman (bareng loader lain) — hasilnya dipakai
 * <LockedAccountField> buat resolve akun tanpa nampilin picker bebas ke user.
 * Kalau suatu role_key gak ketemu di map, field-nya nampilin warning (bukan silent
 * fallback ke akun apapun) — lihat src/components/ui/locked-account-field.tsx. */
export async function fetchDefaultAccounts(): Promise<Record<string, ResolvedAccount>> {
  const { data } = await supabase
    .from("app_default_account_settings")
    .select("role_key, account_id, accounts(code, name)");
  const map: Record<string, ResolvedAccount> = {};
  for (const row of (data ?? []) as unknown as {
    role_key: string;
    account_id: string;
    accounts: { code: string; name: string };
  }[]) {
    map[row.role_key] = { id: row.account_id, code: row.accounts.code, name: row.accounts.name };
  }
  return map;
}

export type FixedAssetAccountPreset = {
  id: string;
  label: string;
  asset_account_id: string;
  accumulated_depreciation_account_id: string;
  depreciation_expense_account_id: string;
  archived_at: string | null;
  asset_account: { code: string; name: string };
  accumulated_depreciation_account: { code: string; name: string };
  depreciation_expense_account: { code: string; name: string };
};

export async function fetchFixedAssetAccountPresets(): Promise<FixedAssetAccountPreset[]> {
  const { data } = await supabase
    .from("fixed_asset_account_presets")
    .select(
      "id, label, asset_account_id, accumulated_depreciation_account_id, depreciation_expense_account_id, archived_at, asset_account:asset_account_id(code, name), accumulated_depreciation_account:accumulated_depreciation_account_id(code, name), depreciation_expense_account:depreciation_expense_account_id(code, name)"
    )
    .order("label");
  return (data ?? []) as unknown as FixedAssetAccountPreset[];
}
