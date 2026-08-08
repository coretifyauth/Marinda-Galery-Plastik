import { ApDepositDetailView } from "./view";

export default async function ApDepositDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ApDepositDetailView id={id} />;
}
