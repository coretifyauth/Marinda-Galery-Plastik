// Kalkulasi tampilan form barang masuk (belum tertagih). Murni helper UI -- angka final dihitung
// ulang server-side oleh create_goods_receipt (grn_prorate_discount), ini cuma buat preview & validasi awal.

export type ReceiptCalcLine = {
  qty: number;
  unitCost: number;
  /** Diskon item (Rupiah, per baris) -- helper di layar, dikirim ke RPC sebagai discount_amount baris. */
  itemDiscount: number;
};

export type ReceiptTotals = {
  subtotal: number;
  itemDiscountTotal: number;
  extraDiscount: number;
  totalDiscount: number;
  /** Nilai barang masuk = subtotal - diskon item - diskon tambahan. */
  total: number;
  /** Jumlah baris yang nilainya 0 (harga 0 / belum tahu). */
  zeroLineCount: number;
  problems: string[];
};

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function receiptTotals(lines: ReceiptCalcLine[], extraDiscount: number): ReceiptTotals {
  let subtotal = 0;
  let itemDiscountTotal = 0;
  let zeroLineCount = 0;
  const problems: string[] = [];

  lines.forEach((l, i) => {
    const gross = round2(l.qty * l.unitCost);
    subtotal += gross;
    itemDiscountTotal += l.itemDiscount;
    if (gross <= 0) zeroLineCount += 1;
    if (l.itemDiscount < 0) problems.push(`Diskon item baris ke-${i + 1} gak boleh negatif`);
    if (l.itemDiscount > gross + 0.005) problems.push(`Diskon item baris ke-${i + 1} melebihi nilai barisnya`);
  });

  const afterItem = subtotal - itemDiscountTotal;
  if (extraDiscount < 0) problems.push("Diskon tambahan gak boleh negatif");
  if (extraDiscount > afterItem + 0.005) problems.push("Diskon tambahan melebihi nilai pembelian setelah diskon item");

  return {
    subtotal,
    itemDiscountTotal,
    extraDiscount,
    totalDiscount: itemDiscountTotal + extraDiscount,
    total: afterItem - extraDiscount,
    zeroLineCount,
    problems,
  };
}
