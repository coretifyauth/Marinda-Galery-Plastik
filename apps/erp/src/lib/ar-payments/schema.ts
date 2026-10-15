import { z } from "zod";

export const recordArPaymentSchema = z.object({
  customer_id: z.string().uuid("Pilih customer"),
  payment_date: z.string().min(1, "Tanggal wajib diisi"),
  // Uang riil yang pindah (bisa Rp0 kalau cuma menutup sisa receh di bawah satuan pembulatan) --
  // aturan lunas/cicil/tolak dicek server di record_payment, pratinjaunya lib/payments/rounding.ts.
  amount: z.coerce.number().min(0, "Jumlah gak boleh negatif"),
  payment_method: z.enum(["TUNAI", "BANK"], { message: "Pilih metode bayar" }),
  receivable_account_id: z.string().uuid("Pilih akun Piutang Usaha"),
  invoice_id: z.string().uuid("Pilih invoice"),
});

export type RecordArPaymentInput = z.infer<typeof recordArPaymentSchema>;

export type ArPayment = {
  id: string;
  customer_id: string;
  invoice_id: string;
  payment_date: string;
  amount: number;
  source_ref: string;
  journal_entry_id: string;
  created_at: string;
  counterparties: { name: string };
  ar_invoices: { source_ref: string };
};
