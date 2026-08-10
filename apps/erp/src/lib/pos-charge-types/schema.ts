import { z } from "zod";

export const createPosChargeTypeSchema = z.object({
  name: z.string().min(1, "Nama wajib diisi"),
  account_id: z.string().uuid("Pilih akun"),
});

export type CreatePosChargeTypeInput = z.infer<typeof createPosChargeTypeSchema>;

export type PosChargeType = {
  id: string;
  name: string;
  account_id: string;
  archived_at: string | null;
  accounts: { code: string; name: string };
};
