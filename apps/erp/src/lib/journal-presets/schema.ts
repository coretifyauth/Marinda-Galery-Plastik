import { z } from "zod";

export const presetStatuses = ["draft", "active", "inactive"] as const;
export type PresetStatus = (typeof presetStatuses)[number];

export const presetSides = ["debit", "credit"] as const;
export type PresetSide = (typeof presetSides)[number];

export const presetLineInputSchema = z.object({
  account_id: z.string().uuid("Pilih akun"),
  side: z.enum(presetSides),
  label: z.string().optional(),
});

export const createPresetSchema = z.object({
  label: z.string().min(1, "Nama preset wajib diisi"),
  lines: z.array(presetLineInputSchema).min(2, "Minimal 2 baris"),
});

export type CreatePresetInput = z.infer<typeof createPresetSchema>;

export type PresetLine = {
  id: string;
  preset_id: string;
  account_id: string;
  side: PresetSide;
  label: string | null;
  sort_order: number;
  accounts: { code: string; name: string };
};

export type Preset = {
  id: string;
  label: string;
  status: PresetStatus;
  created_at: string;
  activated_at: string | null;
  app_preset_journal_entry_lines: PresetLine[];
};
