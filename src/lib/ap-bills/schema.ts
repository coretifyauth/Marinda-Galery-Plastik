import { z } from "zod";

export const createApBillSchema = z.object({
  supplier_id: z.string().uuid("Pilih supplier"),
  bill_date: z.string().min(1, "Tanggal wajib diisi"),
  description: z.string().optional(),
  source_ref: z.string().min(1, "Rujukan dokumen sumber wajib diisi"),
  amount: z.coerce.number().positive("Jumlah harus lebih dari 0"),
  debit_account_id: z.string().uuid("Pilih akun Persediaan/Beban"),
  payable_account_id: z.string().uuid("Pilih akun Utang Usaha"),
});

export type CreateApBillInput = z.infer<typeof createApBillSchema>;

export type ApBill = {
  id: string;
  supplier_id: string;
  bill_date: string;
  due_date: string;
  description: string | null;
  source_ref: string;
  amount: number;
  journal_entry_id: string;
  created_at: string;
  suppliers: { name: string };
  ap_payments: { amount: number }[];
  ap_credit_notes?: { amount: number }[];
};

export type ApBillStatus = "lunas" | "sebagian" | "belum" | "dibatalkan";

/**
 * Status derived dari SUM(ap_payments) - SUM(retur/ap_credit_notes) vs amount, plus cek
 * reversal — bukan kolom, ref ap-schema.md. Mirror `invoiceStatus()` di ar-invoices/schema.ts,
 * dan mirror `ap_bill_remaining()` di database — kalau ada reducer baru ditambah server-side,
 * tambahin di sini juga. Reducer ke-3 (return-credit applications) dicabut migration 0009
 * bareng fitur "dipakai motong bill lain" (bukan fondasi AP). Sejak migration 0011,
 * `ap_payments` nunjuk `bill_id` langsung (gak lewat tabel jembatan `ap_payment_allocations`
 * lagi) — 1 bill boleh punya banyak baris payment (cicil), makanya tetap di-`reduce`.
 * `isCancelled` dihitung caller dari query terpisah (journal_entries.reverses_entry_id yang
 * nunjuk ke bill.journal_entry_id), karena bukan relasi langsung dari ap_bills.
 */
export function billStatus(
  bill: Pick<ApBill, "amount" | "ap_payments" | "ap_credit_notes">,
  isCancelled = false
): {
  status: ApBillStatus;
  allocated: number;
  returned: number;
  outstanding: number;
} {
  const allocated = bill.ap_payments.reduce((sum, a) => sum + a.amount, 0);
  const returned = (bill.ap_credit_notes ?? []).reduce((sum, c) => sum + c.amount, 0);
  const outstanding = bill.amount - allocated - returned;
  if (isCancelled) {
    return { status: "dibatalkan", allocated, returned, outstanding: 0 };
  }
  const status: ApBillStatus = outstanding <= 0.005 ? "lunas" : allocated > 0 ? "sebagian" : "belum";
  return { status, allocated, returned, outstanding };
}
