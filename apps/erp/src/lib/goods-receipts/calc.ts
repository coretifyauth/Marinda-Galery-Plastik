// Kalkulasi tampilan form barang masuk. Murni helper UI -- angka final dihitung ulang server-side oleh
// create_goods_receipt (grn_prorate_discount), ini cuma buat preview & validasi awal.

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
  problems: string[];
};

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const round3 = (n: number) => Math.round((n + Number.EPSILON) * 1000) / 1000;

export function receiptTotals(lines: ReceiptCalcLine[], extraDiscount: number): ReceiptTotals {
  let subtotal = 0;
  let itemDiscountTotal = 0;
  const problems: string[] = [];

  lines.forEach((l, i) => {
    const gross = round2(l.qty * l.unitCost);
    subtotal += gross;
    itemDiscountTotal += l.itemDiscount;
    if (l.unitCost <= 0) problems.push(`Harga baris ke-${i + 1} harus lebih dari 0 -- barang masuk wajib berharga sesuai nota`);
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
    problems,
  };
}

export type NormalizedReceiptLine = { qty: number; unitCost: number; discount: number };

/**
 * Menormalkan 1 baris ke presisi kolom tersimpan (qty 3 desimal, harga 2 desimal) TANPA mengubah nilai bersih.
 * Harga per satuan dasar hasil konversi satuan (mis. Rp10.000 per dus isi 12 -> Rp833,3333/pcs) dibulatkan KE ATAS ke
 * sen, dan selisih pembulatannya (qty x harga bulat - nilai sebenarnya) ditambahkan ke diskon baris, sehingga nilai
 * bersih baris = nilai di nota (Rp10.000), bukan Rp9.999,96 atau Rp10.000,08. Server menolak presisi lebih dari kolom,
 * jadi semua form barang masuk wajib melewati fungsi ini sebelum memanggil create_goods_receipt.
 */
export function normalizeReceiptLine(qty: number, unitCost: number, itemDiscount: number): NormalizedReceiptLine {
  // -1e-6: buang noise floating point (833.33 x 100 = 83332.99999999999 atau 83330.00000000001)
  const unit = Math.ceil(unitCost * 100 - 1e-6) / 100;
  const gross = round2(qty * unit);
  const exact = round2(qty * unitCost);
  const adjustment = Math.max(0, round2(gross - exact));
  return { qty: round3(qty), unitCost: unit, discount: round2(itemDiscount + adjustment) };
}

/** Batas beda harga dari harga rata-rata stok sebelum minta konfirmasi. */
export const PRICE_DEVIATION_LIMIT = 0.3;

export type PriceCheckLine = { itemId: string; itemName: string; netUnitCost: number };
export type PriceDeviation = PriceCheckLine & { avgCost: number; ratio: number };

export function findPriceDeviations(lines: PriceCheckLine[], avgCosts: Map<string, number>): PriceDeviation[] {
  const result: PriceDeviation[] = [];
  for (const line of lines) {
    const avgCost = avgCosts.get(line.itemId) ?? 0;
    if (avgCost <= 0) continue; // barang baru: belum ada pembanding
    const ratio = Math.abs(line.netUnitCost - avgCost) / avgCost;
    if (ratio > PRICE_DEVIATION_LIMIT) result.push({ ...line, avgCost, ratio });
  }
  return result;
}
