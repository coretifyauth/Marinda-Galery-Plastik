import Link from "next/link";
import { Landmark, Database, Newspaper } from "lucide-react";
import { DOC_CATEGORIES, type DocCategoryId } from "@/lib/docs/categories";

const categoryIcons: Record<DocCategoryId, typeof Landmark> = {
  domain: Landmark,
  architecture: Database,
  story: Newspaper,
};

export default function DocsLandingPage() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-8 py-10">
      <div>
        <h1 className="text-2xl font-semibold text-black">Documentation</h1>
        <p className="text-sm text-slate-500">
          Knowledge base project ini — konsep bisnis/akuntansi, struktur data, dan skenario CV Roti
          Barokah.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {DOC_CATEGORIES.map((category) => {
          const Icon = categoryIcons[category.id];
          return (
            <Link
              key={category.id}
              href={`/docs/${category.id}`}
              className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-5 shadow-sm hover:border-slate-300 hover:shadow"
            >
              <Icon className="h-5 w-5 text-blue-600" />
              <span className="font-semibold text-black">{category.label}</span>
              <span className="text-sm text-slate-500">{category.description}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
