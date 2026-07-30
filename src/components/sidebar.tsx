"use client";

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
} from "lucide-react";

const navItems = [
  { href: "/accounts", label: "Chart of Accounts", icon: BookOpenCheck },
  { href: "/journal-entries", label: "Journal Entries", icon: ScrollText },
  { href: "/general-ledger", label: "General Ledger", icon: BookOpenText },
  { href: "/customers", label: "Customers", icon: Users },
  { href: "/ar-invoices", label: "AR Invoices", icon: FileText },
  { href: "/ar-payments", label: "AR Payments", icon: HandCoins },
  { href: "/suppliers", label: "Suppliers", icon: Truck },
  { href: "/ap-bills", label: "AP Bills", icon: Receipt },
  { href: "/ap-payments", label: "AP Payments", icon: Banknote },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-slate-200 bg-white">
      <div className="flex items-center gap-2 px-4 py-4">
        <span className="h-2.5 w-2.5 rounded-full bg-blue-600" />
        <span className="font-semibold text-black">Custom ERP</span>
      </div>
      <nav className="flex flex-col gap-0.5 px-2">
        {navItems.map(({ href, label, icon: Icon }) => {
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
      </nav>
    </aside>
  );
}
