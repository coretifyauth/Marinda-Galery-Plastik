"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BookOpenCheck,
  ScrollText,
  BookOpenText,
  Users,
  FileText,
  HandCoins,
  Truck,
  Receipt,
  Banknote,
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
} from "lucide-react";

const navGroups = [
  {
    label: "Accounting",
    icon: Calculator,
    items: [
      { href: "/accounts", label: "Chart of Accounts", icon: BookOpenCheck },
      { href: "/journal-entries", label: "Journal Entries", icon: ScrollText },
      { href: "/general-ledger", label: "General Ledger", icon: BookOpenText },
    ],
  },
  {
    label: "Accounts Receivable",
    icon: Wallet,
    items: [
      { href: "/customers", label: "Customers", icon: Users },
      { href: "/ar-invoices", label: "AR Invoices", icon: FileText },
      { href: "/ar-payments", label: "AR Payments", icon: HandCoins },
    ],
  },
  {
    label: "Accounts Payable",
    icon: CreditCard,
    items: [
      { href: "/suppliers", label: "Suppliers", icon: Truck },
      { href: "/ap-bills", label: "AP Bills", icon: Receipt },
      { href: "/ap-payments", label: "AP Payments", icon: Banknote },
    ],
  },
  {
    label: "Inventory",
    icon: Boxes,
    items: [
      { href: "/items", label: "Items", icon: Package },
      { href: "/inventory", label: "Stock Position", icon: Warehouse },
      { href: "/purchase-orders", label: "Purchase Orders", icon: ClipboardList },
      { href: "/goods-receipts", label: "Goods Receipts", icon: PackageCheck },
      { href: "/bom", label: "BOM", icon: FlaskConical },
      { href: "/production-orders", label: "Production Orders", icon: Factory },
      { href: "/goods-issues", label: "Goods Issues", icon: PackageMinus },
    ],
  },
  {
    label: "Fixed Assets",
    icon: Building2,
    items: [{ href: "/fixed-assets", label: "Fixed Assets", icon: Building2 }],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(navGroups.map((g) => g.label))
  );

  function toggleGroup(label: string) {
    setCollapsed((prev) => {
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
    <aside className="flex w-56 shrink-0 flex-col border-r border-slate-200 bg-white">
      <div className="flex items-center gap-2 px-4 py-4">
        <span className="h-2.5 w-2.5 rounded-full bg-blue-600" />
        <span className="font-semibold text-black">Custom ERP</span>
      </div>
      <nav className="flex flex-col gap-1 px-2 pb-4">
        {navGroups.map((group) => {
          const isCollapsed = collapsed.has(group.label);
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
                  className={`h-3.5 w-3.5 transition-transform ${isCollapsed ? "-rotate-90" : ""}`}
                />
              </button>
              {!isCollapsed &&
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
    </aside>
  );
}
