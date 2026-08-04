import { ArDepositDetailView } from "./view";

export default async function ArDepositDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ArDepositDetailView id={id} />;
}
