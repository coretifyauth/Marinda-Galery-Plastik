import { z } from "zod";
import { chargeLineSchema } from "@/lib/charge-lines/schema";
import { isActivePayment, type WithCancellation } from "@/lib/payments/active";

export const createApBillSchema = z.object({
  supplier_id: z.string().uuid("Pilih supplier"),
  bill_date: z.string().min(1, "Tanggal wajib diisi"),
  description: z.string().optional(),
  supplier_document_ref: z.string().optional(),
  debit_lines: z.array(chargeLineSchema).min(1, "Minimal 1 baris debit"),
  payable_account_id: z.string().uuid("Pilih akun Utang Usaha"),
  apply_tax: z.boolean().default(false),
  discount_amount: z.coerce.number().nonnegative().default(0),
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
  ap_payments: ({ amount: number } & WithCancellation)[];
  ap_returns?: { amount: number; ap_return_credits?: { amount: number }[] }[];
  ap_deposit_applications?: { amount: number }[];
  /** Koreksi Tagihan (migration 0060): + naik, - turun. */
  ap_bill_adjustments?: { amount: number }[];
};

export type ApBillOrigin = "order" | "goods_movement" | "financial_only";

/** Filter tipe di daftar tagihan: `barang` = tagihan barang (punya kolam, `has_goods_pool`), selain itu = `origin`
 * untuk tagihan yang bukan tagihan barang (tagihan lama dibuat bareng barang masuk, atau tagihan langsung). */
export type ApBillTypeFilter = ApBillOrigin | "barang" | "";

/** `origin` dihitung server-side oleh `recompute_transaction_status` dari barang masuk AKTIF tagihan itu, mirror
 * `ArInvoiceOrigin`: (1) `order` — ada barang masuk dari Purchase Order; (2) `goods_movement` — ada barang masuk tanpa
 * PO; (3) `financial_only` — belum/gak ada barang masuk (tagihan langsung, atau tagihan barang yang barangnya belum
 * datang). Satu tagihan barang bisa punya BANYAK barang masuk. Untuk membedakan tagihan barang dari tagihan langsung
 * pakai `has_goods_pool` (kolom di `ap_bills_with_status`, migration 0059). */
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
  /** true = tagihan barang (punya kolam; barang masuk dibuat dari tagihan ini). */
  has_goods_pool: boolean;
  created_by: string | null;
  counterparties: { name: string };
};

export type ApBillStatus = "lunas" | "sebagian" | "belum" | "dibatalkan";

/**
 * Status derived dari SUM(ap_payments) - SUM(retur/ap_returns) - SUM(DP application) +
 * SUM(ap_return_credits) vs amount, plus cek reversal — bukan kolom, ref ap-schema.md. Mirror
 * `invoiceStatus()` di ar-invoices/schema.ts, dan mirror `ap_bill_remaining()` di database —
 * kalau ada reducer baru ditambah server-side, tambahin di sini juga. Reducer
 * `ap_deposit_applications` ditambah migration `0013_ap_deposits_schema.sql`, mirror
 * `ar_deposit_applications` di AR. Reducer return-credit applications dicabut migration 0009
 * bareng fitur "dipakai motong bill lain" (bukan fondasi AP). Reducer add-back
 * `ap_return_credits` ditambah migration `0010_ap_bill_remaining_return_credit_fix.sql` —
 * ngebatalin over-subtraction dari `ap_returns` waktu sebagian/semua nominal retur itu
 * excess yang direklasifikasi keluar dari Utang Usaha ke Piutang Retur Supplier (bukan beneran
 * ngurangin Utang Usaha lagi), tanpa ini outstanding bisa keliatan minus walau GL udah balance.
 * Sejak migration 0011, `ap_payments` nunjuk `bill_id` langsung (gak lewat tabel jembatan
 * `ap_payment_allocations` lagi) — 1 bill boleh punya banyak baris payment (cicil), makanya
 * tetap di-`reduce`.
 * `isCancelled` dihitung caller dari query terpisah (journal_entries.reverses_entry_id yang
 * nunjuk ke bill.journal_entry_id), karena bukan relasi langsung dari ap_bills.
 * Pembayaran yang dibatalkan gak dihitung, dan Koreksi Tagihan ikut menaikkan/menurunkan sisa (migration 0060).
 */
export function billStatus(
  bill: Pick<ApBill, "amount" | "ap_payments" | "ap_returns" | "ap_deposit_applications" | "ap_bill_adjustments">,
  isCancelled = false
): {
  status: ApBillStatus;
  allocated: number;
  returned: number;
  depositApplied: number;
  adjusted: number;
  outstanding: number;
} {
  const allocated = bill.ap_payments.filter(isActivePayment).reduce((sum, a) => sum + a.amount, 0);
  const adjusted = (bill.ap_bill_adjustments ?? []).reduce((sum, a) => sum + a.amount, 0);
  const returned = (bill.ap_returns ?? []).reduce((sum, c) => sum + c.amount, 0);
  const depositApplied = (bill.ap_deposit_applications ?? []).reduce((sum, a) => sum + a.amount, 0);
  const returnCreditExcess = (bill.ap_returns ?? []).reduce(
    (sum, c) => sum + (c.ap_return_credits ?? []).reduce((s, r) => s + r.amount, 0),
    0
  );
  const outstanding = bill.amount + adjusted - allocated - returned - depositApplied + returnCreditExcess;
  if (isCancelled) {
    return { status: "dibatalkan", allocated, returned, depositApplied, adjusted, outstanding: 0 };
  }
  const status: ApBillStatus =
    outstanding <= 0.005 ? "lunas" : allocated > 0 || depositApplied > 0 ? "sebagian" : "belum";
  return { status, allocated, returned, depositApplied, adjusted, outstanding };
}
