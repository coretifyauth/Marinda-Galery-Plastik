import { z } from "zod";

export const createCustomerSchema = z.object({
  name: z.string().min(1, "Nama wajib diisi"),
  contact: z.string().optional(),
  payment_term_days: z.coerce.number().int().min(1, "Termin minimal 1 hari"),
  credit_limit: z.coerce.number().positive("Credit limit harus > 0").optional(),
  overdue_threshold_days: z.coerce
    .number()
    .int()
    .positive("Toleransi telat harus > 0 hari")
    .optional(),
  return_window_days: z.coerce
    .number()
    .int()
    .positive("Toleransi retur harus > 0 hari")
    .optional(),
});

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

export type Customer = {
  id: string;
  name: string;
  contact: string | null;
  payment_term_days: number;
  credit_limit: number | null;
  overdue_threshold_days: number | null;
  return_window_days: number | null;
  archived_at: string | null;
};
