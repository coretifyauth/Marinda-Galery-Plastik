"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/sidebar";
import { Topbar } from "@/components/topbar";
import { AuthGuard } from "@/components/auth-guard";

export default function AppLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Tutup drawer mobile tiap ganti halaman, biar gak nyangkut kebuka nutupin konten baru.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  // /setup dirender tanpa chrome ERP biasa (sidebar/topbar) -- link-link di situ cuma
  // bakal mantul balik ke /setup selama onboarding belum selesai (lihat AuthGuard).
  if (pathname === "/setup") {
    return (
      <AuthGuard>
        <div className="flex min-h-screen flex-1 items-center justify-center overflow-y-auto bg-slate-100 p-6">
          {children}
        </div>
      </AuthGuard>
    );
  }

  return (
    <AuthGuard>
      <div className="flex h-screen flex-1 overflow-hidden bg-slate-100">
        <Sidebar open={mobileNavOpen} onClose={() => setMobileNavOpen(false)} />
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden md:pl-64">
          <Topbar onMenuClick={() => setMobileNavOpen(true)} />
          <main className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">{children}</main>
        </div>
      </div>
    </AuthGuard>
  );
}
