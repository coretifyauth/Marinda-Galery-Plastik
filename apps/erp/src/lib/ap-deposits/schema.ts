import { z } from "zod";

export const createApDepositSchema = z.object({
  supplier_id: z.string().uuid("Pilih supplier"),
  deposit_date: z.string().min(1, "Tanggal wajib diisi"),
  amount: z.coerce.number().positive("Jumlah harus lebih dari 0"),
  deposit_asset_account_id: z.string().uuid("Pilih akun Uang Muka Pembelian"),
  cash_account_id: z.string().uuid("Pilih akun Kas/Bank"),
});
export type CreateApDepositInput = z.infer<typeof createApDepositSchema>;

export const applyApDepositSchema = z.object({
  deposit_id: z.string().uuid("Pilih deposit"),
  bill_id: z.string().uuid("Pilih bill"),
  amount: z.coerce.number().positive("Jumlah harus lebih dari 0"),
  entry_date: z.string().min(1, "Tanggal wajib diisi"),
  payable_account_id: z.string().uuid("Pilih akun Utang Usaha"),
  deposit_asset_account_id: z.string().uuid("Pilih akun Uang Muka Pembelian"),
});
export type ApplyApDepositInput = z.infer<typeof applyApDepositSchema>;

export const refundApDepositSchema = z.object({
  deposit_id: z.string().uuid("Pilih deposit"),
  amount: z.coerce.number().positive("Jumlah harus lebih dari 0"),
  refund_date: z.string().min(1, "Tanggal wajib diisi"),
  cash_account_id: z.string().uuid("Pilih akun Kas/Bank"),
  deposit_asset_account_id: z.string().uuid("Pilih akun Uang Muka Pembelian"),
});
export type RefundApDepositInput = z.infer<typeof refundApDepositSchema>;

export const forfeitApDepositSchema = z.object({
  deposit_id: z.string().uuid("Pilih deposit"),
  amount: z.coerce.number().positive("Jumlah harus lebih dari 0"),
  forfeiture_date: z.string().min(1, "Tanggal wajib diisi"),
  loss_expense_account_id: z.string().uuid("Pilih akun Beban Kerugian Uang Muka"),
  deposit_asset_account_id: z.string().uuid("Pilih akun Uang Muka Pembelian"),
});
export type ForfeitApDepositInput = z.infer<typeof forfeitApDepositSchema>;

export type ApDeposit = {
  id: string;
  supplier_id: string;
  deposit_date: string;
  source_ref: string;
  amount: number;
  journal_entry_id: string;
  created_at: string;
  suppliers: { name: string };
  ap_deposit_applications: {
    id: string;
    amount: number;
    source_ref: string;
    journal_entry_id: string;
    ap_bills: { source_ref: string };
  }[];
  ap_deposit_refunds: {
    id: string;
    amount: number;
    refund_date: string;
    source_ref: string;
    journal_entry_id: string;
  }[];
  ap_deposit_forfeitures: {
    id: string;
    amount: number;
    forfeiture_date: string;
    source_ref: string;
    journal_entry_id: string;
  }[];
};

export type ApDepositStatus = "belum_dipakai" | "sebagian" | "selesai";

/**
 * Status derived dari SUM(applications aktif) + SUM(refunds) + SUM(forfeitures) vs amount —
 * mirror persis depositStatus() di ar-deposits/schema.ts (arah kebalik: asset ke supplier,
 * bukan liability ke customer). Partial-capable dari awal (beda dari AR yang baru partial
 * belakangan lewat 0012) — 3 disposisi bisa dicampur bebas, mirror ap_deposit_remaining() di
 * database. Application yang journal_entry_id-nya udah di-reverse (bill-nya dibatalkan lewat
 * cancel_ap_bill) dianggap gak aktif lagi. Refund/forfeiture gak pernah punya jalur reversal.
 */
export function depositStatus(
  deposit: Pick<ApDeposit, "amount" | "ap_deposit_applications" | "ap_deposit_refunds" | "ap_deposit_forfeitures">,
  reversedEntryIds: Set<string>
): { status: ApDepositStatus; applied: number; refunded: number; forfeited: number; used: number; remaining: number } {
  const activeApplications = deposit.ap_deposit_applications.filter(
    (a) => !reversedEntryIds.has(a.journal_entry_id)
  );
  const applied = activeApplications.reduce((sum, a) => sum + a.amount, 0);
  const refunded = deposit.ap_deposit_refunds.reduce((sum, r) => sum + r.amount, 0);
  const forfeited = deposit.ap_deposit_forfeitures.reduce((sum, f) => sum + f.amount, 0);
  const used = applied + refunded + forfeited;
  const remaining = deposit.amount - used;
  const status: ApDepositStatus = remaining <= 0.005 ? "selesai" : used > 0 ? "sebagian" : "belum_dipakai";
  return { status, applied, refunded, forfeited, used, remaining };
}
