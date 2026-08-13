import { ItemBrandDetailView } from "./view";

export default async function ItemBrandDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ItemBrandDetailView id={id} />;
}
