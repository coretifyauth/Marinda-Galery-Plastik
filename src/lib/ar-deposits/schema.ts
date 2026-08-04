import { z } from "zod";

export const createArDepositSchema = z.object({
  customer_id: z.string().uuid("Pilih customer"),
  deposit_date: z.string().min(1, "Tanggal wajib diisi"),
  source_ref: z.string().min(1, "Rujukan dokumen wajib diisi"),
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
  source_ref: z.string().min(1, "Rujukan dokumen wajib diisi"),
  deposit_liability_account_id: z.string().uuid("Pilih akun Uang Muka Penjualan"),
  receivable_account_id: z.string().uuid("Pilih akun Piutang Usaha"),
});
export type ApplyArDepositInput = z.infer<typeof applyArDepositSchema>;

export const forfeitArDepositSchema = z.object({
  deposit_id: z.string().uuid("Pilih deposit"),
  forfeiture_date: z.string().min(1, "Tanggal wajib diisi"),
  source_ref: z.string().min(1, "Rujukan dokumen wajib diisi"),
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
  ar_deposit_forfeitures: {
    id: string;
    forfeiture_date: string;
    source_ref: string;
    journal_entry_id: string;
  }[];
};

export type ArDepositStatus = "belum_dipakai" | "diterapkan" | "hangus";

/**
 * Status derived dari ar_deposit_applications/ar_deposit_forfeitures — bukan kolom, sama
 * pola invoiceStatus(). Application yang journal_entry_id-nya udah di-reverse (invoice-nya
 * dibatalkan lewat cancel_ar_invoice) dianggap gak aktif lagi — deposit balik "belum
 * dipakai". `reversedEntryIds` sama persis Set yang dipakai invoiceStatus() (dari
 * journal_entries.reverses_entry_id), reuse query yang sama, jangan query ulang.
 */
export function depositStatus(
  deposit: Pick<ArDeposit, "amount" | "ar_deposit_applications" | "ar_deposit_forfeitures">,
  reversedEntryIds: Set<string>
): { status: ArDepositStatus; applied: number; remaining: number } {
  if (deposit.ar_deposit_forfeitures.length > 0) {
    return { status: "hangus", applied: 0, remaining: 0 };
  }
  const activeApplications = deposit.ar_deposit_applications.filter(
    (a) => !reversedEntryIds.has(a.journal_entry_id)
  );
  const applied = activeApplications.reduce((sum, a) => sum + a.amount, 0);
  const remaining = deposit.amount - applied;
  const status: ArDepositStatus = applied > 0 ? "diterapkan" : "belum_dipakai";
  return { status, applied, remaining };
}
