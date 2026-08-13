import { supabase } from "@/lib/supabase/client";

// doc_type sama persis dengan nama tabel transaksionalnya -- lihat
// memory/architecture/data/document-numbering-schema.md untuk daftar lengkap 29 jenis.
export async function generateDocumentNumber(docType: string): Promise<string> {
  const { data, error } = await supabase.rpc("generate_document_number", { p_doc_type: docType });
  if (error || !data) {
    throw new Error(error?.message ?? "Gagal generate nomor dokumen");
  }
  return data as string;
}
