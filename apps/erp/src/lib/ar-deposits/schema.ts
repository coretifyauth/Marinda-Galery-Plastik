import { z } from "zod";

export const createArDepositSchema = z.object({
  customer_id: z.string().uuid("Pilih customer"),
  deposit_date: z.string().min(1, "Tanggal wajib diisi"),
  amount: z.coerce.number().positive("Jumlah harus lebih dari 0"),
  cash_account_id: z.string().uuid("Pilih akun Kas/Bank"),
  deposit_liability_account_id: z.string().uuid("Pilih akun Uang Muka Penjualan"),
});
export type CreateArDepositInput = z.infer<typeof createArDepositSchema>;

export const applyArDepositSchema = z.object({
  deposit_id: z.string().uuid("Pilih deposit"),
  invoice_id: z.string().uuid("Pilih invoice"),
  amount: z.coerce.number().positive("Jumlah harus lebih dari 0"),
  entry_date: z.string().min(1, "Tanggal wajib diisi"),
  deposit_liability_account_id: z.string().uuid("Pilih akun Uang Muka Penjualan"),
  receivable_account_id: z.string().uuid("Pilih akun Piutang Usaha"),
});
export type ApplyArDepositInput = z.infer<typeof applyArDepositSchema>;

export const refundArDepositSchema = z.object({
  deposit_id: z.string().uuid("Pilih deposit"),
  amount: z.coerce.number().positive("Jumlah harus lebih dari 0"),
  refund_date: z.string().min(1, "Tanggal wajib diisi"),
  deposit_liability_account_id: z.string().uuid("Pilih akun Uang Muka Penjualan"),
  cash_account_id: z.string().uuid("Pilih akun Kas/Bank"),
});
export type RefundArDepositInput = z.infer<typeof refundArDepositSchema>;

export const forfeitArDepositSchema = z.object({
  deposit_id: z.string().uuid("Pilih deposit"),
  amount: z.coerce.number().positive("Jumlah harus lebih dari 0"),
  forfeiture_date: z.string().min(1, "Tanggal wajib diisi"),
  deposit_liability_account_id: z.string().uuid("Pilih akun Uang Muka Penjualan"),
  other_revenue_account_id: z.string().uuid("Pilih akun Pendapatan Lain-lain"),
});
export type ForfeitArDepositInput = z.infer<typeof forfeitArDepositSchema>;

export type ArDeposit = {
  id: string;
  customer_id: string;
  deposit_date: string;
  source_ref: string;
  amount: number;
  journal_entry_id: string;
  created_at: string;
  customers: { name: string };
  ar_deposit_applications: {
    id: string;
    amount: number;
    source_ref: string;
    journal_entry_id: string;
    ar_invoices: { source_ref: string };
  }[];
  ar_deposit_refunds: {
    id: string;
    amount: number;
    refund_date: string;
    source_ref: string;
    journal_entry_id: string;
  }[];
  ar_deposit_forfeitures: {
    id: string;
    amount: number;
    forfeiture_date: string;
    source_ref: string;
    journal_entry_id: string;
  }[];
};

export type ArDepositStatus = "belum_dipakai" | "sebagian" | "selesai";

export type ArDepositListRow = {
  id: string;
  customer_id: string;
  deposit_date: string;
  source_ref: string;
  amount: number;
  journal_entry_id: string;
  created_at: string;
  remaining: number;
  status: ArDepositStatus;
  customers: { name: string };
};

/**
 * Status derived dari SUM(applications aktif) + SUM(refunds) + SUM(forfeitures) vs amount —
 * bukan kolom, sama pola invoiceStatus()/billStatus(). Sejak migration 0012, ketiga disposisi
 * partial-capable & bisa dicampur (gak ada lagi aturan "1 disposisi aktif") — mirror
 * ar_deposit_remaining() di database. Application yang journal_entry_id-nya udah di-reverse
 * (invoice-nya dibatalkan lewat cancel_ar_invoice) dianggap gak aktif lagi. `reversedEntryIds`
 * sama persis Set yang dipakai invoiceStatus() (dari journal_entries.reverses_entry_id), reuse
 * query yang sama, jangan query ulang. Refund/forfeiture gak pernah punya jalur reversal.
 */
export function depositStatus(
  deposit: Pick<ArDeposit, "amount" | "ar_deposit_applications" | "ar_deposit_refunds" | "ar_deposit_forfeitures">,
  reversedEntryIds: Set<string>
): { status: ArDepositStatus; applied: number; refunded: number; forfeited: number; used: number; remaining: number } {
  const activeApplications = deposit.ar_deposit_applications.filter(
    (a) => !reversedEntryIds.has(a.journal_entry_id)
  );
  const applied = activeApplications.reduce((sum, a) => sum + a.amount, 0);
  const refunded = deposit.ar_deposit_refunds.reduce((sum, r) => sum + r.amount, 0);
  const forfeited = deposit.ar_deposit_forfeitures.reduce((sum, f) => sum + f.amount, 0);
  const used = applied + refunded + forfeited;
  const remaining = deposit.amount - used;
  const status: ArDepositStatus = remaining <= 0.005 ? "selesai" : used > 0 ? "sebagian" : "belum_dipakai";
  return { status, applied, refunded, forfeited, used, remaining };
}
