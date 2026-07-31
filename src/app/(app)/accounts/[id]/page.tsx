import { AccountDetailView } from "./view";

export default async function AccountDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <AccountDetailView id={id} />;
}
