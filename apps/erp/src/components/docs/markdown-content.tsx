"use client";

import { isValidElement, type ReactNode } from "react";
import Link from "next/link";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { DocCategoryId } from "@/lib/docs/categories";
import { MermaidDiagram } from "./mermaid-diagram";

function extractCodeInfo(children: ReactNode): { language?: string; text: string } | null {
  if (!isValidElement(children)) return null;
  const props = children.props as { className?: string; children?: ReactNode };
  const language = /language-(\w+)/.exec(props.className ?? "")?.[1];
  const raw = Array.isArray(props.children) ? props.children.join("") : props.children;
  const text = typeof raw === "string" ? raw.replace(/\n$/, "") : "";
  return { language, text };
}

// Cross-reference antar dokumen ditulis sebagai link markdown relatif —
// bukan `docs/xxx.md` dalam backtick kayak docs/domain & docs/architecture,
// karena tutorial memang didesain buat diklik-jelajah, bukan cuma dibaca.
// Dua pola (persis relative path filesystem asli, biar tetap valid kalau
// filenya dibuka langsung/di GitHub):
//   - `[x.md](x.md)`              -> dokumen lain di modul yang sama
//   - `[x.md](../modul-lain/x.md)` -> dokumen di modul lain (lihat docs/tutorial/*/*.md)
// react-markdown gak tau routing Next.js, jadi href relatif ini perlu
// diresolve manual ke /docs/<category>[/<module>]/<slug>.
function resolveDocHref(href: string, category: DocCategoryId, moduleId?: string): string | null {
  const sameDir = /^([a-z0-9-]+)\.md$/.exec(href);
  if (sameDir) {
    return moduleId ? `/docs/${category}/${moduleId}/${sameDir[1]}` : `/docs/${category}/${sameDir[1]}`;
  }
  const otherModule = /^\.\.\/([a-z0-9-]+)\/([a-z0-9-]+)\.md$/.exec(href);
  if (otherModule && moduleId) {
    return `/docs/${category}/${otherModule[1]}/${otherModule[2]}`;
  }
  return null;
}

function makeComponents(category: DocCategoryId, moduleId?: string): Components {
  return {
    pre({ children }) {
      const info = extractCodeInfo(children);
      if (info?.language === "mermaid") {
        return <MermaidDiagram chart={info.text} />;
      }
      return <pre>{children}</pre>;
    },
    // Tabel lebar (kolom banyak/teks panjang) scroll sendiri secara horizontal,
    // gak boleh maksa lebar seluruh halaman ikut melebar (root cause kenapa
    // reading pane pernah kelihatan gak center — main jadi lebih lebar dari
    // viewport begitu ada tabel lebar, lihat min-w-0 di docs-shell.tsx).
    table({ children }) {
      return (
        <div className="overflow-x-auto">
          <table>{children}</table>
        </div>
      );
    },
    a({ href, children }) {
      const resolved = href ? resolveDocHref(href, category, moduleId) : null;
      if (resolved) {
        return <Link href={resolved}>{children}</Link>;
      }
      return (
        <a href={href} target={href?.startsWith("http") ? "_blank" : undefined} rel="noreferrer">
          {children}
        </a>
      );
    },
  };
}

export function MarkdownContent({
  raw,
  category,
  moduleId,
}: {
  raw: string;
  category: DocCategoryId;
  /** Cuma diisi buat kategori grouped (tutorial) — dipakai resolve link relatif antar-modul. */
  moduleId?: string;
}) {
  return (
    <div className="prose prose-slate max-w-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={makeComponents(category, moduleId)}>
        {raw}
      </ReactMarkdown>
    </div>
  );
}
