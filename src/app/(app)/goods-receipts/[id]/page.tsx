import { GoodsReceiptDetailView } from "./view";

export default async function GoodsReceiptDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <GoodsReceiptDetailView id={id} />;
}
