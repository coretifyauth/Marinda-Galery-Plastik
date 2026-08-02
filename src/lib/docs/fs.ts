import { promises as fs } from "fs";
import path from "path";
import {
  DOC_CATEGORIES,
  isValidCategory,
  type DocCategoryId,
  type DocSummary,
  type DocTreeCategory,
} from "./categories";

// Server-only. Jangan diimpor dari Client Component ("use client") —
// modul ini (termasuk listAllDocs) narik Node "fs", yang gak bisa
// di-resolve di browser bundle. Konstanta & tipe yang aman diimpor
// dari client ada di categories.ts.

const DOCS_ROOT = path.join(process.cwd(), "docs");

export function isValidSlug(value: string): boolean {
  return /^[a-z0-9-]+$/.test(value);
}

function titleFromHeading(raw: string, fallbackSlug: string): string {
  const match = raw.match(/^#\s+(.+)$/m);
  if (match) return match[1].trim();
  return fallbackSlug
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export async function listDocs(category: DocCategoryId): Promise<DocSummary[]> {
  const dir = path.join(DOCS_ROOT, category);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md"));

  const docs = await Promise.all(
    files.map(async (entry) => {
      const slug = entry.name.replace(/\.md$/, "");
      const raw = await fs.readFile(path.join(dir, entry.name), "utf8");
      return { slug, title: titleFromHeading(raw, slug) };
    })
  );

  return docs.sort((a, b) => a.title.localeCompare(b.title));
}

export async function listAllDocs(): Promise<DocTreeCategory[]> {
  return Promise.all(
    DOC_CATEGORIES.map(async (c) => ({
      category: c.id,
      label: c.label,
      docs: await listDocs(c.id),
    }))
  );
}

function readingMinutes(raw: string): number {
  const wordCount = raw.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(wordCount / 200));
}

export async function readDoc(
  category: string,
  slug: string
): Promise<{ title: string; raw: string; modifiedAt: string; minutes: number } | null> {
  if (!isValidCategory(category) || !isValidSlug(slug)) return null;

  const fullPath = path.join(DOCS_ROOT, category, `${slug}.md`);
  const resolvedDocsRoot = path.resolve(DOCS_ROOT) + path.sep;
  if (!path.resolve(fullPath).startsWith(resolvedDocsRoot)) return null;

  try {
    const [raw, stat] = await Promise.all([fs.readFile(fullPath, "utf8"), fs.stat(fullPath)]);
    return {
      title: titleFromHeading(raw, slug),
      raw,
      modifiedAt: stat.mtime.toISOString(),
      minutes: readingMinutes(raw),
    };
  } catch {
    return null;
  }
}
