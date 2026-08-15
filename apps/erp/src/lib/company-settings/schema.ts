import { z } from "zod";
import { supabase } from "@/lib/supabase/client";

export type CompanySettings = {
  id: true;
  name: string;
  address: string | null;
  npwp: string | null;
  logo_url: string | null;
  updated_at: string;
  updated_by: string | null;
};

export const updateCompanySettingsSchema = z.object({
  name: z.string().min(1, "Nama perusahaan wajib diisi"),
  address: z.string().optional(),
  npwp: z.string().optional(),
  logo_url: z.string().optional(),
});

export type UpdateCompanySettingsInput = z.infer<typeof updateCompanySettingsSchema>;

/** Dipakai di kop surat cetakan (AR Invoice/PO) — baris tunggalnya selalu ada (diseed
 * migration 0026), jadi null cuma terjadi kalau query gagal, bukan kondisi normal. */
export async function fetchCompanySettings(): Promise<CompanySettings | null> {
  const { data } = await supabase.from("company_settings").select("*").maybeSingle();
  return (data as CompanySettings) ?? null;
}
