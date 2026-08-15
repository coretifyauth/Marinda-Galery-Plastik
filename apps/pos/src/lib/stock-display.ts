export type StockBreakdownUnit = { unit_label: string; conversion_factor: number };

/**
 * Greedy breakdown dari qty satuan dasar ke satuan campuran terbesar->terkecil
 * (mis. 166 pcs -> "1 box, 1 pack, 4 pcs"), niru pola nilai uang recehan.
 * Bukan pencarian kombinasi optimal — kalau conversion_factor antar satuan gak
 * bersarang rapi (bukan kelipatan), hasilnya tetap benar secara matematis
 * (jumlah semua bagian x faktornya = qtyBase) tapi bisa keliatan "boros" di
 * satuan tertentu. Diterima sebagai trade-off — cukup buat skala barang di bisnis ini.
 *
 * Duplikat persis dari apps/erp/src/lib/stock-display.ts -- belum ada shared
 * package antar apps/erp & apps/pos (memory/architecture/app/tech-stack-decisions.md),
 * fungsi ini kecil & jarang berubah jadi duplikasi diterima daripada bikin
 * package baru sekarang.
 *
 * Fallback: item tanpa satuan campuran (atau cuma factor<=1) -> tampil apa
 * adanya "{qty} {baseUom}", sama kayak sebelum fitur ini ada.
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
  if (baseAmount > 0 || parts.length === 0) {
    parts.push(`${baseAmount} ${baseUom}`);
  }

  return parts.join(", ");
}
