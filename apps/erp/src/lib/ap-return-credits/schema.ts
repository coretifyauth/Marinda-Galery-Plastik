import { z } from "zod";

export const refundApReturnCreditSchema = z.object({
  credit_id: z.string().uuid("Pilih saldo kredit retur"),
  amount: z.coerce.number().positive("Jumlah harus lebih dari 0"),
  entry_date: z.string().min(1, "Tanggal wajib diisi"),
  return_credit_asset_account_id: z.string().uuid("Pilih akun Piutang Retur Supplier"),
  cash_account_id: z.string().uuid("Pilih akun Kas/Bank"),
});
export type RefundApReturnCreditInput = z.infer<typeof refundApReturnCreditSchema>;

export type ApReturnCredit = {
  id: string;
  supplier_id: string;
  credit_note_id: string;
  amount: number;
  journal_entry_id: string;
  created_at: string;
  counterparties: { name: string };
  ap_credit_notes: { source_ref: string; credit_note_date: string };
  ap_return_credit_refunds: {
    id: string;
    amount: number;
    source_ref: string;
    journal_entry_id: string;
    created_at: string;
  }[];
};

/**
 * Sisa saldo kredit retur (Piutang Retur Supplier) derived dari refunds — bukan kolom.
 * Cuma 1 disposisi (refund tunai) sejak migration 0009 mencabut "dipakai motong bill lain"
 * (apply_ap_return_credit) — fitur itu bukan fondasi AP, saldo tetap tertelusuri/terselesaikan
 * lewat refund. Mirror ap_return_credit_remaining() di database.
 */
export function returnCreditRemaining(
  credit: Pick<ApReturnCredit, "amount" | "ap_return_credit_refunds">
): { used: number; remaining: number } {
  const used = credit.ap_return_credit_refunds.reduce((sum, r) => sum + r.amount, 0);
  return { used, remaining: credit.amount - used };
}
