import Link from "next/link";
import { listModules } from "@/lib/docs/fs";
import { DOC_CATEGORIES } from "@/lib/docs/categories";

export default async function TutorialModulesPage() {
  const modules = await listModules("tutorial");
  const categoryLabel = DOC_CATEGORIES.find((c) => c.id === "tutorial")!.label;

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <nav className="mb-3 flex items-center gap-1.5 text-xs text-slate-400">
        <Link href="/docs" className="hover:text-slate-600">
          Documentation
        </Link>
      </nav>
      <h1 className="mb-1 text-2xl font-semibold text-black">{categoryLabel}</h1>
      <p className="mb-6 text-sm text-slate-500">
        Pilih modul untuk lihat daftar task/workflow-nya.
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {modules.map((mod) => (
          <Link
            key={mod.id}
            href={`/docs/tutorial/${mod.id}`}
            className="flex flex-col gap-1 rounded-xl border border-slate-200 bg-white p-5 shadow-sm hover:border-slate-300 hover:shadow"
          >
            <span className="font-semibold text-black">{mod.label}</span>
            <span className="text-sm text-slate-500">{mod.docs.length} task</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
