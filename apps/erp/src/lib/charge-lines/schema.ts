import { z } from "zod";
import type { ResolvedAccount } from "@/lib/default-accounts/schema";

/** Baris kategori dikirim ke RPC (create_transaction/create_pos_sale) — akun sudah
 * diresolusi dari pilihan katalog di UI, bukan diketik bebas (memory/scope-debt/compound-transactional-entries.md). */
export const chargeLineSchema = z.object({
  account_id: z.string().uuid(),
  amount: z.coerce.number().positive("Nominal harus lebih dari 0"),
});

export type ChargeLine = z.infer<typeof chargeLineSchema>;

/** State form mentah sebelum di-resolve — `category_id` menunjuk baris katalog (pos_charge_types/
 * ar_invoice_charge_types/ap_bill_expense_categories), `account_id` diambil dari situ pas submit. */
export type ChargeLineInput = { category_id: string; amount: string };

export function emptyChargeLine(): ChargeLineInput {
  return { category_id: "", amount: "" };
}

export type ChargeType = { id: string; name: string; account_id: string; archived_at: string | null };

/** Resolve ChargeLineInput (pilihan katalog) -> ChargeLine (account_id+amount) buat dikirim ke RPC. */
export function resolveChargeLines(lines: ChargeLineInput[], chargeTypes: ChargeType[]): ChargeLine[] {
  return lines
    .filter((l) => l.category_id.trim() !== "" && l.amount.trim() !== "")
    .map((l) => {
      const type = chargeTypes.find((c) => c.id === l.category_id);
      return { account_id: type?.account_id ?? "", amount: Number(l.amount) };
    });
}

/** Varian ChargeType yang udah di-join ke accounts(code,name) -- semua query katalog kategori
 * di app ini (ap_bill_expense_categories/ar_invoice_charge_types/dst) udah select bentuk ini. */
export type ChargeCategoryWithAccount = ChargeType & { accounts: { code: string; name: string } };

export type ChargeLeg = { label: string; resolved: ResolvedAccount | undefined; side: "debit" | "credit" };

/** Resolve 1 category_id -> leg buat <JournalPreviewPanel> (label = nama kategori, bukan nama
 * akun -- kategori yang user pilih, akun cuma detail teknisnya). Dipakai buat kategori WAJIB
 * (mis. "Kategori Persediaan/Beban" di AP Bill) yang gak lewat ChargeLinesEditor. */
export function resolveCategoryLeg(
  categoryId: string,
  categories: ChargeCategoryWithAccount[],
  side: "debit" | "credit"
): ChargeLeg | undefined {
  if (!categoryId) return undefined;
  const cat = categories.find((c) => c.id === categoryId);
  if (!cat) return undefined;
  return {
    label: `${cat.name} (${side === "debit" ? "debit" : "kredit"})`,
    resolved: { id: cat.account_id, code: cat.accounts.code, name: cat.accounts.name },
    side,
  };
}

/** Sama kayak resolveChargeLines tapi buat <JournalPreviewPanel> -- 1 leg per baris
 * ChargeLinesEditor yang udah keisi (kategori + nominal), dinamis sesuai jumlah baris. */
export function resolveChargeLineLegs(
  lines: ChargeLineInput[],
  categories: ChargeCategoryWithAccount[],
  side: "debit" | "credit"
): ChargeLeg[] {
  return lines
    .filter((l) => l.category_id.trim() !== "" && l.amount.trim() !== "")
    .map((l) => resolveCategoryLeg(l.category_id, categories, side))
    .filter((leg): leg is ChargeLeg => !!leg);
}
