import { z } from "zod";
import { chargeLineSchema } from "@/lib/charge-lines/schema";

export const createApBillSchema = z.object({
  supplier_id: z.string().uuid("Pilih supplier"),
  bill_date: z.string().min(1, "Tanggal wajib diisi"),
  description: z.string().optional(),
  supplier_document_ref: z.string().optional(),
  debit_lines: z.array(chargeLineSchema).min(1, "Minimal 1 baris debit"),
  payable_account_id: z.string().uuid("Pilih akun Utang Usaha"),
  apply_tax: z.boolean().default(false),
});

export type CreateApBillInput = z.infer<typeof createApBillSchema>;

export type ApBill = {
  id: string;
  supplier_id: string;
  bill_date: string;
  due_date: string;
  description: string | null;
  source_ref: string;
  supplier_document_ref: string | null;
  amount: number;
  journal_entry_id: string;
  created_at: string;
  counterparties: { name: string };
  ap_payments: { amount: number }[];
  ap_credit_notes?: { amount: number; ap_return_credits?: { amount: number }[] }[];
  ap_deposit_applications?: { amount: number }[];
};

export type ApBillOrigin = "order" | "goods_movement" | "financial_only";

/** Bill lahir dari 3 jalur beda, mirror `ArInvoiceOrigin`: (1) `order` — dari Purchase Order,
 * `goods_receipt_notes.order_id` keisi; (2) `goods_movement` — terima barang langsung tanpa PO,
 * ada `goods_receipt_notes` tapi `order_id` kosong; (3) `financial_only` — bill dicatat manual
 * lewat /ap-bills, gak ada `goods_receipt_notes` sama sekali (biasanya beban non-persediaan).
 * 0 vs 1 baris `goods_receipt_notes` per bill, gak pernah lebih dari 1 -- tiap
 * `create_goods_receipt` call bikin bill barunya sendiri. Vocabulary ini sebelumnya cuma
 * `grn`/`langsung` (2-arah, gak pernah bedain GRN dari PO vs terima langsung) -- diunifikasi
 * sama sisi AR jadi 3-arah di migration `0066`. Dihitung server-side lewat
 * `recompute_transaction_status` (migration `0064`+`0066`), kolom `origin` di
 * `ap_bills_with_status` -- lihat `ApBillListRow`. */
export type ApBillListRow = {
  id: string;
  supplier_id: string;
  bill_date: string;
  due_date: string;
  description: string | null;
  source_ref: string;
  supplier_document_ref: string | null;
  amount: number;
  journal_entry_id: string;
  created_at: string;
  outstanding: number;
  status: ApBillStatus;
  origin: ApBillOrigin;
  counterparties: { name: string };
};

export type ApBillStatus = "lunas" | "sebagian" | "belum" | "dibatalkan";

/**
 * Status derived dari SUM(ap_payments) - SUM(retur/ap_credit_notes) - SUM(DP application) +
 * SUM(ap_return_credits) vs amount, plus cek reversal — bukan kolom, ref ap-schema.md. Mirror
 * `invoiceStatus()` di ar-invoices/schema.ts, dan mirror `ap_bill_remaining()` di database —
 * kalau ada reducer baru ditambah server-side, tambahin di sini juga. Reducer
 * `ap_deposit_applications` ditambah migration `0013_ap_deposits_schema.sql`, mirror
 * `ar_deposit_applications` di AR. Reducer return-credit applications dicabut migration 0009
 * bareng fitur "dipakai motong bill lain" (bukan fondasi AP). Reducer add-back
 * `ap_return_credits` ditambah migration `0010_ap_bill_remaining_return_credit_fix.sql` —
 * ngebatalin over-subtraction dari `ap_credit_notes` waktu sebagian/semua nominal retur itu
 * excess yang direklasifikasi keluar dari Utang Usaha ke Piutang Retur Supplier (bukan beneran
 * ngurangin Utang Usaha lagi), tanpa ini outstanding bisa keliatan minus walau GL udah balance.
 * Sejak migration 0011, `ap_payments` nunjuk `bill_id` langsung (gak lewat tabel jembatan
 * `ap_payment_allocations` lagi) — 1 bill boleh punya banyak baris payment (cicil), makanya
 * tetap di-`reduce`.
 * `isCancelled` dihitung caller dari query terpisah (journal_entries.reverses_entry_id yang
 * nunjuk ke bill.journal_entry_id), karena bukan relasi langsung dari ap_bills.
 */
export function billStatus(
  bill: Pick<ApBill, "amount" | "ap_payments" | "ap_credit_notes" | "ap_deposit_applications">,
  isCancelled = false
): {
  status: ApBillStatus;
  allocated: number;
  returned: number;
  depositApplied: number;
  outstanding: number;
} {
  const allocated = bill.ap_payments.reduce((sum, a) => sum + a.amount, 0);
  const returned = (bill.ap_credit_notes ?? []).reduce((sum, c) => sum + c.amount, 0);
  const depositApplied = (bill.ap_deposit_applications ?? []).reduce((sum, a) => sum + a.amount, 0);
  const returnCreditExcess = (bill.ap_credit_notes ?? []).reduce(
    (sum, c) => sum + (c.ap_return_credits ?? []).reduce((s, r) => s + r.amount, 0),
    0
  );
  const outstanding = bill.amount - allocated - returned - depositApplied + returnCreditExcess;
  if (isCancelled) {
    return { status: "dibatalkan", allocated, returned, depositApplied, outstanding: 0 };
  }
  const status: ApBillStatus =
    outstanding <= 0.005 ? "lunas" : allocated > 0 || depositApplied > 0 ? "sebagian" : "belum";
  return { status, allocated, returned, depositApplied, outstanding };
}
