import { ApBillFromGoodsReceiptsView } from "./view";

export default async function ApBillFromGoodsReceiptsPage({
  searchParams,
}: {
  searchParams: Promise<{ supplier?: string; note?: string }>;
}) {
  const { supplier, note } = await searchParams;
  return <ApBillFromGoodsReceiptsView initialSupplierId={supplier ?? ""} initialNoteId={note ?? ""} />;
}
