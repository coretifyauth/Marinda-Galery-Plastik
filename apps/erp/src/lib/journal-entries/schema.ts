import { z } from "zod";

export const journalLineSchema = z
  .object({
    account_id: z.string().uuid("Pilih akun"),
    debit: z.coerce.number().min(0).default(0),
    credit: z.coerce.number().min(0).default(0),
  })
  .refine((line) => (line.debit > 0) !== (line.credit > 0), {
    message: "Isi salah satu: debit ATAU kredit (bukan dua-duanya, bukan kosong dua-duanya)",
  });

export const createJournalEntrySchema = z
  .object({
    entry_date: z.string().min(1, "Tanggal wajib diisi"),
    description: z.string().optional(),
    lines: z.array(journalLineSchema).min(2, "Minimal 2 baris"),
  })
  .refine(
    (data) => {
      const totalDebit = data.lines.reduce((sum, l) => sum + l.debit, 0);
      const totalCredit = data.lines.reduce((sum, l) => sum + l.credit, 0);
      return Math.abs(totalDebit - totalCredit) < 0.005;
    },
    { message: "Total debit harus sama dengan total kredit", path: ["lines"] }
  );

export type CreateJournalEntryInput = z.infer<typeof createJournalEntrySchema>;

export type JournalLine = {
  id: string;
  journal_entry_id: string;
  account_id: string;
  debit: number;
  credit: number;
};

export type JournalEntry = {
  id: string;
  entry_date: string;
  description: string | null;
  source_ref: string;
  reverses_entry_id: string | null;
  created_at: string;
  journal_lines: (JournalLine & { accounts: { code: string; name: string } })[];
};
