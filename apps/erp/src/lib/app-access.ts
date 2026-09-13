import { supabase } from "@/lib/supabase/client";

// Kebijakan "1 akun 1 role" (2026-09-13) juga jadi gate akses APLIKASI: role sekarang
// nentuin aplikasi mana yang boleh dipakai, bukan cuma boleh-ngapain-aja di dalamnya.
// cashier gak boleh masuk ERP (aplikasi kasir sendiri ada di apps/pos) -- master boleh
// ke mana-mana karena selalu pegang role admin+cashier sekaligus (lihat
// docs/architecture/coa-schema.md submodule "Registrasi & Manajemen User").
export const ERP_ALLOWED_ROLES = ["admin", "master"];

export async function hasErpAccess(userId: string): Promise<boolean> {
  const { data } = await supabase.from("user_roles").select("role_name").eq("user_id", userId);
  const roles = ((data ?? []) as { role_name: string }[]).map((r) => r.role_name);
  return roles.some((r) => ERP_ALLOWED_ROLES.includes(r));
}
