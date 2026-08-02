"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";

/**
 * Ekstrak dari pola getSession->redirect yang diulang di tiap page.tsx
 * (mis. accounts/page.tsx). Cuma dipakai halaman /docs — sengaja gak dipasang
 * balik ke page lama biar perubahan ini kescope kecil.
 */
export function useRequireAuth(): { checking: boolean } {
  const router = useRouter();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!active) return;
      if (!session) {
        router.replace("/login");
        return;
      }
      setChecking(false);
    });
    return () => {
      active = false;
    };
  }, [router]);

  return { checking };
}
