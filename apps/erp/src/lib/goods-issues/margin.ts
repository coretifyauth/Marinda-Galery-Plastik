export type InvoiceLine = { account_id: string; amount: number; is_tax: boolean };

// Uang dijumlah dalam sen (Core Invariant: money never float).
const cents = (n: number) => Math.round(Number(n) * 100);
const sum = (values: number[]) => values.reduce((s, v) => s + cents(v), 0) / 100;

/**
 * Pecahan nilai invoice barang keluar: PPN (is_tax), biaya tambahan (akun kategori charge_categories module ar/pos),
 * dan sisanya = penjualan barang (sudah net diskon, tanpa PPN). Heuristik yang sama dengan cetak invoice dan dashboard.
 */
export function splitInvoiceLines(lines: InvoiceLine[], chargeAccountIds: Set<string>) {
  const goods = lines.filter((l) => !l.is_tax && !chargeAccountIds.has(l.account_id));
  const extra = lines.filter((l) => !l.is_tax && chargeAccountIds.has(l.account_id));
  const tax = lines.filter((l) => l.is_tax);
  return { goodsRevenue: sum(goods.map((l) => l.amount)), extraCharges: sum(extra.map((l) => l.amount)), ppn: sum(tax.map((l) => l.amount)) };
}

/** Laba kotor & margin (% dari penjualan barang). Margin null kalau penjualan barang <= 0. */
export function grossMargin(goodsRevenue: number, totalHpp: number) {
  const profit = (cents(goodsRevenue) - cents(totalHpp)) / 100;
  return { profit, marginPct: goodsRevenue > 0 ? (profit / goodsRevenue) * 100 : null };
}
