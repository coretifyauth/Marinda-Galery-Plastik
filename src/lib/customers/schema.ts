import { z } from "zod";

export const createCustomerSchema = z.object({
  name: z.string().min(1, "Nama wajib diisi"),
  contact: z.string().optional(),
  payment_term_days: z.coerce.number().int().min(1, "Termin minimal 1 hari"),
});

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

export type Customer = {
  id: string;
  name: string;
  contact: string | null;
  payment_term_days: number;
  archived_at: string | null;
};
