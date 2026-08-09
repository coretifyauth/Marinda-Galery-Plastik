"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { Bell, BookOpen, ChevronDown } from "lucide-react";
import { supabase } from "@/lib/supabase/client";

const routeLabels: Record<string, string> = {
  "/accounts": "Chart of Accounts",
  "/journal-entries": "Journal Entries",
  "/general-ledger": "General Ledger",
  "/customers": "Customers",
  "/ar-invoices": "AR Invoices",
  "/ar-payments": "AR Payments",
  "/ar-deposits": "AR Deposits",
  "/ar-return-credits": "AR Return Credit",
  "/suppliers": "Suppliers",
  "/ap-bills": "AP Bills",
  "/ap-payments": "AP Payments",
  "/ap-deposits": "AP Deposits",
  "/ap-return-credits": "AP Return Credit",
  "/items": "Items",
  "/inventory": "Stock Position",
  "/purchase-orders": "Purchase Orders",
  "/goods-receipts": "Goods Receipts",
  "/bom": "BOM",
  "/production-orders": "Production Orders",
  "/goods-issues": "Goods Issues",
  "/stock-opnames": "Stock Opname",
  "/fixed-assets": "Fixed Assets",
};

function getBreadcrumb(pathname: string): string[] {
  if (routeLabels[pathname]) {
    return [routeLabels[pathname]];
  }
  // Rute detail (mis. /accounts/[id]) -> cocokkan prefix listnya, tambah "Detail".
  const prefix = Object.keys(routeLabels).find(
    (route) => pathname.startsWith(route + "/") && pathname !== route
  );
  if (prefix) {
    return [routeLabels[prefix], "Detail"];
  }
  return [pathname];
}

export function Topbar() {
  const router = useRouter();
  const pathname = usePathname();
  const breadcrumb = getBreadcrumb(pathname);
  const [email, setEmail] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setEmail(session?.user.email ?? null);
    });
  }, []);

  async function handleLogout() {
    await supabase.auth.signOut();
    router.replace("/login");
  }

  return (
    <header className="flex h-12 items-center justify-between border-b border-slate-200 bg-white px-4">
      <nav className="text-sm text-slate-500">
        {breadcrumb.map((crumb, i) => (
          <span key={crumb}>
            {i > 0 && <span className="mx-1.5">/</span>}
            <span className={i === breadcrumb.length - 1 ? "text-black" : ""}>{crumb}</span>
          </span>
        ))}
      </nav>
      <div className="relative flex items-center gap-4">
        <Link href="/docs" title="Documentation" className="flex items-center text-slate-400 hover:text-slate-600">
          <BookOpen className="h-4.5 w-4.5" />
        </Link>
        <Bell className="h-4.5 w-4.5 text-slate-400" />
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className="flex items-center gap-2 rounded-full text-sm"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-600 text-sm font-medium text-white">
            {email ? email[0].toUpperCase() : "?"}
          </span>
          <span className="hidden max-w-[10rem] truncate text-slate-700 sm:inline">{email}</span>
          <ChevronDown className="h-4 w-4 text-slate-400" />
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-full mt-2 w-40 rounded-md border border-slate-200 bg-white py-1 shadow-lg">
            <button
              onClick={handleLogout}
              className="w-full px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
            >
              Keluar
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
