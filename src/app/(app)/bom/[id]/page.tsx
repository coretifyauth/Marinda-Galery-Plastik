import { BomDetailView } from "./view";

export default async function BomDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <BomDetailView id={id} />;
}
