import { NewGoodsReceiptView } from "./view";

export default async function NewGoodsReceiptPage({
  searchParams,
}: {
  searchParams: Promise<{ bill?: string }>;
}) {
  const { bill } = await searchParams;
  return <NewGoodsReceiptView initialBillId={bill ?? ""} />;
}
