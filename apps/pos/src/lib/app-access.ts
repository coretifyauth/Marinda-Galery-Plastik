import { supabase } from "@/lib/supabase/client";

// Kebijakan "1 akun 1 role" (2026-09-13) juga jadi gate akses APLIKASI: admin gak boleh
// masuk POS (aplikasi ERP-nya sendiri ada di apps/erp) -- master boleh ke mana-mana
// karena selalu pegang role admin+cashier sekaligus. Padanan di apps/erp:
// apps/erp/src/lib/app-access.ts.
export const POS_ALLOWED_ROLES = ["cashier", "master"];

export async function hasPosAccess(userId: string): Promise<boolean> {
  const { data } = await supabase.from("user_roles").select("role_name").eq("user_id", userId);
  const roles = ((data ?? []) as { role_name: string }[]).map((r) => r.role_name);
  return roles.some((r) => POS_ALLOWED_ROLES.includes(r));
}
