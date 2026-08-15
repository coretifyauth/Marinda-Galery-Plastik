import { z } from "zod";
import { supabase } from "@/lib/supabase/client";

export type DocumentSignatory = {
  id: string;
  label: string;
  sort_order: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export const createDocumentSignatorySchema = z.object({
  label: z.string().min(1, "Label jabatan wajib diisi"),
  sort_order: z.coerce.number().int(),
});

export type CreateDocumentSignatoryInput = z.infer<typeof createDocumentSignatorySchema>;

/** Dipakai di blok tanda tangan cetakan (AR Invoice/PO) — cuma label jabatan, gak ada
 * nama pegawai (keputusan desain, lihat migration 0026_print_letterhead_signatories.sql). */
export async function fetchActiveSignatoryLabels(): Promise<string[]> {
  const { data } = await supabase
    .from("document_signatories")
    .select("label")
    .is("archived_at", null)
    .order("sort_order");
  return ((data ?? []) as { label: string }[]).map((row) => row.label);
}
