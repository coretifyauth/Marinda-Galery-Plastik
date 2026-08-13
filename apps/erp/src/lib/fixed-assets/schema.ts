import { z } from "zod";

export const depreciationMethods = ["straight_line", "declining_balance"] as const;

export const createFixedAssetSchema = z
  .object({
    name: z.string().min(1, "Nama wajib diisi"),
    asset_account_id: z.string().uuid("Pilih akun Aset Tetap"),
    accumulated_depreciation_account_id: z.string().uuid("Pilih akun Akumulasi Penyusutan"),
    depreciation_expense_account_id: z.string().uuid("Pilih akun Beban Penyusutan"),
    acquisition_cost: z.coerce.number().positive("Nilai perolehan harus lebih dari 0"),
    salvage_value: z.coerce.number().min(0, "Nilai residu gak boleh negatif"),
    useful_life_months: z.coerce.number().int().positive("Umur manfaat harus lebih dari 0 bulan"),
    acquisition_date: z.string().min(1, "Tanggal akuisisi wajib diisi"),
    depreciation_method: z.enum(depreciationMethods),
    depreciation_rate: z.coerce.number().positive().max(1).optional(),
  })
  .refine((v) => v.salvage_value < v.acquisition_cost, {
    message: "Nilai residu harus lebih kecil dari nilai perolehan",
    path: ["salvage_value"],
  })
  .refine((v) => v.depreciation_method !== "declining_balance" || v.depreciation_rate !== undefined, {
    message: "Tarif penyusutan wajib diisi buat declining balance",
    path: ["depreciation_rate"],
  })
  .refine((v) => v.depreciation_method !== "straight_line" || v.depreciation_rate === undefined, {
    message: "Straight-line gak butuh tarif — kosongkan",
    path: ["depreciation_rate"],
  });

export type CreateFixedAssetInput = z.infer<typeof createFixedAssetSchema>;

export const postDepreciationSchema = z.object({
  fixed_asset_id: z.string().uuid("Pilih aset"),
  period: z.string().min(1, "Periode wajib diisi"),
  amount_override: z.coerce.number().positive().optional(),
});

export type PostDepreciationInput = z.infer<typeof postDepreciationSchema>;

export type FixedAsset = {
  id: string;
  name: string;
  asset_account_id: string;
  accumulated_depreciation_account_id: string;
  depreciation_expense_account_id: string;
  acquisition_cost: number;
  salvage_value: number;
  useful_life_months: number;
  acquisition_date: string;
  depreciation_method: (typeof depreciationMethods)[number];
  depreciation_rate: number | null;
  archived_at: string | null;
};

export type DepreciationEntry = {
  id: string;
  fixed_asset_id: string;
  period: string;
  amount: number;
  journal_entry_id: string;
  created_at: string;
};

export function accumulatedDepreciation(entries: DepreciationEntry[], assetId: string): number {
  return entries
    .filter((e) => e.fixed_asset_id === assetId)
    .reduce((sum, e) => sum + e.amount, 0);
}

export function bookValue(asset: FixedAsset, accumulated: number): number {
  return asset.acquisition_cost - accumulated;
}
