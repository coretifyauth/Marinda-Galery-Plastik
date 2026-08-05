import { ArReturnCreditDetailView } from "./view";

export default async function ArReturnCreditDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ArReturnCreditDetailView id={id} />;
}
