"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, Search } from "lucide-react";
import type { DocCategoryId, DocTreeCategory } from "@/lib/docs/categories";

export function DocExplorer({ tree }: { tree: DocTreeCategory[] }) {
  const pathname = usePathname();
  const [query, setQuery] = useState("");
  const [explorerOpen, setExplorerOpen] = useState(true);
  // Kebalikan dari sidebar.tsx: set ini nyimpen kategori yang di-COLLAPSE,
  // mulai kosong biar semua kategori default EXPANDED (beda dari sidebar app
  // yang default collapsed — di sini tujuan utamanya emang browsing ~20 doc).
  const [collapsed, setCollapsed] = useState<Set<DocCategoryId>>(() => new Set());

  function toggleCategory(id: DocCategoryId) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  // Filter ringan client-side (judul yang udah di-load, bukan full-text search
  // ke isi dokumen) — kategori tanpa hasil match otomatis disembunyikan.
  const filteredTree = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tree;
    return tree
      .map((category) => ({
        ...category,
        docs: category.docs.filter((doc) => doc.title.toLowerCase().includes(q)),
      }))
      .filter((category) => category.docs.length > 0);
  }, [tree, query]);

  return (
    <div className="flex flex-col gap-3 px-4 pb-4">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Cari dokumen..."
          className="w-full rounded-md border border-slate-200 bg-slate-50 py-1.5 pl-8 pr-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-slate-300 focus:bg-white focus:outline-none"
        />
      </div>

      <button
        type="button"
        onClick={() => setExplorerOpen((v) => !v)}
        className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-slate-400 hover:text-slate-600"
      >
        Explorer
        <ChevronDown
          className={`h-3.5 w-3.5 transition-transform ${explorerOpen ? "" : "-rotate-90"}`}
        />
      </button>

      {explorerOpen && (
        <nav className="flex flex-col gap-1">
          {filteredTree.map((category) => {
            const isCollapsed = collapsed.has(category.category) && !query;
            return (
              <div key={category.category} className="flex flex-col gap-0.5">
                <button
                  type="button"
                  onClick={() => toggleCategory(category.category)}
                  className="flex items-center gap-1 rounded-md py-1 pl-1 text-sm font-medium text-slate-700 hover:text-blue-700"
                >
                  <ChevronDown
                    className={`h-3.5 w-3.5 shrink-0 transition-transform ${
                      isCollapsed ? "-rotate-90" : ""
                    }`}
                  />
                  {category.label}
                </button>
                {!isCollapsed &&
                  category.docs.map((doc) => {
                    const href = `/docs/${category.category}/${doc.slug}`;
                    const active = pathname === href;
                    return (
                      <Link
                        key={doc.slug}
                        href={href}
                        className={`truncate rounded-md py-1 pl-6 pr-2 text-sm ${
                          active
                            ? "bg-slate-100 font-medium text-blue-700"
                            : "text-slate-600 hover:bg-slate-50 hover:text-blue-700"
                        }`}
                      >
                        {doc.title}
                      </Link>
                    );
                  })}
              </div>
            );
          })}
        </nav>
      )}
    </div>
  );
}
