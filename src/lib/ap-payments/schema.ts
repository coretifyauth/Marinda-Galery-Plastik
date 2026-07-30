import { z } from "zod";

export const paymentAllocationSchema = z.object({
  bill_id: z.string().uuid("Pilih bill"),
  amount: z.coerce.number().positive("Jumlah alokasi harus lebih dari 0"),
});

export const recordApPaymentSchema = z
  .object({
    supplier_id: z.string().uuid("Pilih supplier"),
    payment_date: z.string().min(1, "Tanggal wajib diisi"),
    amount: z.coerce.number().positive("Jumlah harus lebih dari 0"),
    source_ref: z.string().min(1, "Rujukan dokumen sumber wajib diisi"),
    payable_account_id: z.string().uuid("Pilih akun Utang Usaha"),
    cash_account_id: z.string().uuid("Pilih akun Kas/Bank"),
    allocations: z.array(paymentAllocationSchema).min(1, "Minimal 1 alokasi ke bill"),
  })
  .refine(
    (data) => {
      const totalAllocated = data.allocations.reduce((sum, a) => sum + a.amount, 0);
      return Math.abs(totalAllocated - data.amount) < 0.005;
    },
    { message: "Total alokasi harus sama dengan jumlah pembayaran", path: ["allocations"] }
  );

export type RecordApPaymentInput = z.infer<typeof recordApPaymentSchema>;

export type ApPayment = {
  id: string;
  supplier_id: string;
  payment_date: string;
  amount: number;
  source_ref: string;
  journal_entry_id: string;
  created_at: string;
  suppliers: { name: string };
  ap_payment_allocations: { id: string; amount: number; ap_bills: { source_ref: string } }[];
};
