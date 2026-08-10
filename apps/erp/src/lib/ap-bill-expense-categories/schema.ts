import { z } from "zod";

export const createApBillExpenseCategorySchema = z.object({
  name: z.string().min(1, "Nama wajib diisi"),
  account_id: z.string().uuid("Pilih akun"),
});

export type CreateApBillExpenseCategoryInput = z.infer<typeof createApBillExpenseCategorySchema>;

export type ApBillExpenseCategory = {
  id: string;
  name: string;
  account_id: string;
  archived_at: string | null;
  accounts: { code: string; name: string };
};
