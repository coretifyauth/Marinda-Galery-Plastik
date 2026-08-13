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
  customers: { name: string };
  ar_payments: { amount: number }[];
  ar_credit_notes?: { amount: number; ar_return_credits?: { amount: number }[] }[];
  ar_deposit_applications?: { amount: number }[];
  ar_bad_debt_writeoffs?: { amount: number }[];
  goods_issues?: { id: string; goods_issue_lines: { so_line_id: string | null }[] }[];
};

export type ArInvoiceOrigin = "sales_order" | "goods_issue" | "financial_only";

/** Invoice lahir dari 3 jalur beda (`memory/domain/inventory.md` submodule "Sales Order &
 * Pemenuhan Bertahap"): (1) pemenuhan Sales Order — ada `goods_issues` yang salah satu
 * baris-nya nunjuk balik ke `sales_order_lines` (`so_line_id` keisi); (2) Goods Issue langsung
 * (jual spontan, kios walk-in) — ada `goods_issues` tapi `so_line_id` semua baris-nya kosong;
 * (3) financial-only — invoice dicatat manual lewat /ar-invoices, gak ada `goods_issues` sama
 * sekali (gak ada stok/HPP yang kesentuh, mis. pendapatan jasa). 0 vs 1 baris `goods_issues`
 * per invoice, gak pernah lebih dari 1 -- tiap `create_goods_issue` call bikin invoice barunya
 * sendiri (fulfillment dicicil = invoice terpisah tiap cicilan). */
export function invoiceOrigin(invoice: Pick<ArInvoice, "goods_issues">): ArInvoiceOrigin {
  const gi = (invoice.goods_issues ?? [])[0];
  if (!gi) return "financial_only";
  return gi.goods_issue_lines.some((l) => l.so_line_id) ? "sales_order" : "goods_issue";
}

export type ArInvoiceStatus = "lunas" | "sebagian" | "belum" | "dibatalkan" | "dihapusbukukan";

/**
 * Status derived dari SUM(payment) - SUM(retur) - SUM(deposit applications) -
 * SUM(write-offs) vs amount, plus cek reversal — bukan kolom, ref ar-schema.md.
 * `ar_payments.invoice_id` gak unique lagi sejak migration 0010 — 1 invoice boleh punya
 * banyak baris payment dari waktu ke waktu (cicil), makanya `ar_payments` di sini array &
 * di-`reduce` (bukan ambil 1 baris). Masih 1 payment = 1 invoice (gak ada gabung invoice).
 * Retur yang kejadian setelah invoice lunas bikin excess-nya otomatis dicairkan jadi Saldo
 * Kredit Retur Customer (`ar_return_credits`, akun 2500) lewat jurnal reklasifikasi TERPISAH
 * yang membalikkan Piutang Usaha invoice ini balik ke 0 — makanya `ar_return_credits` di-ADD
 * BACK di sini (mirror `ar_invoice_remaining()` server-side, migration
 * `0020_ar_invoice_remaining_return_credit_fix.sql`), bukan cuma ngurangin lewat `ar_credit_notes`
 * doang. Tanpa add-back ini outstanding bisa keliatan minus padahal GL-nya udah balance. Saldo
 * kredit itu sendiri gak lagi bisa "dititip" motong invoice lain (dicabut, lihat "Saldo Kredit
 * dari Retur") — resolusinya cuma refund tunai atau warranty replacement.
 * `ar_deposit_applications` selalu aktif kalau invoice-nya masih hidup (belum
 * dibatalkan) — begitu invoice dibatalkan, `cancel_ar_invoice` nolak keras kalau udah ada
 * write-off (gak bisa dibatalkan lewat jalur itu), jadi gak perlu exclude yang di-reverse
 * buat write-off di sini (beda dari deposit yang auto-unwind, lihat "Uang Muka / DP" di
 * ar-schema.md).
 * Nilai-nilai reducer ini (dan rumus outstanding) sekarang mirror `ar_invoice_remaining()`
 * di database — kalau ada reducer baru ditambah server-side, tambahin di sini juga.
 * `isCancelled` dihitung caller dari query terpisah (journal_entries.reverses_entry_id
 * yang nunjuk ke invoice.journal_entry_id), karena bukan relasi langsung dari ar_invoices.
 * Status `dihapusbukukan` beda dari `lunas` — piutang ini gak pernah beneran dibayar,
 * cuma diakui hilang lewat write-off (lihat docs/domain/accounts-receivable.md bagian
 * "Piutang Tak Tertagih").
 */
export function invoiceStatus(
  invoice: Pick<ArInvoice, "amount" | "ar_payments" | "ar_credit_notes" | "ar_deposit_applications" | "ar_bad_debt_writeoffs">,
  isCancelled = false
): {
  status: ArInvoiceStatus;
  allocated: number;
  returned: number;
  depositApplied: number;
  writtenOff: number;
  outstanding: number;
} {
  const allocated = invoice.ar_payments.reduce((sum, p) => sum + p.amount, 0);
  const returned = (invoice.ar_credit_notes ?? []).reduce((sum, c) => sum + c.amount, 0);
  const returnCreditsSettled = (invoice.ar_credit_notes ?? []).reduce(
    (sum, c) => sum + (c.ar_return_credits ?? []).reduce((s, rc) => s + rc.amount, 0),
    0
  );
  const depositApplied = (invoice.ar_deposit_applications ?? []).reduce((sum, a) => sum + a.amount, 0);
  const writtenOff = (invoice.ar_bad_debt_writeoffs ?? []).reduce((sum, a) => sum + a.amount, 0);
  const outstanding = invoice.amount - allocated - returned - depositApplied - writtenOff + returnCreditsSettled;
  if (isCancelled) {
    return {
      status: "dibatalkan",
      allocated,
      returned,
      depositApplied,
      writtenOff,
      outstanding: 0,
    };
  }
  const status: ArInvoiceStatus =
    writtenOff > 0 && outstanding <= 0.005
      ? "dihapusbukukan"
      : outstanding <= 0.005
        ? "lunas"
        : allocated > 0 || depositApplied > 0
          ? "sebagian"
          : "belum";
  return { status, allocated, returned, depositApplied, writtenOff, outstanding };
}
