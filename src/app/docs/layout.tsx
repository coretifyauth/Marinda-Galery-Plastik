import type { ReactNode } from "react";
import { listAllDocs } from "@/lib/docs/fs";
import { DocsShell } from "@/components/docs/docs-shell";

export default async function DocsLayout({ children }: { children: ReactNode }) {
  const tree = await listAllDocs();
  return <DocsShell tree={tree}>{children}</DocsShell>;
}
