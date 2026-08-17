import { notFound } from "next/navigation";
import { readDoc } from "@/lib/docs/fs";
import { DOC_CATEGORIES, isGroupedCategory, isValidCategory } from "@/lib/docs/categories";
import { DocReaderView } from "./view";

export default async function DocReaderPage({
  params,
}: {
  params: Promise<{ category: string; slug: string }>;
}) {
  const { category, slug } = await params;

  // Kategori grouped (tutorial) dibaca lewat readModuleDoc di /docs/tutorial/[module]/[slug],
  // bukan lewat sini -- readDoc sengaja gak nyoba baca kategori grouped sama sekali.
  if (!isValidCategory(category) || isGroupedCategory(category)) {
    notFound();
  }

  const doc = await readDoc(category, slug);

  if (!doc) {
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
