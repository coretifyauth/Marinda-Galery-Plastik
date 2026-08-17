import Link from "next/link";
import { MarkdownContent } from "@/components/docs/markdown-content";

export function TutorialDocReaderView({
  moduleId,
  moduleLabel,
  title,
  raw,
  modifiedAt,
  minutes,
}: {
  moduleId: string;
  moduleLabel: string;
  title: string;
  raw: string;
  modifiedAt: string;
  minutes: number;
}) {
  const formattedDate = new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(modifiedAt));

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <nav className="mb-3 flex items-center gap-1.5 text-xs text-slate-400">
        <Link href="/docs" className="hover:text-slate-600">
          Documentation
        </Link>
        <span>/</span>
        <Link href="/docs/tutorial" className="hover:text-slate-600">
          Tutorial
        </Link>
        <span>/</span>
        <Link href={`/docs/tutorial/${moduleId}`} className="hover:text-slate-600">
          {moduleLabel}
        </Link>
      </nav>
      <h1 className="mb-1 text-2xl font-semibold text-black">{title}</h1>
      <p className="mb-6 text-sm text-slate-400">
        Terakhir diubah {formattedDate} · {minutes} menit baca
      </p>
      <MarkdownContent raw={raw} category="tutorial" moduleId={moduleId} />
    </div>
  );
}
