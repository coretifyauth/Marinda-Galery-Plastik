import { z } from "zod";
import { supabase } from "@/lib/supabase/client";

export const closePeriodSchema = z
  .object({
    start_date: z.string().min(1, "Tanggal mulai wajib diisi"),
    end_date: z.string().min(1, "Tanggal akhir wajib diisi"),
    retained_earnings_account_id: z.string().uuid("Pilih akun Laba Ditahan"),
    source_ref: z.string().min(1, "Rujukan dokumen wajib diisi"),
  })
  .refine((v) => v.end_date >= v.start_date, {
    message: "Tanggal akhir gak boleh sebelum tanggal mulai",
    path: ["end_date"],
  });

export type ClosePeriodInput = z.infer<typeof closePeriodSchema>;

export type PeriodClosing = {
  id: string;
  start_date: string;
  end_date: string;
  journal_entry_id: string | null;
  source_ref: string;
  created_at: string;
};

export async function listPeriodClosings(): Promise<PeriodClosing[]> {
  const { data, error } = await supabase
    .from("period_closings")
    .select("id, start_date, end_date, journal_entry_id, source_ref, created_at")
    .order("start_date");
  if (error) throw new Error(error.message);
  return (data ?? []) as PeriodClosing[];
}

/**
 * ID `journal_entries` yang merupakan closing entry (dari `period_closings.journal_entry_id`).
 * Dipakai Income Statement buat exclude baris-baris ini dari perhitungan — closing entry
 * bertanggal `end_date` periode yang ditutup, jadi kalau gak di-exclude, baris penolan
 * Revenue/Expense-nya sendiri ikut kehitung pas rentang yang di-query sama persis dengan
 * periode yang baru ditutup, membatalkan balik angka yang baru aja dinolkan.
 * Ref: `memory/scope-debt/income-statement-closing-entry-self-cancel.md` (sekarang sudah
 * ditutup — ini fix-nya).
 */
export async function fetchClosingJournalEntryIds(): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("period_closings")
    .select("journal_entry_id")
    .not("journal_entry_id", "is", null);
  if (error) throw new Error(error.message);
  return new Set((data ?? []).map((row) => row.journal_entry_id as string));
}

/** Tanggal mulai yang valid buat penutupan berikutnya — sehari setelah closing terakhir, atau null kalau belum pernah ada closing. */
export function nextPeriodStartDate(closings: PeriodClosing[]): string | null {
  if (closings.length === 0) return null;
  const lastEnd = closings.reduce((max, c) => (c.end_date > max ? c.end_date : max), closings[0].end_date);
  const d = new Date(`${lastEnd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
