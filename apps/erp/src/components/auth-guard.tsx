"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { hasErpAccess } from "@/lib/app-access";
import { LoadingScreen } from "@/components/ui/loading-screen";

// Safety net di level layout (2026-09-13) -- gak cuma nge-gate lewat form /login.
// Session bisa juga kebentuk lewat magic link (invite/reset password) yang mendarat
// LANGSUNG di halaman manapun tanpa pernah lewat handleSubmit /login -- kejadian nyata:
// user terima undangan, klik link, auto-login ke halaman ini tanpa pernah set password
// ATAU kena cek role sama sekali. Guard ini jalan sekali di root (app) layout, nutup
// celah itu buat SEMUA route di bawahnya, bukan cuma titik masuk /login.
export function AuthGuard({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) {
        router.replace("/login");
        return;
      }
      const allowed = await hasErpAccess(session.user.id);
      if (!active) return;
      if (!allowed) {
        await supabase.auth.signOut();
        router.replace("/login");
        return;
      }
      setChecking(false);
    });
    return () => {
      active = false;
    };
  }, [router]);

  if (checking) {
    return <LoadingScreen />;
  }

  return <>{children}</>;
}
