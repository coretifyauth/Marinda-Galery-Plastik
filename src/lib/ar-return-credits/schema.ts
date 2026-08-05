import { z } from "zod";

export const applyArReturnCreditSchema = z.object({
  credit_id: z.string().uuid("Pilih saldo kredit retur"),
  invoice_id: z.string().uuid("Pilih invoice"),
  amount: z.coerce.number().positive("Jumlah harus lebih dari 0"),
  entry_date: z.string().min(1, "Tanggal wajib diisi"),
  source_ref: z.string().min(1, "Rujukan dokumen wajib diisi"),
  return_credit_liability_account_id: z.string().uuid("Pilih akun Saldo Kredit Retur Customer"),
  receivable_account_id: z.string().uuid("Pilih akun Piutang Usaha"),
});
export type ApplyArReturnCreditInput = z.infer<typeof applyArReturnCreditSchema>;

export const refundArReturnCreditSchema = z.object({
  credit_id: z.string().uuid("Pilih saldo kredit retur"),
  amount: z.coerce.number().positive("Jumlah harus lebih dari 0"),
  entry_date: z.string().min(1, "Tanggal wajib diisi"),
  source_ref: z.string().min(1, "Rujukan dokumen wajib diisi"),
  return_credit_liability_account_id: z.string().uuid("Pilih akun Saldo Kredit Retur Customer"),
  cash_account_id: z.string().uuid("Pilih akun Kas/Bank"),
});
export type RefundArReturnCreditInput = z.infer<typeof refundArReturnCreditSchema>;

export type ArReturnCredit = {
  id: string;
  customer_id: string;
  credit_note_id: string;
  amount: number;
  journal_entry_id: string;
  created_at: string;
  customers: { name: string };
  ar_credit_notes: { source_ref: string; credit_note_date: string };
  ar_return_credit_applications: {
    id: string;
    amount: number;
    source_ref: string;
    journal_entry_id: string;
    ar_invoices: { source_ref: string };
  }[];
  ar_return_credit_refunds: {
    id: string;
    amount: number;
    source_ref: string;
    journal_entry_id: string;
    created_at: string;
  }[];
};

/**
 * Sisa saldo kredit retur derived dari applications/refunds — bukan kolom, pola sama
 * customerCreditRemaining() di ar-customer-credits/schema.ts. Application bisa
 * di-reverse (invoice-nya dibatalkan lewat cancel_ar_invoice) makanya exclude via
 * reversedEntryIds. Refund TIDAK PERNAH direverse oleh fitur ini, selalu keitung penuh.
 */
export function returnCreditRemaining(
  credit: Pick<ArReturnCredit, "amount" | "ar_return_credit_applications" | "ar_return_credit_refunds">,
  reversedEntryIds: Set<string>
): { used: number; remaining: number } {
  const activeApplications = credit.ar_return_credit_applications.filter(
    (a) => !reversedEntryIds.has(a.journal_entry_id)
  );
  const appliedAmount = activeApplications.reduce((sum, a) => sum + a.amount, 0);
  const refundedAmount = credit.ar_return_credit_refunds.reduce((sum, r) => sum + r.amount, 0);
  const used = appliedAmount + refundedAmount;
  return { used, remaining: credit.amount - used };
}
