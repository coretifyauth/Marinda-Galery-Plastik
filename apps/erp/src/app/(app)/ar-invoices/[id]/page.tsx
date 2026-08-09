import { ArInvoiceDetailView } from "./view";

export default async function ArInvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ArInvoiceDetailView id={id} />;
}
