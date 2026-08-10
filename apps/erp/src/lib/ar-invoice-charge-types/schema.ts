import { z } from "zod";

export const createArInvoiceChargeTypeSchema = z.object({
  name: z.string().min(1, "Nama wajib diisi"),
  account_id: z.string().uuid("Pilih akun"),
});

export type CreateArInvoiceChargeTypeInput = z.infer<typeof createArInvoiceChargeTypeSchema>;

export type ArInvoiceChargeType = {
  id: string;
  name: string;
  account_id: string;
  archived_at: string | null;
  accounts: { code: string; name: string };
};
