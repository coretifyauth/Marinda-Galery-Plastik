import { z } from "zod";

export const createApBillSchema = z.object({
  supplier_id: z.string().uuid("Pilih supplier"),
  bill_date: z.string().min(1, "Tanggal wajib diisi"),
  description: z.string().optional(),
  source_ref: z.string().min(1, "Rujukan dokumen sumber wajib diisi"),
  amount: z.coerce.number().positive("Jumlah harus lebih dari 0"),
  debit_account_id: z.string().uuid("Pilih akun Persediaan/Beban"),
  payable_account_id: z.string().uuid("Pilih akun Utang Usaha"),
});

export type CreateApBillInput = z.infer<typeof createApBillSchema>;

export type ApBill = {
  id: string;
  supplier_id: string;
  bill_date: string;
  due_date: string;
  description: string | null;
  source_ref: string;
  amount: number;
  journal_entry_id: string;
  created_at: string;
  suppliers: { name: string };
  ap_payment_allocations: { amount: number }[];
};

export type ApBillStatus = "lunas" | "sebagian" | "belum" | "dibatalkan";

/** Status derived dari SUM(allocations) vs amount, plus cek reversal — bukan kolom, ref ap-schema.md. */
export function billStatus(
  bill: Pick<ApBill, "amount" | "ap_payment_allocations">,
  isCancelled = false
): {
  status: ApBillStatus;
  allocated: number;
  outstanding: number;
} {
  const allocated = bill.ap_payment_allocations.reduce((sum, a) => sum + a.amount, 0);
  const outstanding = bill.amount - allocated;
  if (isCancelled) {
    return { status: "dibatalkan", allocated, outstanding: 0 };
  }
  const status: ApBillStatus =
    outstanding <= 0.005 ? "lunas" : allocated > 0 ? "sebagian" : "belum";
  return { status, allocated, outstanding };
}
