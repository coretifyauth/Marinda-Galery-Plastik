import { notFound } from "next/navigation";
import { listModules } from "@/lib/docs/fs";
import { TutorialModuleView } from "./view";

export default async function TutorialModulePage({
  params,
}: {
  params: Promise<{ module: string }>;
}) {
  const { module: moduleId } = await params;
  const modules = await listModules("tutorial");
  const mod = modules.find((m) => m.id === moduleId);

  if (!mod) {
    notFound();
  }

  return <TutorialModuleView moduleId={mod.id} label={mod.label} docs={mod.docs} />;
}
