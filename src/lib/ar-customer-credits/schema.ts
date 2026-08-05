import { z } from "zod";

export const applyArCustomerCreditSchema = z.object({
  credit_id: z.string().uuid("Pilih saldo kredit"),
  invoice_id: z.string().uuid("Pilih invoice"),
  amount: z.coerce.number().positive("Jumlah harus lebih dari 0"),
  entry_date: z.string().min(1, "Tanggal wajib diisi"),
  source_ref: z.string().min(1, "Rujukan dokumen wajib diisi"),
  customer_credit_account_id: z.string().uuid("Pilih akun Saldo Kredit Customer"),
  receivable_account_id: z.string().uuid("Pilih akun Piutang Usaha"),
});
export type ApplyArCustomerCreditInput = z.infer<typeof applyArCustomerCreditSchema>;

export const refundArCustomerCreditSchema = z.object({
  credit_id: z.string().uuid("Pilih saldo kredit"),
  amount: z.coerce.number().positive("Jumlah harus lebih dari 0"),
  entry_date: z.string().min(1, "Tanggal wajib diisi"),
  source_ref: z.string().min(1, "Rujukan dokumen wajib diisi"),
  customer_credit_account_id: z.string().uuid("Pilih akun Saldo Kredit Customer"),
  cash_account_id: z.string().uuid("Pilih akun Kas/Bank"),
});
export type RefundArCustomerCreditInput = z.infer<typeof refundArCustomerCreditSchema>;

export type ArCustomerCredit = {
  id: string;
  customer_id: string;
  payment_id: string;
  amount: number;
  journal_entry_id: string;
  created_at: string;
  customers: { name: string };
  ar_payments: { source_ref: string; payment_date: string };
  ar_customer_credit_applications: {
    id: string;
    amount: number;
    source_ref: string;
    journal_entry_id: string;
    ar_invoices: { source_ref: string };
  }[];
  ar_customer_credit_refunds: {
    id: string;
    amount: number;
    source_ref: string;
    journal_entry_id: string;
    created_at: string;
  }[];
};

/**
 * Sisa saldo kredit derived dari applications/refunds — bukan kolom, pola sama
 * depositStatus() di ar-deposits/schema.ts. Beda dari deposit: gak ada status enum /
 * terminal state ("hangus") — kredit cuma punya "sisa", bisa dipakai/direfund parsial
 * berkali-kali sampai habis. Application bisa di-reverse (invoice-nya dibatalkan lewat
 * cancel_ar_invoice) makanya exclude via reversedEntryIds — pola sama activeApplications
 * di deposit. Refund TIDAK PERNAH direverse oleh fitur ini (ref migration 0027), jadi
 * selalu keitung penuh, gak perlu dicek reversedEntryIds.
 */
export function customerCreditRemaining(
  credit: Pick<ArCustomerCredit, "amount" | "ar_customer_credit_applications" | "ar_customer_credit_refunds">,
  reversedEntryIds: Set<string>
): { used: number; remaining: number } {
  const activeApplications = credit.ar_customer_credit_applications.filter(
    (a) => !reversedEntryIds.has(a.journal_entry_id)
  );
  const appliedAmount = activeApplications.reduce((sum, a) => sum + a.amount, 0);
  const refundedAmount = credit.ar_customer_credit_refunds.reduce((sum, r) => sum + r.amount, 0);
  const used = appliedAmount + refundedAmount;
  return { used, remaining: credit.amount - used };
}
