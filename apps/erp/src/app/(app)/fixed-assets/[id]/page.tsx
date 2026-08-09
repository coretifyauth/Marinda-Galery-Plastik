import { FixedAssetDetailView } from "./view";

export default async function FixedAssetDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <FixedAssetDetailView id={id} />;
}
