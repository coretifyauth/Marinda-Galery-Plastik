import { promises as fs } from "fs";
import path from "path";
import {
  DOC_CATEGORIES,
  isGroupedCategory,
  isValidCategory,
  type DocCategoryId,
  type DocModule,
  type DocSummary,
  type DocTreeCategory,
  type GroupedCategoryId,
} from "./categories";

// Server-only. Jangan diimpor dari Client Component ("use client") —
// modul ini (termasuk listAllDocs) narik Node "fs", yang gak bisa
// di-resolve di browser bundle. Konstanta & tipe yang aman diimpor
// dari client ada di categories.ts.

// apps/erp jadi 1 app di monorepo (apps/erp + apps/pos) -- docs/ tetap 1 folder
// bersama di root repo, bukan didup per-app, jadi naik 2 level dari process.cwd()
// (apps/erp) buat nyampe ke root. Lihat memory/architecture/app/tech-stack-decisions.md
// > "App Structure: Monorepo".
const DOCS_ROOT = path.join(process.cwd(), "..", "..", "docs");

// Label & urutan tampil modul tutorial -- diurutkan sesuai alur bisnis (Domain
// Roadmap di AGENTS.md), bukan alfabetis, biar Sidebar/landing kebaca sesuai
// proses kerja sebenarnya. Folder modul baru yang belum terdaftar di sini
// tetap muncul (fallback title-case dari nama folder), cuma nongol di
// belakang urutan yang udah didefinisikan -- nambah modul tutorial baru gak
// mewajibkan ubah kode ini, cuma nambah di sini kalau mau posisi/labelnya rapi.
const MODULE_LABELS: Record<string, string> = {
  "chart-of-accounts": "Chart of Accounts",
  "general-ledger": "General Ledger",
  "accounts-receivable": "Accounts Receivable",
  "accounts-payable": "Accounts Payable",
  inventory: "Inventory",
  "fixed-assets": "Fixed Assets",
  "financial-reports": "Financial Reports",
  pos: "POS",
  settings: "Settings",
  "lintas-modul": "Lintas Modul",
};
const MODULE_ORDER = Object.keys(MODULE_LABELS);

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

function moduleLabel(id: string): string {
  return MODULE_LABELS[id] ?? titleFromHeading("", id);
}

async function listDocsInDir(dir: string): Promise<DocSummary[]> {
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

export async function listDocs(category: DocCategoryId): Promise<DocSummary[]> {
  return listDocsInDir(path.join(DOCS_ROOT, category));
}

export async function listModules(category: GroupedCategoryId): Promise<DocModule[]> {
  const dir = path.join(DOCS_ROOT, category);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const moduleDirs = entries.filter((entry) => entry.isDirectory());

  const modules = await Promise.all(
    moduleDirs.map(async (entry) => ({
      id: entry.name,
      label: moduleLabel(entry.name),
      docs: await listDocsInDir(path.join(dir, entry.name)),
    }))
  );

  return modules.sort((a, b) => {
    const ai = MODULE_ORDER.indexOf(a.id);
    const bi = MODULE_ORDER.indexOf(b.id);
    if (ai === -1 && bi === -1) return a.label.localeCompare(b.label);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

export async function listAllDocs(): Promise<DocTreeCategory[]> {
  return Promise.all(
    DOC_CATEGORIES.map(async (c) => {
      if (isGroupedCategory(c.id)) {
        return { category: c.id, label: c.label, kind: "grouped" as const, modules: await listModules(c.id) };
      }
      return { category: c.id, label: c.label, kind: "flat" as const, docs: await listDocs(c.id) };
    })
  );
}

function readingMinutes(raw: string): number {
  const wordCount = raw.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(wordCount / 200));
}

type DocContent = { title: string; raw: string; modifiedAt: string; minutes: number };

async function readFileAt(fullPath: string, fallbackSlug: string): Promise<DocContent | null> {
  const resolvedDocsRoot = path.resolve(DOCS_ROOT) + path.sep;
  if (!path.resolve(fullPath).startsWith(resolvedDocsRoot)) return null;

  try {
    const [raw, stat] = await Promise.all([fs.readFile(fullPath, "utf8"), fs.stat(fullPath)]);
    return {
      title: titleFromHeading(raw, fallbackSlug),
      raw,
      modifiedAt: stat.mtime.toISOString(),
      minutes: readingMinutes(raw),
    };
  } catch {
    return null;
  }
}

/** Buat kategori flat (domain/architecture): docs/<category>/<slug>.md. */
export async function readDoc(category: string, slug: string): Promise<DocContent | null> {
  if (!isValidCategory(category) || isGroupedCategory(category) || !isValidSlug(slug)) return null;
  return readFileAt(path.join(DOCS_ROOT, category, `${slug}.md`), slug);
}

/** Buat kategori grouped (tutorial): docs/<category>/<module>/<slug>.md. */
export async function readModuleDoc(
  category: string,
  moduleId: string,
  slug: string
): Promise<DocContent | null> {
  if (!isValidCategory(category) || !isGroupedCategory(category)) return null;
  if (!isValidSlug(moduleId) || !isValidSlug(slug)) return null;
  return readFileAt(path.join(DOCS_ROOT, category, moduleId, `${slug}.md`), slug);
}
