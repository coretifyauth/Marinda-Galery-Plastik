import { SalesOrderDetailView } from "./view";

export default async function SalesOrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <SalesOrderDetailView id={id} />;
}
