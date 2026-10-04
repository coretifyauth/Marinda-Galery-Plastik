import { z } from "zod";
import { supabase } from "@/lib/supabase/client";

/** Ref: docs/domain/accounts-receivable.md submodule "Diskon Penjualan (Trade Discount)",
 * docs/architecture/item-discount-rules-schema.md. */
export const itemDiscountRuleSchema = z.object({
  name: z.string().min(1, "Nama aturan wajib diisi"),
  item_id: z.string().uuid().nullable(),
  category_id: z.string().uuid().nullable(),
  discount_type: z.enum(["PERCENT", "NOMINAL"]),
  discount_value: z.coerce.number().positive("Nilai diskon harus lebih dari 0"),
  // Syarat minimal qty (opsional, cuma aturan level barang): min_qty dalam satuan min_qty_unit_id
  // -- DB yang ngonversi ke min_qty_base (trigger). Kosong dua-duanya = tanpa syarat.
  min_qty: z.coerce.number().positive("Syarat minimal qty harus lebih dari 0").nullable().optional(),
  min_qty_unit_id: z.string().uuid().nullable().optional(),
})
  .refine((v) => (v.min_qty == null) === (v.min_qty_unit_id == null), {
    message: "Syarat minimal qty dan satuannya harus diisi bersamaan",
    path: ["min_qty"],
  })
  .refine((v) => v.category_id == null || v.min_qty == null, {
    message: "Syarat minimal qty cuma bisa untuk aturan barang, bukan kategori",
    path: ["min_qty"],
  });

export type ItemDiscountRule = {
  id: string;
  name: string;
  item_id: string | null;
  category_id: string | null;
  discount_type: "PERCENT" | "NOMINAL";
  discount_value: number;
  archived_at: string | null;
  /** Syarat minimal qty dalam SATUAN DASAR (diisi trigger DB dari min_qty x faktor satuan). null/undefined = tanpa syarat. */
  min_qty_base?: number | null;
  /** Syarat sebagaimana diketik admin -- cuma buat tampilan/edit. */
  min_qty?: number | null;
  min_qty_unit_id?: string | null;
};

export type ResolvedItemDiscount = { discount_rule_id: string; discount_amount: number };

/** Fetch cuma aturan yang masih aktif -- dipakai form Sales Order/Goods Issue buat resolve
 * diskon otomatis (sistem yang mencocokkan, staf gak pernah pilih manual). */
export async function fetchActiveItemDiscountRules(): Promise<ItemDiscountRule[]> {
  const { data } = await supabase
    .from("promotion_item_discount_rules")
    .select("id, name, item_id, category_id, discount_type, discount_value, archived_at, min_qty, min_qty_unit_id, min_qty_base")
    .is("archived_at", null);
  return (data ?? []) as ItemDiscountRule[];
}

/**
 * Cocokkan 1 barang ke aturan diskon aktif. Aturan `item_id` menang atas aturan `category_id`
 * penaungnya -- TAPI cuma aturan barang yang syarat minimalnya TERPENUHI (`min_qty_base` <=
 * `totalQty`); kalau gak ada yang terpenuhi, jatuh ke aturan kategori (kategori selalu tanpa
 * syarat). Kalau beberapa tingkat terpenuhi, dipakai SATU tingkat tertinggi (gak ditumpuk).
 * `rules` harus sudah hasil `fetchActiveItemDiscountRules` (cuma yang aktif).
 * Mirror persis resolve_item_discount SQL (0050).
 *
 * `amount` = qty (satuan yang dipilih user) x harga satuan itu -- nilai uang, bebas satuan.
 * `baseQty` = qty BARIS ini dalam satuan dasar -- NOMINAL selalu Rupiah per unit satuan DASAR.
 * `totalQty` = total qty satuan dasar barang ini lintas SEMUA baris transaksi -- cuma buat cek
 * syarat minimal (default `baseQty`). Begitu syarat terpenuhi, diskon dihitung ke qty/amount
 * baris ini (seluruh qty tiap baris barang itu kena diskon, bukan cuma kelebihan di atas syarat).
 */
export function resolveItemDiscount(
  itemId: string,
  categoryId: string | null,
  baseQty: number,
  amount: number,
  rules: ItemDiscountRule[],
  totalQty: number = baseQty
): ResolvedItemDiscount | null {
  const itemRule = rules
    .filter((r) => r.item_id === itemId && (r.min_qty_base ?? 0) <= totalQty)
    .sort((a, b) => (b.min_qty_base ?? 0) - (a.min_qty_base ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
  const rule = itemRule ?? (categoryId ? rules.find((r) => r.category_id === categoryId) : undefined);
  if (!rule) return null;

  const raw = rule.discount_type === "PERCENT" ? (amount * rule.discount_value) / 100 : baseQty * rule.discount_value;
  const discount_amount = Math.min(Math.round(raw * 100) / 100, amount);
  if (discount_amount <= 0) return null;
  return { discount_rule_id: rule.id, discount_amount };
}

export type DiscountLineInput = { item_id: string; category_id: string | null; baseQty: number; amount: number };

/**
 * Resolusi cart-wide buat form admin (Sales Order, Fulfill, Goods Issue): total qty satuan dasar
 * per barang dihitung dari SEMUA baris, lalu tiap baris di-resolve dengan total itu sebagai
 * basis syarat minimal. `thresholdTotals` (opsional) menimpa basis itu per item_id -- dipakai
 * Fulfill: syarat dicek ke total qty yang DIPESAN di SO, sementara diskon dihitung ke qty yang
 * dikirim (jadi SO 12 dos dikirim 6+6 tetap dapat diskon ">=10 dos" di kedua pengiriman).
 * Return array sejajar `lines` (null = gak ada diskon / baris kosong).
 */
export function resolveLineItemDiscounts(
  lines: DiscountLineInput[],
  rules: ItemDiscountRule[],
  thresholdTotals?: Map<string, number>
): (ResolvedItemDiscount | null)[] {
  const totals = new Map<string, number>();
  for (const l of lines) totals.set(l.item_id, (totals.get(l.item_id) ?? 0) + l.baseQty);
  return lines.map((l) => {
    if (!l.item_id || !(l.baseQty > 0)) return null;
    const total = thresholdTotals?.get(l.item_id) ?? totals.get(l.item_id) ?? l.baseQty;
    return resolveItemDiscount(l.item_id, l.category_id, l.baseQty, l.amount, rules, total);
  });
}
