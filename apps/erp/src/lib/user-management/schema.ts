export const ASSIGNABLE_ROLES = ["admin", "cashier"] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export const roleLabel: Record<string, string> = {
  master: "Master",
  admin: "Admin",
  cashier: "Kasir",
};

export type AppUser = {
  user_id: string;
  email: string;
  roles: string[];
  user_created_at: string;
};

export type WhitelistEntry = {
  id: string;
  email: string;
  created_by: string;
  created_at: string;
  consumed_at: string | null;
  roles: string[];
};
