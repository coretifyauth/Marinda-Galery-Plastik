import { GoodsIssueDetailView } from "./view";

export default async function GoodsIssueDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <GoodsIssueDetailView id={id} />;
}
