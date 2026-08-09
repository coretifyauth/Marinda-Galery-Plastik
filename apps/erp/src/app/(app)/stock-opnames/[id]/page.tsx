import { StockOpnameDetailView } from "./view";

export default async function StockOpnameDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <StockOpnameDetailView id={id} />;
}
