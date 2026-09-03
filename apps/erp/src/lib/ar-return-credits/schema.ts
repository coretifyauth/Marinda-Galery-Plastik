import { z } from "zod";

export const refundArReturnCreditSchema = z.object({
  credit_id: z.string().uuid("Pilih saldo kredit retur"),
  amount: z.coerce.number().positive("Jumlah harus lebih dari 0"),
  entry_date: z.string().min(1, "Tanggal wajib diisi"),
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
  counterparties: { name: string };
  ar_credit_notes: {
    source_ref: string;
    credit_note_date: string;
    warranty_replacements: {
      id: string;
      replacement_date: string;
      source_ref: string;
      return_credit_settled_amount: number;
    }[];
  };
  ar_return_credit_refunds: {
    id: string;
    amount: number;
    source_ref: string;
    journal_entry_id: string;
    created_at: string;
  }[];
};

/**
 * Sisa saldo kredit retur derived dari settlement (warranty_replacement via barang) +
 * refunds — bukan kolom. Cuma 2 cara nyelesain (refund kas atau ganti barang), gak ada
 * lagi jalur "dipakai motong invoice lain" (memory/scope-debt/ar-return-credit-resolution.md,
 * sudah diimplementasi). Baik settlement maupun refund gak pernah punya jalur reversal di
 * fitur ini (beda dari deposit/write-off application yang bisa di-unwind lewat
 * cancel_ar_invoice), jadi gak butuh exclude berdasar reversedEntryIds.
 */
export function returnCreditRemaining(
  credit: Pick<ArReturnCredit, "amount" | "ar_credit_notes" | "ar_return_credit_refunds">
): { used: number; remaining: number } {
  const settledAmount = credit.ar_credit_notes.warranty_replacements.reduce(
    (sum, w) => sum + w.return_credit_settled_amount,
    0
  );
  const refundedAmount = credit.ar_return_credit_refunds.reduce((sum, r) => sum + r.amount, 0);
  const used = settledAmount + refundedAmount;
  return { used, remaining: credit.amount - used };
}
