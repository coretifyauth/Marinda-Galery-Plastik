"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpenCheck, ScrollText, BookOpenText } from "lucide-react";

const navItems = [
  { href: "/accounts", label: "Chart of Accounts", icon: BookOpenCheck },
  { href: "/journal-entries", label: "Journal Entries", icon: ScrollText },
  { href: "/general-ledger", label: "General Ledger", icon: BookOpenText },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-slate-200 bg-white">
      <div className="flex items-center gap-2 px-6 py-5">
        <span className="h-2.5 w-2.5 rounded-full bg-amber-500" />
        <span className="font-semibold text-black">Custom ERP</span>
      </div>
      <nav className="flex flex-col gap-1 px-3">
        {navItems.map(({ href, label, icon: Icon }) => {
          const active = pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-2.5 rounded-md border-l-2 px-3 py-2 text-sm ${
                active
                  ? "border-amber-500 bg-amber-50 font-medium text-amber-700"
                  : "border-transparent text-slate-600 hover:bg-slate-50"
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
