"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import type { JournalEntry } from "@/lib/journal-entries/schema";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";

export function JournalEntryDetailView({ id }: { id: string }) {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [entry, setEntry] = useState<JournalEntry | null>(null);
  const [pairedEntry, setPairedEntry] = useState<JournalEntry | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("journal_entries")
      .select(
        "id, entry_date, description, source_ref, reverses_entry_id, created_at, journal_lines(id, journal_entry_id, account_id, debit, credit, accounts(code, name))"
      )
      .eq("id", id)
      .single();
    if (error || !data) {
      setLoadError(error?.message ?? "Journal entry gak ditemukan.");
      return;
    }
    const loaded = data as unknown as JournalEntry;
    setEntry(loaded);
    setLoadError(null);

    // Cari pasangan: entry asli yang dibalik oleh ini, atau entry reversal-nya (kalau ada).
    const pairedId = loaded.reverses_entry_id;
    const { data: reversalRows } = await supabase
      .from("journal_entries")
      .select(
        "id, entry_date, description, source_ref, reverses_entry_id, created_at, journal_lines(id, journal_entry_id, account_id, debit, credit, accounts(code, name))"
      )
      .or(`id.eq.${pairedId ?? "00000000-0000-0000-0000-000000000000"},reverses_entry_id.eq.${loaded.id}`);
    const paired = ((reversalRows ?? []) as unknown as JournalEntry[]).find((r) => r.id !== loaded.id);
    setPairedEntry(paired ?? null);
  }, [id]);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) {
        router.replace("/login");
        return;
      }
      await load();
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, load]);

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  if (!entry) {
    return <FormError>{loadError ?? "Journal entry gak ditemukan."}</FormError>;
  }

  const totalDebit = entry.journal_lines.reduce((sum, l) => sum + l.debit, 0);
  const totalCredit = entry.journal_lines.reduce((sum, l) => sum + l.credit, 0);

  return (
    <div className="flex w-full max-w-4xl flex-1 flex-col gap-6">
      <BackLink href="/journal-entries" label="Kembali ke Journal Entries" />

      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold text-black">
              {entry.description || entry.source_ref}
            </h1>
            {entry.reverses_entry_id && (
              <span className="rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700">
                Reversal
              </span>
            )}
            {pairedEntry && !entry.reverses_entry_id && (
              <span className="rounded bg-red-50 px-1.5 py-0.5 text-xs text-red-700">
                Sudah Direversal
              </span>
            )}
          </div>
          <p className="text-sm text-slate-500">{entry.entry_date}</p>
        </div>
      </div>

      {loadError && <FormError>{loadError}</FormError>}

      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs uppercase text-slate-400">Tanggal</dt>
            <dd className="text-black">{entry.entry_date}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-400">Deskripsi</dt>
            <dd className="text-black">{entry.description || "-"}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-400">Source Ref</dt>
            <dd className="text-black">{entry.source_ref}</dd>
          </div>
        </dl>
        {pairedEntry && (
          <p className="mt-4 text-sm text-slate-500">
            {entry.reverses_entry_id ? "Membalik entry: " : "Dibalik oleh entry: "}
            <button
              type="button"
              onClick={() => router.push(`/journal-entries/${pairedEntry.id}`)}
              className="text-slate-700 underline hover:text-black"
            >
              {pairedEntry.description || pairedEntry.source_ref} ({pairedEntry.entry_date})
            </button>
          </p>
        )}
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <span className="text-sm font-medium text-black">Journal Lines</span>
          <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
            {entry.journal_lines.length}
          </span>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Akun</th>
              <th className="px-4 py-2 text-right">Debit</th>
              <th className="px-4 py-2 text-right">Kredit</th>
            </tr>
          </thead>
          <tbody>
            {entry.journal_lines.map((line) => (
              <tr key={line.id} className="border-b border-slate-100 hover:bg-slate-50">
                <td className="px-4 py-2">
                  {line.accounts.code} — {line.accounts.name}
                </td>
                <td className="px-4 py-2 text-right font-mono">
                  {line.debit > 0 ? line.debit.toLocaleString("id-ID") : ""}
                </td>
                <td className="px-4 py-2 text-right font-mono">
                  {line.credit > 0 ? line.credit.toLocaleString("id-ID") : ""}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-slate-200 bg-slate-50 text-sm font-medium">
              <td className="px-4 py-2">Total</td>
              <td className="px-4 py-2 text-right font-mono">{totalDebit.toLocaleString("id-ID")}</td>
              <td className="px-4 py-2 text-right font-mono">{totalCredit.toLocaleString("id-ID")}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
