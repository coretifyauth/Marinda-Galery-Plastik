import { ApPaymentDetailView } from "./view";

export default async function ApPaymentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ApPaymentDetailView id={id} />;
}
