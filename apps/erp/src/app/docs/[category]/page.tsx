import { notFound } from "next/navigation";
import { DOC_CATEGORIES, isValidCategory } from "@/lib/docs/categories";
import { listDocs } from "@/lib/docs/fs";
import { DocsCategoryView } from "./view";

export default async function DocsCategoryPage({
  params,
}: {
  params: Promise<{ category: string }>;
}) {
  const { category } = await params;

  if (!isValidCategory(category)) {
    notFound();
  }

  const docs = await listDocs(category);
  const meta = DOC_CATEGORIES.find((c) => c.id === category)!;

  return <DocsCategoryView category={category} label={meta.label} docs={docs} />;
}
