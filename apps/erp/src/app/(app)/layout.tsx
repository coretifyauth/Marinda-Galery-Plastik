"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/sidebar";
import { Topbar } from "@/components/topbar";
import { AuthGuard } from "@/components/auth-guard";

export default function AppLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();

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
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden pl-64">
          <Topbar />
          <main className="min-h-0 flex-1 overflow-y-auto p-6">{children}</main>
        </div>
      </div>
    </AuthGuard>
  );
}
