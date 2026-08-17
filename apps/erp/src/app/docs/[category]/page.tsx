import { notFound } from "next/navigation";
import { DOC_CATEGORIES, isGroupedCategory, isValidCategory } from "@/lib/docs/categories";
import { listDocs } from "@/lib/docs/fs";
import { DocsCategoryView } from "./view";

export default async function DocsCategoryPage({
  params,
}: {
  params: Promise<{ category: string }>;
}) {
  const { category } = await params;

  // Kategori grouped (tutorial) punya route literal sendiri di /docs/tutorial
  // (lebih spesifik, menang duluan di Next.js routing) -- kalau somehow nyampe
  // sini juga, tolak eksplisit daripada nampilin daftar kosong (listDocs bakal
  // baca folder tutorial yang isinya subfolder modul, bukan file .md langsung).
  if (!isValidCategory(category) || isGroupedCategory(category)) {
    notFound();
  }

  const docs = await listDocs(category);
  const meta = DOC_CATEGORIES.find((c) => c.id === category)!;

  return <DocsCategoryView category={category} label={meta.label} docs={docs} />;
}
