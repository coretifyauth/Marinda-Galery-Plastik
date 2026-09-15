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
