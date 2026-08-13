import type { ResolvedAccount } from "@/lib/default-accounts/schema";

/** Binding tak-terlihat buat akun yang SELALU resolve ke 1 akun yang sama —
 * baca dari default_account_settings (role_key), bukan dipilih user. Gak ada
 * UI visible di sini; ringkasan "akun apa yang kena jurnal" ditampilin
 * terpusat lewat <JournalPreviewPanel> di atas section form, bukan tersebar
 * per-field di tengah form (memory/preferences/ui/journal-preview-panel.md). */
export function LockedAccountField({
  resolved,
  htmlFor,
}: {
  label?: string;
  resolved: ResolvedAccount | undefined;
  htmlFor: string;
}) {
  return <input type="hidden" id={htmlFor} value={resolved?.id ?? ""} readOnly />;
}
