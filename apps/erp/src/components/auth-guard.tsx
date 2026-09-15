"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { hasErpAccess } from "@/lib/app-access";
import { LoadingScreen } from "@/components/ui/loading-screen";

const SETUP_PATH = "/setup";

// Safety net di level layout (2026-09-13) -- gak cuma nge-gate lewat form /login.
// Session bisa juga kebentuk lewat magic link (invite/reset password) yang mendarat
// LANGSUNG di halaman manapun tanpa pernah lewat handleSubmit /login -- kejadian nyata:
// user terima undangan, klik link, auto-login ke halaman ini tanpa pernah set password
// ATAU kena cek role sama sekali. Guard ini jalan sekali di root (app) layout, nutup
// celah itu buat SEMUA route di bawahnya, bukan cuma titik masuk /login.
export function AuthGuard({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
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

      // Gate onboarding (2026-09-15, lihat docs/domain/chart-of-accounts.md submodule
      // "Onboarding / Setup Awal"): app_settings kosong = COA + config wajib belum ada,
      // hampir semua RPC transaksi bakal gagal kalau dipakai dalam kondisi ini. Semua yang
      // lolos hasErpAccess di atas sudah pasti admin/master (lihat ERP_ALLOWED_ROLES), jadi
      // gak perlu cabang "bukan admin" terpisah -- yang lolos ke sini pasti boleh /setup.
      const { count } = await supabase
        .from("app_settings")
        .select("id", { count: "exact", head: true });
      if (!active) return;
      const onboarded = (count ?? 0) > 0;
      if (!onboarded && pathname !== SETUP_PATH) {
        router.replace(SETUP_PATH);
        return;
      }
      if (onboarded && pathname === SETUP_PATH) {
        router.replace("/");
        return;
      }

      setChecking(false);
    });
    return () => {
      active = false;
    };
  }, [router, pathname]);

  if (checking) {
    return <LoadingScreen />;
  }

  return <>{children}</>;
}
