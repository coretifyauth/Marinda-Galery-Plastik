import { z } from "zod";
import { supabase } from "@/lib/supabase/client";
import type { ResolvedAccount } from "@/lib/default-accounts/schema";

export type TaxSettings = {
  id: boolean;
  is_active: boolean;
  ppn_rate: number;
  ppn_keluaran_account_id: string | null;
  ppn_masukan_account_id: string | null;
  ppn_keluaran_account?: { code: string; name: string } | null;
  ppn_masukan_account?: { code: string; name: string } | null;
};

/** Sama kayak fetchDefaultAccounts (lib/default-accounts/schema.ts) tapi buat akun PPN —
 * beda tabel sumber (tax_settings, single-row, bukan default_account_settings/role_key),
 * jadi gak nyampur di sana. Dipakai form transaksi yang punya checkbox "Kena PPN" buat
 * nampilin leg PPN di <JournalPreviewPanel> begitu user centang. */
export async function fetchTaxSettings(): Promise<TaxSettings | null> {
  const { data } = await supabase
    .from("tax_settings")
    .select(
      "*, ppn_keluaran_account:ppn_keluaran_account_id(code,name), ppn_masukan_account:ppn_masukan_account_id(code,name)"
    )
    .maybeSingle();
  return (data ?? null) as unknown as TaxSettings | null;
}

/** Sama pola kayak resolveCashAccount (cash-method-field.tsx) — bungkus id+code+name jadi
 * ResolvedAccount siap pakai buat leg <JournalPreviewPanel>, undefined kalau belum diset
 * admin (biar panel nampilin warning, bukan baris kosong). */
export function resolvedPpnMasukan(t: TaxSettings | null): ResolvedAccount | undefined {
  if (!t?.ppn_masukan_account_id) return undefined;
  return {
    id: t.ppn_masukan_account_id,
    code: t.ppn_masukan_account?.code ?? "",
    name: t.ppn_masukan_account?.name ?? "",
  };
}

export function resolvedPpnKeluaran(t: TaxSettings | null): ResolvedAccount | undefined {
  if (!t?.ppn_keluaran_account_id) return undefined;
  return {
    id: t.ppn_keluaran_account_id,
    code: t.ppn_keluaran_account?.code ?? "",
    name: t.ppn_keluaran_account?.name ?? "",
  };
}

export const updateTaxSettingsSchema = z.object({
  is_active: z.boolean(),
  ppn_rate: z.coerce.number().min(0, "Tarif gak boleh negatif"),
  ppn_keluaran_account_id: z.string().uuid().nullable(),
  ppn_masukan_account_id: z.string().uuid().nullable(),
});

export type UpdateTaxSettingsInput = z.infer<typeof updateTaxSettingsSchema>;
