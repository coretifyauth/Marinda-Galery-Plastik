import { ApReturnCreditDetailView } from "./view";

export default async function ApReturnCreditDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ApReturnCreditDetailView id={id} />;
}
