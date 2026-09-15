import { JournalPresetDetailView } from "./view";

export default async function JournalPresetDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <JournalPresetDetailView id={id} />;
}
