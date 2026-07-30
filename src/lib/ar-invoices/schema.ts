import { z } from "zod";

export const createArInvoiceSchema = z.object({
  customer_id: z.string().uuid("Pilih customer"),
  invoice_date: z.string().min(1, "Tanggal wajib diisi"),
  description: z.string().optional(),
  source_ref: z.string().min(1, "Rujukan dokumen sumber wajib diisi"),
  amount: z.coerce.number().positive("Jumlah harus lebih dari 0"),
  receivable_account_id: z.string().uuid("Pilih akun Piutang Usaha"),
  revenue_account_id: z.string().uuid("Pilih akun Pendapatan"),
});

export type CreateArInvoiceInput = z.infer<typeof createArInvoiceSchema>;

export type ArInvoice = {
  id: string;
  customer_id: string;
  invoice_date: string;
  due_date: string;
  description: string | null;
  source_ref: string;
  amount: number;
  journal_entry_id: string;
  created_at: string;
  customers: { name: string };
  ar_payment_allocations: { amount: number }[];
};

export type ArInvoiceStatus = "lunas" | "sebagian" | "belum" | "dibatalkan";

/**
 * Status derived dari SUM(allocations) vs amount, plus cek reversal — bukan kolom, ref ar-schema.md.
 * `isCancelled` dihitung caller dari query terpisah (journal_entries.reverses_entry_id
 * yang nunjuk ke invoice.journal_entry_id), karena bukan relasi langsung dari ar_invoices.
 */
export function invoiceStatus(
  invoice: Pick<ArInvoice, "amount" | "ar_payment_allocations">,
  isCancelled = false
): {
  status: ArInvoiceStatus;
  allocated: number;
  outstanding: number;
} {
  const allocated = invoice.ar_payment_allocations.reduce((sum, a) => sum + a.amount, 0);
  const outstanding = invoice.amount - allocated;
  if (isCancelled) {
    return { status: "dibatalkan", allocated, outstanding: 0 };
  }
  const status: ArInvoiceStatus =
    outstanding <= 0.005 ? "lunas" : allocated > 0 ? "sebagian" : "belum";
  return { status, allocated, outstanding };
}
