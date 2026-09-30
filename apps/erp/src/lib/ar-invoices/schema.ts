import { z } from "zod";
import { chargeLineSchema } from "@/lib/charge-lines/schema";

export const createArInvoiceSchema = z.object({
  customer_id: z.string().uuid("Pilih customer"),
  invoice_date: z.string().min(1, "Tanggal wajib diisi"),
  description: z.string().optional(),
  credit_lines: z.array(chargeLineSchema).min(1, "Minimal 1 baris kredit"),
  receivable_account_id: z.string().uuid("Pilih akun Piutang Usaha"),
  apply_tax: z.boolean().default(false),
});

export type CreateArInvoiceInput = z.infer<typeof createArInvoiceSchema>;

export type ArInvoice = {
  id: string;
  customer_id: string;
  invoice_date: string;
  due_date: string;
  description: string | null;
  source_ref: string;
  amount: number;
  journal_entry_id: string;
  created_at: string;
  counterparties: { name: string };
  ar_payments: { amount: number }[];
  ar_returns?: {
    amount: number;
    ar_return_credits?: { amount: number }[];
  }[];
  ar_deposit_applications?: { amount: number }[];
};

export type ArInvoiceOrigin = "order" | "goods_movement" | "financial_only";

/** Invoice lahir dari 3 jalur beda (`docs/domain/inventory.md` submodule "Sales Order &
 * Pemenuhan Bertahap"): (1) `order` — pemenuhan Sales Order, ada `goods_issues` yang salah
 * satu baris-nya nunjuk balik ke `order_lines` (`order_line_id` keisi); (2) `goods_movement`
 * — Goods Issue langsung (jual spontan, kios walk-in), ada `goods_issues` tapi `order_line_id`
 * semua baris-nya kosong; (3) `financial_only` — invoice dicatat manual lewat /ar-invoices,
 * gak ada `goods_issues` sama sekali (gak ada stok/HPP yang kesentuh, mis. pendapatan jasa).
 * 0 vs 1 baris `goods_issues` per invoice, gak pernah lebih dari 1 -- tiap `create_goods_issue`
 * call bikin invoice barunya sendiri (fulfillment dicicil = invoice terpisah tiap cicilan).
 * Vocabulary ini SAMA dipakai sisi AP (`ApBillOrigin`, `order`=dari Purchase Order,
 * `goods_movement`=terima barang langsung) sejak migration `0066` -- sebelumnya AR pakai
 * `sales_order`/`goods_issue`/`financial_only`, AP pakai `grn`/`langsung`, diunifikasi biar
 * 1 vocabulary buat konsep yang sama di 2 arah. Dihitung server-side lewat `recompute_transaction_status`
 * (migration `0064`+`0066`), kolom `origin` di `ar_invoices_with_status` -- lihat `ArInvoiceListRow`. */
export type ArInvoiceListRow = {
  id: string;
  customer_id: string;
  invoice_date: string;
  due_date: string;
  description: string | null;
  source_ref: string;
  amount: number;
  journal_entry_id: string;
  created_at: string;
  outstanding: number;
  returned: number;
  status: ArInvoiceStatus;
  origin: ArInvoiceOrigin;
  created_by: string | null;
  counterparties: { name: string };
};

export type ArInvoiceStatus = "lunas" | "sebagian" | "belum" | "dibatalkan";

/**
 * Status derived dari SUM(payment) - SUM(retur) - SUM(deposit applications)
 * vs amount, plus cek reversal — bukan kolom, ref ar-schema.md.
 * `ar_payments.invoice_id` gak unique lagi sejak migration 0010 — 1 invoice boleh punya
 * banyak baris payment dari waktu ke waktu (cicil), makanya `ar_payments` di sini array &
 * di-`reduce` (bukan ambil 1 baris). Masih 1 payment = 1 invoice (gak ada gabung invoice).
 * Retur yang kejadian setelah invoice lunas bikin excess-nya otomatis dicairkan jadi Saldo
 * Kredit Retur Customer (`ar_return_credits`, akun 2500) lewat jurnal reklasifikasi TERPISAH
 * yang membalikkan Piutang Usaha invoice ini balik ke 0 — makanya `ar_return_credits` di-ADD
 * BACK di sini (mirror `ar_invoice_remaining()` server-side, migration
 * `0020_ar_invoice_remaining_return_credit_fix.sql`), bukan cuma ngurangin lewat `ar_returns`
 * doang. Tanpa add-back ini outstanding bisa keliatan minus padahal GL-nya udah balance. Saldo
 * kredit itu sendiri gak lagi bisa "dititip" motong invoice lain (dicabut, lihat "Saldo Kredit
 * dari Retur") — resolusinya cuma refund tunai (ganti barang pasca-retur/garansi berdiri sendiri,
 * gak nyentuh Piutang Usaha sama sekali — lihat `replacements-schema.md`).
 * `ar_deposit_applications` selalu aktif kalau invoice-nya masih hidup (belum
 * dibatalkan) — begitu invoice dibatalkan, `cancel_ar_invoice` nolak keras kalau udah ada
 * write-off (gak bisa dibatalkan lewat jalur itu), jadi gak perlu exclude yang di-reverse
 * buat write-off di sini (beda dari deposit yang auto-unwind, lihat "Uang Muka / DP" di
 * ar-schema.md).
 * Nilai-nilai reducer ini (dan rumus outstanding) sekarang mirror `ar_invoice_remaining()`
 * di database — kalau ada reducer baru ditambah server-side, tambahin di sini juga.
 * `isCancelled` dihitung caller dari query terpisah (journal_entries.reverses_entry_id
 * yang nunjuk ke invoice.journal_entry_id), karena bukan relasi langsung dari ar_invoices.
 */
export function invoiceStatus(
  invoice: Pick<ArInvoice, "amount" | "ar_payments" | "ar_returns" | "ar_deposit_applications">,
  isCancelled = false
): {
  status: ArInvoiceStatus;
  allocated: number;
  returned: number;
  depositApplied: number;
  outstanding: number;
} {
  const allocated = invoice.ar_payments.reduce((sum, p) => sum + p.amount, 0);
  const returned = (invoice.ar_returns ?? []).reduce((sum, c) => sum + c.amount, 0);
  const returnCreditsSettled = (invoice.ar_returns ?? []).reduce(
    (sum, c) => sum + (c.ar_return_credits ?? []).reduce((s, rc) => s + rc.amount, 0),
    0
  );
  const depositApplied = (invoice.ar_deposit_applications ?? []).reduce((sum, a) => sum + a.amount, 0);
  const outstanding = invoice.amount - allocated - returned - depositApplied + returnCreditsSettled;
  if (isCancelled) {
    return { status: "dibatalkan", allocated, returned, depositApplied, outstanding: 0 };
  }
  const status: ArInvoiceStatus =
    outstanding <= 0.005 ? "lunas" : allocated > 0 || depositApplied > 0 ? "sebagian" : "belum";
  return { status, allocated, returned, depositApplied, outstanding };
}
