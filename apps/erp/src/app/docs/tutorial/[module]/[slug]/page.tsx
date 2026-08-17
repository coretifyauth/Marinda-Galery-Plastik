import { notFound } from "next/navigation";
import { listModules, readModuleDoc } from "@/lib/docs/fs";
import { TutorialDocReaderView } from "./view";

export default async function TutorialDocReaderPage({
  params,
}: {
  params: Promise<{ module: string; slug: string }>;
}) {
  const { module: moduleId, slug } = await params;

  const [doc, modules] = await Promise.all([
    readModuleDoc("tutorial", moduleId, slug),
    listModules("tutorial"),
  ]);
  const mod = modules.find((m) => m.id === moduleId);

  if (!doc || !mod) {
    notFound();
  }

  return (
    <TutorialDocReaderView
      moduleId={mod.id}
      moduleLabel={mod.label}
      title={doc.title}
      raw={doc.raw}
      modifiedAt={doc.modifiedAt}
      minutes={doc.minutes}
    />
  );
}
