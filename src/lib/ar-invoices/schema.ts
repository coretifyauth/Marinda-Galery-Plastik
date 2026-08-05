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
  ar_credit_notes?: { amount: number }[];
  ar_deposit_applications?: { amount: number }[];
  ar_customer_credit_applications?: { amount: number }[];
};

export type ArInvoiceStatus = "lunas" | "sebagian" | "belum" | "dibatalkan";

/**
 * Status derived dari SUM(allocations) - SUM(retur) - SUM(deposit applications) -
 * SUM(customer credit applications) vs amount, plus cek reversal — bukan kolom, ref
 * ar-schema.md. Outstanding boleh negatif (saldo kredit) kalau retur kejadian setelah
 * invoice lunas — ref docs/domain/accounts-receivable.md bagian "Retur Barang".
 * `ar_deposit_applications` dan `ar_customer_credit_applications` selalu aktif kalau
 * invoice-nya masih hidup (belum dibatalkan) — begitu invoice dibatalkan,
 * `cancel_ar_invoice` ikut me-reverse jurnal application-nya (kedua jalur), jadi gak
 * perlu exclude yang di-reverse di sini (lihat "Uang Muka / DP" dan "Kelebihan Bayar
 * (Overpayment)" di ar-schema.md).
 * `isCancelled` dihitung caller dari query terpisah (journal_entries.reverses_entry_id
 * yang nunjuk ke invoice.journal_entry_id), karena bukan relasi langsung dari ar_invoices.
 */
export function invoiceStatus(
  invoice: Pick<
    ArInvoice,
    "amount" | "ar_payment_allocations" | "ar_credit_notes" | "ar_deposit_applications" | "ar_customer_credit_applications"
  >,
  isCancelled = false
): {
  status: ArInvoiceStatus;
  allocated: number;
  returned: number;
  depositApplied: number;
  creditApplied: number;
  outstanding: number;
} {
  const allocated = invoice.ar_payment_allocations.reduce((sum, a) => sum + a.amount, 0);
  const returned = (invoice.ar_credit_notes ?? []).reduce((sum, c) => sum + c.amount, 0);
  const depositApplied = (invoice.ar_deposit_applications ?? []).reduce((sum, a) => sum + a.amount, 0);
  const creditApplied = (invoice.ar_customer_credit_applications ?? []).reduce((sum, a) => sum + a.amount, 0);
  const outstanding = invoice.amount - allocated - returned - depositApplied - creditApplied;
  if (isCancelled) {
    return { status: "dibatalkan", allocated, returned, depositApplied, creditApplied, outstanding: 0 };
  }
  const status: ArInvoiceStatus =
    outstanding <= 0.005 ? "lunas" : allocated > 0 || depositApplied > 0 || creditApplied > 0 ? "sebagian" : "belum";
  return { status, allocated, returned, depositApplied, creditApplied, outstanding };
}
