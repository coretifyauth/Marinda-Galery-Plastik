import { ProductionOrderDetailView } from "./view";

export default async function ProductionOrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ProductionOrderDetailView id={id} />;
}
