import { z } from "zod";

export type TaxSettings = {
  id: boolean;
  is_active: boolean;
  ppn_rate: number;
  ppn_keluaran_account_id: string | null;
  ppn_masukan_account_id: string | null;
};

export const updateTaxSettingsSchema = z.object({
  is_active: z.boolean(),
  ppn_rate: z.coerce.number().min(0, "Tarif gak boleh negatif"),
  ppn_keluaran_account_id: z.string().uuid().nullable(),
  ppn_masukan_account_id: z.string().uuid().nullable(),
});

export type UpdateTaxSettingsInput = z.infer<typeof updateTaxSettingsSchema>;
