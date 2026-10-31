"use client";

import type { FormDraft } from "@/lib/form-draft/use-form-draft";

/** Tampil kalau isian form dipulihkan dari draf yang belum tersimpan. */
export function DraftNotice({ draft }: { draft: FormDraft }) {
  if (!draft.restoredAt) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm text-blue-900">
      <span>
        Isian sebelumnya dipulihkan (terakhir tersimpan{" "}
        {new Date(draft.restoredAt).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" })}). Dokumen ini belum
        tercatat sampai kamu menekan Simpan.
      </span>
      <button type="button" className="font-medium underline" onClick={draft.discard}>
        Buang isian
      </button>
    </div>
  );
}
