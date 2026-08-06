import { ApBillDetailView } from "./view";

export default async function ApBillDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ApBillDetailView id={id} />;
}
