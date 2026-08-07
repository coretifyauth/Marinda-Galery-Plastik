import { ArPaymentDetailView } from "./view";

export default async function ArPaymentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ArPaymentDetailView id={id} />;
}
