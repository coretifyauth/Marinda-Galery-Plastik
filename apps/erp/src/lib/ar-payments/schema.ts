import { z } from "zod";

export const recordArPaymentSchema = z.object({
  customer_id: z.string().uuid("Pilih customer"),
  payment_date: z.string().min(1, "Tanggal wajib diisi"),
  amount: z.coerce.number().positive("Jumlah harus lebih dari 0"),
  cash_account_id: z.string().uuid("Pilih akun Kas/Bank"),
  receivable_account_id: z.string().uuid("Pilih akun Piutang Usaha"),
  invoice_id: z.string().uuid("Pilih invoice"),
});

export type RecordArPaymentInput = z.infer<typeof recordArPaymentSchema>;

export type ArPayment = {
  id: string;
  customer_id: string;
  invoice_id: string;
  payment_date: string;
  amount: number;
  source_ref: string;
  journal_entry_id: string;
  created_at: string;
  counterparties: { name: string };
  ar_invoices: { source_ref: string };
};
