/** Preview diskon keranjang POS (Diskon Penjualan + Beli N Gratis X) -- MURNI buat tampilan
 * kasir (total/kembalian sebelum checkout), BUKAN otoritatif: nilai yang beneran dijurnal
 * dihitung ULANG server-side di create_pos_sale (resolve_item_discount /
 * resolve_bundle_promo_discounts). Server menerima qty & harga dalam SATUAN DASAR
 * (qty_sold x conversion_factor, unit_price / conversion_factor), jadi preview WAJIB memanggil
 * resolver dengan angka satuan dasar yang sama -- kalau tidak, aturan NOMINAL (Rp per satuan
 * dasar) dan hitungan kelipatan bundle meleset buat baris satuan non-dasar (mis. 2 bal).
 * Pola sama sisi admin (apps/erp: resolveItemDiscount dipanggil dengan change.baseQty). */

import type { CartLine } from "./pos-types";
import { resolveItemDiscount, type ItemDiscountRule } from "./promotion-item-discount-rules";
import { resolveBundlePromoDiscounts, type BundlePromoRule } from "./promotion-bundle-rules";

export type CartLineWithDiscount = CartLine & {
  discountRuleId: string | null;
  bundlePromoRuleId: string | null;
  combinedDiscount: number;
};

export function previewCartDiscounts(
  cart: CartLine[],
  categoryByItem: Map<string, string | null>,
  discountRules: ItemDiscountRule[],
  bundleRules: BundlePromoRule[]
): CartLineWithDiscount[] {
  // Total qty satuan dasar per barang lintas SEMUA baris -- basis cek syarat minimal diskon
  // (sama seperti v_item_totals di create_pos_sale).
  const totalBaseQty = new Map<string, number>();
  for (const line of cart) {
    totalBaseQty.set(line.item_id, (totalBaseQty.get(line.item_id) ?? 0) + line.qty_sold * line.conversion_factor);
  }

  const itemResolved = cart.map((line) => {
    const amount = line.qty_sold * line.unit_price;
    const baseQty = line.qty_sold * line.conversion_factor;
    const resolved = resolveItemDiscount(
      line.item_id,
      categoryByItem.get(line.item_id) ?? null,
      baseQty,
      amount,
      discountRules,
      totalBaseQty.get(line.item_id) ?? baseQty
    );
    return { discountRuleId: resolved?.discount_rule_id ?? null, discountAmount: resolved?.discount_amount ?? 0 };
  });

  const bundleResolved = resolveBundlePromoDiscounts(
    cart.map((line) => ({
      item_id: line.item_id,
      qty: line.qty_sold * line.conversion_factor,
      unit_price: line.unit_price / line.conversion_factor,
    })),
    bundleRules
  );

  return cart.map((line, i) => {
    const bundle = bundleResolved.get(i);
    const gross = line.qty_sold * line.unit_price;
    const combinedDiscount = Math.min(itemResolved[i].discountAmount + (bundle?.discount_amount ?? 0), gross);
    return {
      ...line,
      discountRuleId: itemResolved[i].discountRuleId,
      bundlePromoRuleId: bundle?.bundle_promo_rule_id ?? null,
      combinedDiscount,
    };
  });
}
