import { z } from "zod";

export const applyApReturnCreditSchema = z.object({
  credit_id: z.string().uuid("Pilih saldo kredit retur"),
  bill_id: z.string().uuid("Pilih bill"),
  amount: z.coerce.number().positive("Jumlah harus lebih dari 0"),
  entry_date: z.string().min(1, "Tanggal wajib diisi"),
  source_ref: z.string().min(1, "Rujukan dokumen wajib diisi"),
  return_credit_asset_account_id: z.string().uuid("Pilih akun Piutang Retur Supplier"),
  payable_account_id: z.string().uuid("Pilih akun Utang Usaha"),
});
export type ApplyApReturnCreditInput = z.infer<typeof applyApReturnCreditSchema>;

export const refundApReturnCreditSchema = z.object({
  credit_id: z.string().uuid("Pilih saldo kredit retur"),
  amount: z.coerce.number().positive("Jumlah harus lebih dari 0"),
  entry_date: z.string().min(1, "Tanggal wajib diisi"),
  source_ref: z.string().min(1, "Rujukan dokumen wajib diisi"),
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
  suppliers: { name: string };
  ap_credit_notes: { source_ref: string; credit_note_date: string };
  ap_return_credit_applications: {
    id: string;
    amount: number;
    source_ref: string;
    journal_entry_id: string;
    ap_bills: { source_ref: string };
  }[];
  ap_return_credit_refunds: {
    id: string;
    amount: number;
    source_ref: string;
    journal_entry_id: string;
    created_at: string;
  }[];
};

/**
 * Sisa saldo kredit retur (Piutang Retur Supplier) derived dari applications/refunds — bukan
 * kolom, pola sama identik returnCreditRemaining() di ar-return-credits/schema.ts (arah
 * saldo kebalik: di sini asset ke supplier, bukan liability ke customer, tapi rumus sisa
 * sama persis). Application bisa di-reverse (bill target-nya dibatalkan lewat
 * cancel_ap_bill, lihat 0035) makanya exclude via reversedEntryIds. Refund TIDAK PERNAH
 * direverse oleh fitur ini, selalu keitung penuh. Mirror ap_return_credit_remaining() di
 * database.
 */
export function returnCreditRemaining(
  credit: Pick<ApReturnCredit, "amount" | "ap_return_credit_applications" | "ap_return_credit_refunds">,
  reversedEntryIds: Set<string>
): { used: number; remaining: number } {
  const activeApplications = credit.ap_return_credit_applications.filter(
    (a) => !reversedEntryIds.has(a.journal_entry_id)
  );
  const appliedAmount = activeApplications.reduce((sum, a) => sum + a.amount, 0);
  const refundedAmount = credit.ap_return_credit_refunds.reduce((sum, r) => sum + r.amount, 0);
  const used = appliedAmount + refundedAmount;
  return { used, remaining: credit.amount - used };
}
