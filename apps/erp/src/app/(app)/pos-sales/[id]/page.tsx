import { PosSaleDetailView } from "./view";

export default async function PosSaleDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <PosSaleDetailView id={id} />;
}
