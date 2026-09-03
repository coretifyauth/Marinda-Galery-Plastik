import { z } from "zod";

export const recordApPaymentSchema = z.object({
  supplier_id: z.string().uuid("Pilih supplier"),
  payment_date: z.string().min(1, "Tanggal wajib diisi"),
  amount: z.coerce.number().positive("Jumlah harus lebih dari 0"),
  payable_account_id: z.string().uuid("Pilih akun Utang Usaha"),
  cash_account_id: z.string().uuid("Pilih akun Kas/Bank"),
  bill_id: z.string().uuid("Pilih bill"),
});

export type RecordApPaymentInput = z.infer<typeof recordApPaymentSchema>;

export type ApPayment = {
  id: string;
  supplier_id: string;
  bill_id: string;
  payment_date: string;
  amount: number;
  source_ref: string;
  journal_entry_id: string;
  created_at: string;
  counterparties: { name: string };
  ap_bills: { source_ref: string };
};
