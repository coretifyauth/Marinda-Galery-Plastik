import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";

/** Resolve created_by (uuid FK ke auth.users) -> email, buat kolom "Dibuat Oleh" di tabel
 * transaksional (auth.users sendiri gak bisa di-query langsung dari client lewat PostgREST --
 * lewat view app_user_emails, migration 0048). */
export async function fetchUserEmails(userIds: (string | null | undefined)[]): Promise<Record<string, string>> {
  const ids = [...new Set(userIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return {};

  const { data, error } = await supabase.from("app_user_emails").select("user_id, email").in("user_id", ids);
  if (error) throw new Error(error.message);

  const map: Record<string, string> = {};
  for (const row of (data ?? []) as { user_id: string; email: string }[]) {
    map[row.user_id] = row.email;
  }
  return map;
}

export function useUserEmails(userIds: (string | null | undefined)[]) {
  const ids = [...new Set(userIds.filter((id): id is string => !!id))].sort();
  return useQuery({
    queryKey: ["app_user_emails", ids],
    queryFn: () => fetchUserEmails(ids),
    enabled: ids.length > 0,
    staleTime: 5 * 60_000,
  });
}
