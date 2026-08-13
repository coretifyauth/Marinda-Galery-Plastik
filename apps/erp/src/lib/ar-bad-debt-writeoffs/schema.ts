import { z } from "zod";

export const writeOffArInvoiceSchema = z.object({
  invoice_id: z.string().uuid("Pilih invoice"),
  writeoff_date: z.string().min(1, "Tanggal wajib diisi"),
  amount: z.coerce.number().positive("Jumlah harus lebih dari 0"),
  expense_account_id: z.string().uuid("Pilih akun Beban Piutang Tak Tertagih"),
  receivable_account_id: z.string().uuid("Pilih akun Piutang Usaha"),
});
export type WriteOffArInvoiceInput = z.infer<typeof writeOffArInvoiceSchema>;
