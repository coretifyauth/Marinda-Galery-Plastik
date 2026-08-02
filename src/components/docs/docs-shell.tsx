"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useRequireAuth } from "@/lib/auth/use-require-auth";
import type { DocTreeCategory } from "@/lib/docs/categories";
import { DocExplorer } from "./doc-explorer";

export function DocsShell({
  tree,
  children,
}: {
  tree: DocTreeCategory[];
  children: ReactNode;
}) {
  // Satu-satunya auth gate untuk seluruh /docs — dipindah ke sini dari
  // tiap page.tsx biar gak triplikat. Catatan: page.tsx di bawah pohon ini
  // tetap baca file lewat fs server-side terlepas dari state `checking` di
  // sini (itu emang cara kerja Server Component, gak nunggu client) — bukan
  // celah keamanan, karena kontennya cuma dokumen markdown non-sensitif,
  // sama persis pola client-redirect yang dipakai semua halaman ERP lain.
  const { checking } = useRequireAuth();

  return (
    <div className="mx-auto flex h-screen max-w-6xl overflow-hidden bg-white">
      <aside className="flex h-screen w-64 shrink-0 flex-col overflow-y-auto border-r border-slate-200 bg-white">
        <div className="flex flex-col gap-3 px-4 py-4">
          <Link
            href="/accounts"
            className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-600"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Kembali ke ERP
          </Link>
          <Link href="/docs" className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-blue-600" />
            <span className="text-base font-bold text-black">Documentation</span>
          </Link>
        </div>
        <DocExplorer tree={tree} />
      </aside>

      <main className="h-screen min-w-0 flex-1 overflow-y-auto bg-white">
        {checking ? <p className="p-8 text-sm text-slate-500">Memuat...</p> : children}
      </main>
    </div>
  );
}
