import { supabase } from "@/lib/supabase/client";

/**
 * Nota supplier yang sama pernah dicatat dan belum dibatalkan -> minta konfirmasi. Peringatan, bukan penolakan: nomor nota
 * boleh kembar antar kejadian yang sah, dan kolomnya opsional. Mengembalikan true kalau boleh lanjut.
 */
export async function confirmDuplicateSupplierNote(supplierId: string, documentRef: string): Promise<boolean> {
  const ref = documentRef.trim();
  if (!ref) return true;
  const { data, error } = await supabase
    .from("transactions")
    .select("source_ref, date, amount")
    .eq("type", "INBOUND")
    .eq("counterparty_id", supplierId)
    .eq("supplier_document_ref", ref)
    .neq("status", "dibatalkan")
    .limit(3);
  if (error || !data || data.length === 0) return true;
  const found = (data as { source_ref: string; date: string; amount: number }[])
    .map((t) => `${t.source_ref} (${t.date}, Rp${t.amount.toLocaleString("id-ID")})`)
    .join(", ");
  return window.confirm(`Nota supplier "${ref}" sudah pernah dicatat: ${found}. Tetap buat tagihan baru?`);
}
