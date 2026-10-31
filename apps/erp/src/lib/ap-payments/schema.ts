import type { WithCancellation } from "@/lib/payments/active";
import { z } from "zod";

export const recordApPaymentSchema = z.object({
  supplier_id: z.string().uuid("Pilih supplier"),
  payment_date: z.string().min(1, "Tanggal wajib diisi"),
  // Uang riil yang pindah (bisa Rp0 kalau cuma menutup sisa receh di bawah satuan pembulatan) --
  // aturan lunas/cicil/tolak dicek server di record_payment, pratinjaunya lib/payments/rounding.ts.
  amount: z.coerce.number().min(0, "Jumlah gak boleh negatif"),
  payable_account_id: z.string().uuid("Pilih akun Utang Usaha"),
  payment_method: z.enum(["TUNAI", "BANK"], { message: "Pilih metode bayar" }),
  bill_id: z.string().uuid("Pilih bill"),
});

export type RecordApPaymentInput = z.infer<typeof recordApPaymentSchema>;

export type ApPayment = {
  id: string;
  supplier_id: string;
  bill_id: string;
  payment_date: string;
  amount: number;
  source_ref: string;
  journal_entry_id: string;
  created_at: string;
  counterparties: { name: string };
  ap_bills: { source_ref: string };
} & WithCancellation;
