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
  ap_payment_allocations: { amount: number }[];
  ap_credit_notes?: { amount: number }[];
  ap_return_credit_applications?: { amount: number }[];
};

export type ApBillStatus = "lunas" | "sebagian" | "belum" | "dibatalkan";

/**
 * Status derived dari SUM(allocations) - SUM(retur/ap_credit_notes) - SUM(return-credit
 * applications) vs amount, plus cek reversal — bukan kolom, ref ap-schema.md. Mirror
 * `invoiceStatus()` di ar-invoices/schema.ts, dan sekarang mirror `ap_bill_remaining()` di
 * database (0035) — kalau ada reducer baru ditambah server-side, tambahin di sini juga.
 * `ap_return_credit_applications` gak perlu exclude via reversedEntryIds di sini (beda dari
 * `returnCreditRemaining()` di ap-return-credits/schema.ts yang emang perlu) — satu-satunya
 * jalur yang me-reverse jurnal application yang MENARGET bill ini adalah `cancel_ap_bill`
 * pas bill ini sendiri yang dibatalkan (lihat 0035 komentar cancel_ap_bill), jadi begitu
 * `isCancelled` true di sini, status udah short-circuit ke "dibatalkan" duluan — persis pola
 * `invoiceStatus()` di AR yang juga gak exclude ar_return_credit_applications.
 * `isCancelled` dihitung caller dari query terpisah (journal_entries.reverses_entry_id yang
 * nunjuk ke bill.journal_entry_id), karena bukan relasi langsung dari ap_bills.
 */
export function billStatus(
  bill: Pick<ApBill, "amount" | "ap_payment_allocations" | "ap_credit_notes" | "ap_return_credit_applications">,
  isCancelled = false
): {
  status: ApBillStatus;
  allocated: number;
  returned: number;
  returnCreditApplied: number;
  outstanding: number;
} {
  const allocated = bill.ap_payment_allocations.reduce((sum, a) => sum + a.amount, 0);
  const returned = (bill.ap_credit_notes ?? []).reduce((sum, c) => sum + c.amount, 0);
  const returnCreditApplied = (bill.ap_return_credit_applications ?? []).reduce((sum, a) => sum + a.amount, 0);
  const outstanding = bill.amount - allocated - returned - returnCreditApplied;
  if (isCancelled) {
    return { status: "dibatalkan", allocated, returned, returnCreditApplied, outstanding: 0 };
  }
  const status: ApBillStatus =
    outstanding <= 0.005 ? "lunas" : allocated > 0 || returnCreditApplied > 0 ? "sebagian" : "belum";
  return { status, allocated, returned, returnCreditApplied, outstanding };
}
