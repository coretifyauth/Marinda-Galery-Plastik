import { ItemCategoryDetailView } from "./view";

export default async function ItemCategoryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ItemCategoryDetailView id={id} />;
}
