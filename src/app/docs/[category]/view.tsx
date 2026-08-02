import Link from "next/link";
import type { DocCategoryId, DocSummary } from "@/lib/docs/categories";

export function DocsCategoryView({
  category,
  label,
  docs,
}: {
  category: DocCategoryId;
  label: string;
  docs: DocSummary[];
}) {
  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <nav className="mb-3 flex items-center gap-1.5 text-xs text-slate-400">
        <Link href="/docs" className="hover:text-slate-600">
          Documentation
        </Link>
      </nav>
      <h1 className="mb-6 text-2xl font-semibold text-black">{label}</h1>
      <ul className="flex flex-col gap-1">
        {docs.map((doc) => (
          <li key={doc.slug}>
            <Link
              href={`/docs/${category}/${doc.slug}`}
              className="block rounded-md px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 hover:text-blue-700"
            >
              {doc.title}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
