"use client";

import { isValidElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { MermaidDiagram } from "./mermaid-diagram";

function extractCodeInfo(children: ReactNode): { language?: string; text: string } | null {
  if (!isValidElement(children)) return null;
  const props = children.props as { className?: string; children?: ReactNode };
  const language = /language-(\w+)/.exec(props.className ?? "")?.[1];
  const raw = Array.isArray(props.children) ? props.children.join("") : props.children;
  const text = typeof raw === "string" ? raw.replace(/\n$/, "") : "";
  return { language, text };
}

const components: Components = {
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
};

export function MarkdownContent({ raw }: { raw: string }) {
  return (
    <div className="prose prose-slate max-w-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {raw}
      </ReactMarkdown>
    </div>
  );
}
