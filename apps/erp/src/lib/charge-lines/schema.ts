import { z } from "zod";

/** Baris kategori dikirim ke RPC (create_ap_bill/create_ar_invoice/create_pos_sale) — akun sudah
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
