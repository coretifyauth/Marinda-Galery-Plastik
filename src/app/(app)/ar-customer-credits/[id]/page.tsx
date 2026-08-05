import { ArCustomerCreditDetailView } from "./view";

export default async function ArCustomerCreditDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ArCustomerCreditDetailView id={id} />;
}
