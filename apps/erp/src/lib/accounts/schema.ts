import { z } from "zod";

export const accountCategories = [
  "asset",
  "liability",
  "equity",
  "revenue",
  "expense",
] as const;

export const createAccountSchema = z.object({
  name: z.string().min(1, "Nama wajib diisi"),
  category: z.enum(accountCategories),
  parent_id: z.string().uuid().nullable().optional(),
});

export type CreateAccountInput = z.infer<typeof createAccountSchema>;

export type Account = {
  id: string;
  code: string;
  name: string;
  category: (typeof accountCategories)[number];
  normal_balance: "debit" | "credit";
  is_contra: boolean;
  parent_id: string | null;
  archived_at: string | null;
  created_by?: string | null;
  created_at?: string;
};

/** Cuma leaf account (gak punya child) yang boleh diposting — ref journal-entry-schema.md. */
export function getLeafAccounts(accounts: Account[]): Account[] {
  const parentIds = new Set(accounts.map((a) => a.parent_id).filter(Boolean));
  return accounts.filter((a) => !parentIds.has(a.id));
}
