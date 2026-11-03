export type StockBreakdownUnit = { unit_label: string; conversion_factor: number };

/**
 * Qty satuan dasar -> kombinasi satuan terbesar->terkecil, diikuti total satuan dasar dalam kurung
 * (mis. 234 lembar -> "1 ikat 3 bungkus (234 lembar)"). Greedy, niru pola nilai uang recehan.
 * Bukan pencarian kombinasi optimal — kalau conversion_factor antar satuan gak bersarang rapi,
 * hasilnya tetap benar secara matematis (jumlah semua bagian x faktornya = qtyBase).
 *
 * Tanpa satuan lebih besar yang terpakai (item tanpa item_units, atau qty lebih kecil dari satuan
 * terkecil di atas dasar) -> tampil apa adanya "{qty} {baseUom}" tanpa kurung, karena kurungnya
 * cuma mengulang angka yang sama.
 */
export function formatStockBreakdown(qtyBase: number, baseUom: string, units: StockBreakdownUnit[]): string {
  if (!qtyBase) return `0 ${baseUom}`;

  const wholeQty = Math.floor(qtyBase);
  const fraction = qtyBase - wholeQty;
  const largerUnits = units.filter((u) => u.conversion_factor > 1).sort((a, b) => b.conversion_factor - a.conversion_factor);

  const parts: string[] = [];
  let remaining = wholeQty;
  for (const u of largerUnits) {
    const count = Math.floor(remaining / u.conversion_factor);
    if (count > 0) {
      parts.push(`${count} ${u.unit_label}`);
      remaining -= count * u.conversion_factor;
    }
  }

  const baseAmount = Number((remaining + fraction).toFixed(3));
  const total = `${Number(qtyBase.toFixed(3))} ${baseUom}`;
  if (parts.length === 0) return total;
  if (baseAmount > 0) parts.push(`${baseAmount} ${baseUom}`);
  return `${parts.join(" ")} (${total})`;
}

/**
 * Qty & avg cost yang sama dinyatakan di tiap satuan item, terkecil->terbesar (satuan dasar duluan,
 * termasuk item tanpa baris item_units). Cuma konversi tampilan: stok & costing tetap di satuan dasar.
 *
 * Qty dibulatkan ke bawah (3 desimal, presisi qty_on_hand) biar 0,9996 sak gak terbaca "1 sak" padahal
 * belum genap; hitungannya integer biar lolos dari artefak float (1,001 jadi 1,000999...).
 */
export function formatStockPerUnit(
  qtyBase: number,
  avgCost: number,
  baseUom: string,
  units: StockBreakdownUnit[]
): { unitLabel: string; qty: string; avgCost: string }[] {
  const qtyMilli = Math.round(qtyBase * 1000);
  const largerUnits = units
    .filter((u) => u.unit_label !== baseUom)
    .sort((a, b) => a.conversion_factor - b.conversion_factor);

  return [{ unit_label: baseUom, conversion_factor: 1 }, ...largerUnits].map((u) => {
    const qty = Math.floor(qtyMilli / u.conversion_factor) / 1000;
    return {
      unitLabel: u.unit_label,
      qty: qty === 0 && qtyMilli > 0 ? "< 0,001" : qty.toLocaleString("id-ID", { maximumFractionDigits: 3 }),
      avgCost: (avgCost * u.conversion_factor).toLocaleString("id-ID", { maximumFractionDigits: 2 }),
    };
  });
}
