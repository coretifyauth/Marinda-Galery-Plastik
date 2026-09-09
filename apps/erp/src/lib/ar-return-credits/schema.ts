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
  return_id: string;
  amount: number;
  journal_entry_id: string;
  created_at: string;
  counterparties: { name: string };
  ar_returns: {
    source_ref: string;
    credit_note_date: string;
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
 * Sisa saldo kredit retur derived dari refunds — bukan kolom. Cuma 1 disposisi (refund tunai),
 * gak ada lagi jalur "dipakai motong invoice lain" (memory/scope-debt/ar-return-credit-resolution.md,
 * sudah diimplementasi) maupun "diselesaikan lewat ganti barang" (dilarang eksplisit, lihat
 * docs/domain/accounts-receivable.md). Mirror `ap-return-credits/schema.ts`. Refund gak pernah
 * punya jalur reversal di fitur ini (beda dari deposit/write-off application yang bisa di-unwind
 * lewat cancel_ar_invoice), jadi gak butuh exclude berdasar reversedEntryIds.
 */
export function returnCreditRemaining(
  credit: Pick<ArReturnCredit, "amount" | "ar_return_credit_refunds">
): { used: number; remaining: number } {
  const used = credit.ar_return_credit_refunds.reduce((sum, r) => sum + r.amount, 0);
  return { used, remaining: credit.amount - used };
}
