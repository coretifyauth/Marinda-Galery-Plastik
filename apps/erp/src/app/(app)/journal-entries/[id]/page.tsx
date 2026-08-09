import { JournalEntryDetailView } from "./view";

export default async function JournalEntryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <JournalEntryDetailView id={id} />;
}
