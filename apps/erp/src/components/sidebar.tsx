"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BookOpenCheck,
  ScrollText,
  BookOpenText,
  Users,
  FileText,
  Truck,
  Receipt,
  Package,
  ClipboardList,
  PackageCheck,
  FlaskConical,
  Factory,
  PackageMinus,
  Warehouse,
  ChevronDown,
  Calculator,
  Wallet,
  CreditCard,
  Boxes,
  Building2,
  Scale,
  TrendingUp,
  Landmark,
  Waves,
  Lock,
  PiggyBank,
  ClipboardCheck,
  ShoppingCart,
  NotebookPen,
  Cog,
  Store,
  Settings,
} from "lucide-react";

const navGroups = [
  {
    label: "Accounting",
    icon: Calculator,
    items: [
      { href: "/accounts", label: "Chart of Accounts", icon: BookOpenCheck },
      { href: "/journal-entries", label: "Journal Entries", icon: ScrollText },
      { href: "/general-ledger", label: "General Ledger", icon: BookOpenText },
      { href: "/fixed-assets", label: "Fixed Assets", icon: Building2 },
      { href: "/reports/trial-balance", label: "Trial Balance", icon: Scale },
      { href: "/reports/income-statement", label: "Income Statement", icon: TrendingUp },
      { href: "/reports/balance-sheet", label: "Balance Sheet", icon: Landmark },
      { href: "/reports/cash-flow", label: "Cash Flow", icon: Waves },
      { href: "/reports/period-closing", label: "Tutup Buku", icon: Lock },
    ],
  },
  {
    label: "Accounts Receivable",
    icon: Wallet,
    items: [
      { href: "/customers", label: "Customers", icon: Users },
      { href: "/ar-invoices", label: "AR Invoices", icon: FileText },
      { href: "/ar-deposits", label: "AR Deposits", icon: PiggyBank },
    ],
  },
  {
    label: "Accounts Payable",
    icon: CreditCard,
    items: [
      { href: "/suppliers", label: "Suppliers", icon: Truck },
      { href: "/ap-bills", label: "AP Bills", icon: Receipt },
      { href: "/ap-deposits", label: "AP Deposits", icon: PiggyBank },
    ],
  },
  {
    label: "Purchasing",
    icon: Truck,
    items: [
      { href: "/purchase-orders", label: "Purchase Orders", icon: ClipboardList },
      { href: "/goods-receipts", label: "Goods Receipts", icon: PackageCheck },
    ],
  },
  {
    label: "Manufacturing",
    icon: Cog,
    items: [
      { href: "/bom", label: "BOM", icon: FlaskConical },
      { href: "/production-orders", label: "Production Orders", icon: Factory },
    ],
  },
  {
    label: "Sales Fulfillment",
    icon: Store,
    items: [
      { href: "/sales-orders", label: "Sales Orders", icon: NotebookPen },
      { href: "/goods-issues", label: "Goods Issues", icon: PackageMinus },
      { href: "/pos-sales", label: "POS Sales", icon: ShoppingCart },
    ],
  },
  {
    label: "Inventory",
    icon: Boxes,
    items: [
      { href: "/items", label: "Items", icon: Package },
      { href: "/inventory", label: "Stock Position", icon: Warehouse },
      { href: "/stock-opnames", label: "Stock Opname", icon: ClipboardCheck },
    ],
  },
];

function activeGroupLabel(pathname: string): string | null {
  const group = navGroups.find((g) => g.items.some((item) => pathname.startsWith(item.href)));
  return group?.label ?? null;
}

export function Sidebar() {
  const pathname = usePathname();
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => {
    const active = activeGroupLabel(pathname);
    return active ? new Set([active]) : new Set();
  });

  useEffect(() => {
    const active = activeGroupLabel(pathname);
    if (!active) return;
    setOpenGroups((prev) => (prev.has(active) ? prev : new Set(prev).add(active)));
  }, [pathname]);

  function toggleGroup(label: string) {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(label)) {
        next.delete(label);
      } else {
        next.add(label);
      }
      return next;
    });
  }

  return (
    <aside className="fixed inset-y-0 left-0 z-20 flex h-screen w-64 shrink-0 flex-col border-r border-slate-200 bg-white">
      <div className="flex items-center gap-2 px-4 py-4">
        <span className="h-2.5 w-2.5 rounded-full bg-blue-600" />
        <span className="font-semibold text-black">Custom ERP</span>
      </div>
      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-2 pb-4">
        {navGroups.map((group) => {
          const isOpen = openGroups.has(group.label);
          const GroupIcon = group.icon;
          return (
            <div key={group.label} className="flex flex-col gap-0.5">
              <button
                type="button"
                onClick={() => toggleGroup(group.label)}
                className="flex items-center justify-between rounded-md px-2.5 py-1 text-xs font-medium uppercase tracking-wide text-slate-400 hover:bg-slate-50 hover:text-slate-600"
              >
                <span className="flex items-center gap-1.5">
                  <GroupIcon className="h-3.5 w-3.5" />
                  {group.label}
                </span>
                <ChevronDown
                  className={`h-3.5 w-3.5 transition-transform ${isOpen ? "" : "-rotate-90"}`}
                />
              </button>
              {isOpen &&
                group.items.map(({ href, label, icon: Icon }) => {
                  const active = pathname.startsWith(href);
                  return (
                    <Link
                      key={href}
                      href={href}
                      className={`flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm ${
                        active
                          ? "bg-slate-100 font-medium text-blue-700"
                          : "text-slate-600 hover:bg-slate-50"
                      }`}
                    >
                      <Icon className="h-4 w-4" />
                      {label}
                    </Link>
                  );
                })}
            </div>
          );
        })}
      </nav>
      <div className="shrink-0 border-t border-slate-200 px-2 py-2">
        <Link
          href="/settings/charges"
          className={`flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm ${
            pathname.startsWith("/settings")
              ? "bg-slate-100 font-medium text-blue-700"
              : "text-slate-600 hover:bg-slate-50"
          }`}
        >
          <Settings className="h-4 w-4" />
          Settings
        </Link>
      </div>
    </aside>
  );
}
