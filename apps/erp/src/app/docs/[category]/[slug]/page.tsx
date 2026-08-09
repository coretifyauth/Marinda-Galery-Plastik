import { notFound } from "next/navigation";
import { readDoc } from "@/lib/docs/fs";
import { DOC_CATEGORIES, isValidCategory } from "@/lib/docs/categories";
import { DocReaderView } from "./view";

export default async function DocReaderPage({
  params,
}: {
  params: Promise<{ category: string; slug: string }>;
}) {
  const { category, slug } = await params;
  const doc = await readDoc(category, slug);

  if (!doc || !isValidCategory(category)) {
    notFound();
  }

  const categoryLabel = DOC_CATEGORIES.find((c) => c.id === category)!.label;

  return (
    <DocReaderView
      category={category}
      categoryLabel={categoryLabel}
      title={doc.title}
      raw={doc.raw}
      modifiedAt={doc.modifiedAt}
      minutes={doc.minutes}
    />
  );
}
