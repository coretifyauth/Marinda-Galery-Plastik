import { z } from "zod";

export const paymentAllocationSchema = z.object({
  invoice_id: z.string().uuid("Pilih invoice"),
  amount: z.coerce.number().positive("Jumlah alokasi harus lebih dari 0"),
});

export const recordArPaymentSchema = z
  .object({
    customer_id: z.string().uuid("Pilih customer"),
    payment_date: z.string().min(1, "Tanggal wajib diisi"),
    amount: z.coerce.number().positive("Jumlah harus lebih dari 0"),
    source_ref: z.string().min(1, "Rujukan dokumen sumber wajib diisi"),
    cash_account_id: z.string().uuid("Pilih akun Kas/Bank"),
    receivable_account_id: z.string().uuid("Pilih akun Piutang Usaha"),
    allocations: z.array(paymentAllocationSchema).min(1, "Minimal 1 alokasi ke invoice"),
  })
  .refine(
    (data) => {
      const totalAllocated = data.allocations.reduce((sum, a) => sum + a.amount, 0);
      return Math.abs(totalAllocated - data.amount) < 0.005;
    },
    { message: "Total alokasi harus sama dengan jumlah pembayaran", path: ["allocations"] }
  );

export type RecordArPaymentInput = z.infer<typeof recordArPaymentSchema>;

export type ArPayment = {
  id: string;
  customer_id: string;
  payment_date: string;
  amount: number;
  source_ref: string;
  journal_entry_id: string;
  created_at: string;
  customers: { name: string };
  ar_payment_allocations: { id: string; amount: number; ar_invoices: { source_ref: string } }[];
};
