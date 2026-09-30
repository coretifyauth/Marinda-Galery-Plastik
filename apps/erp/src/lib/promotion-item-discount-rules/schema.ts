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
});

export type ItemDiscountRule = {
  id: string;
  name: string;
  item_id: string | null;
  category_id: string | null;
  discount_type: "PERCENT" | "NOMINAL";
  discount_value: number;
  archived_at: string | null;
};

export type ResolvedItemDiscount = { discount_rule_id: string; discount_amount: number };

/** Fetch cuma aturan yang masih aktif -- dipakai form Sales Order/Goods Issue buat resolve
 * diskon otomatis (sistem yang mencocokkan, staf gak pernah pilih manual). */
export async function fetchActiveItemDiscountRules(): Promise<ItemDiscountRule[]> {
  const { data } = await supabase
    .from("promotion_item_discount_rules")
    .select("id, name, item_id, category_id, discount_type, discount_value, archived_at")
    .is("archived_at", null);
  return (data ?? []) as ItemDiscountRule[];
}

/**
 * Cocokkan 1 barang ke aturan diskon aktif -- aturan `item_id` (lebih spesifik) menang atas
 * aturan `category_id` penaungnya (docs/architecture/item-discount-rules-schema.md). `rules`
 * harus sudah hasil `fetchActiveItemDiscountRules` (cuma yang aktif).
 *
 * `amount` = qty (satuan yang dipilih user) x harga satuan itu (`UomQtyChange.amount`).
 * `baseQty` = qty dikonversi ke satuan dasar (`UomQtyChange.baseQty`) -- NOMINAL selalu Rupiah
 * per unit satuan DASAR (bukan per baris), biar hasilnya konsisten walau satuan jual beda-beda.
 */
export function resolveItemDiscount(
  itemId: string,
  categoryId: string | null,
  baseQty: number,
  amount: number,
  rules: ItemDiscountRule[]
): ResolvedItemDiscount | null {
  const rule = rules.find((r) => r.item_id === itemId) ?? (categoryId ? rules.find((r) => r.category_id === categoryId) : undefined);
  if (!rule) return null;

  const raw = rule.discount_type === "PERCENT" ? (amount * rule.discount_value) / 100 : baseQty * rule.discount_value;
  const discount_amount = Math.min(Math.round(raw * 100) / 100, amount);
  if (discount_amount <= 0) return null;
  return { discount_rule_id: rule.id, discount_amount };
}
