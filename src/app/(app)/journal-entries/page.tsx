"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { getLeafAccounts, type Account } from "@/lib/accounts/schema";
import { createJournalEntrySchema, type JournalEntry } from "@/lib/journal-entries/schema";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";

type LineInput = { account_id: string; debit: string; credit: string };

function emptyLine(): LineInput {
  return { account_id: "", debit: "", credit: "" };
}

export default function JournalEntriesPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [entryDate, setEntryDate] = useState("");
  const [description, setDescription] = useState("");
  const [sourceRef, setSourceRef] = useState("");
  const [lines, setLines] = useState<LineInput[]>([emptyLine(), emptyLine()]);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const leafAccounts = getLeafAccounts(accounts);

  const loadEntries = useCallback(async () => {
    const { data, error } = await supabase
      .from("journal_entries")
      .select(
        "id, entry_date, description, source_ref, reverses_entry_id, created_at, journal_lines(id, journal_entry_id, account_id, debit, credit, accounts(code, name))"
      )
      .order("entry_date", { ascending: false });
    if (error) {
      setLoadError(error.message);
      return;
    }
    setLoadError(null);
    setEntries((data ?? []) as unknown as JournalEntry[]);
  }, []);

  const loadAccounts = useCallback(async () => {
    const { data } = await supabase
      .from("accounts")
      .select("id, code, name, category, normal_balance, parent_id, archived_at")
      .order("code");
    setAccounts((data ?? []) as Account[]);
  }, []);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) {
        router.replace("/login");
        return;
      }
      const { data: roleRows } = await supabase
        .from("user_roles")
        .select("role_name")
        .eq("user_id", session.user.id);
      if (!active) return;
      setRoles(((roleRows ?? []) as { role_name: string }[]).map((r) => r.role_name));
      await Promise.all([loadAccounts(), loadEntries()]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadAccounts, loadEntries]);

  function updateLine(index: number, patch: Partial<LineInput>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function addLine() {
    setLines((prev) => [...prev, emptyLine()]);
  }

  function removeLine(index: number) {
    setLines((prev) => (prev.length > 2 ? prev.filter((_, i) => i !== index) : prev));
  }

  const totalDebit = lines.reduce((sum, l) => sum + (parseFloat(l.debit) || 0), 0);
  const totalCredit = lines.reduce((sum, l) => sum + (parseFloat(l.credit) || 0), 0);
  const isBalanced = totalDebit > 0 && Math.abs(totalDebit - totalCredit) < 0.005;

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const parsed = createJournalEntrySchema.safeParse({
      entry_date: entryDate,
      description,
      source_ref: sourceRef,
      lines: lines.map((l) => ({
        account_id: l.account_id,
        debit: l.debit === "" ? 0 : Number(l.debit),
        credit: l.credit === "" ? 0 : Number(l.credit),
      })),
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setSubmitting(true);
    const { error } = await supabase.rpc("create_journal_entry", {
      p_entry_date: parsed.data.entry_date,
      p_description: parsed.data.description || null,
      p_source_ref: parsed.data.source_ref,
      p_lines: parsed.data.lines,
    });
    setSubmitting(false);
    if (error) {
      setFormError(error.message);
      return;
    }

    setEntryDate("");
    setDescription("");
    setSourceRef("");
    setLines([emptyLine(), emptyLine()]);
    setShowForm(false);
    await loadEntries();
  }

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");

  return (
    <div className="flex w-full max-w-5xl flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">Journal Entries — CV Roti Barokah</h1>
        <p className="text-sm text-slate-500">
          Role kamu:{" "}
          {roles.length > 0 ? roles.join(", ") : "belum ada role — cuma bisa lihat"}
        </p>
      </div>

      {loadError && <FormError>{loadError}</FormError>}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-black">Journal Entries</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
              {entries.length}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="toolbar" onClick={() => loadEntries()}>
              Refresh
            </Button>
            {canWrite && (
              <Button variant="toolbar-primary" onClick={() => setShowForm((v) => !v)}>
                + New
              </Button>
            )}
          </div>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="w-8 px-4 py-2" />
              <th className="px-4 py-2">Tanggal</th>
              <th className="px-4 py-2">Deskripsi</th>
              <th className="px-4 py-2">Source Ref</th>
              <th className="px-4 py-2">Baris</th>
              <th className="px-4 py-2 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const total = entry.journal_lines.reduce((sum, l) => sum + l.debit, 0);
              return (
                <tr key={entry.id} className="border-b border-slate-100 align-top hover:bg-slate-50">
                  <td className="px-4 py-2">
                    <input type="checkbox" className="rounded border-slate-300" />
                  </td>
                  <td className="whitespace-nowrap px-4 py-2">{entry.entry_date}</td>
                  <td className="px-4 py-2">
                    {entry.description}
                    {entry.reverses_entry_id && (
                      <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700">
                        Reversal
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">{entry.source_ref}</td>
                  <td className="px-4 py-2">
                    <ul className="space-y-0.5">
                      {entry.journal_lines.map((line) => (
                        <li key={line.id}>
                          {line.accounts.code} {line.accounts.name} —{" "}
                          {line.debit > 0
                            ? `D ${line.debit.toLocaleString("id-ID")}`
                            : `K ${line.credit.toLocaleString("id-ID")}`}
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    {total.toLocaleString("id-ID")}
                  </td>
                </tr>
              );
            })}
            {entries.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                  Belum ada journal entry.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showForm && (
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="mb-4 font-semibold text-black">Tambah Journal Entry</h2>
        {!canWrite && (
          <p className="mb-4 text-sm text-amber-600">
            Kamu belum punya role admin/accountant — submit di bawah kemungkinan bakal
            ketolak RLS.
          </p>
        )}
        <form onSubmit={handleCreate} className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="entry_date">Tanggal</Label>
              <Input
                id="entry_date"
                type="date"
                value={entryDate}
                onChange={(e) => setEntryDate(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="description">Deskripsi</Label>
              <Input
                id="description"
                placeholder="mis. Jual roti tunai"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="source_ref">Rujukan dokumen (source_ref)</Label>
              <Input
                id="source_ref"
                placeholder="mis. Nota #003"
                value={sourceRef}
                onChange={(e) => setSourceRef(e.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-[1fr_8rem_8rem_2.5rem] gap-2 text-sm font-medium text-slate-500">
              <span>Akun</span>
              <span>Debit</span>
              <span>Kredit</span>
              <span />
            </div>
            {lines.map((line, i) => (
              <div key={i} className="grid grid-cols-[1fr_8rem_8rem_2.5rem] gap-2">
                <Select
                  value={line.account_id}
                  onChange={(e) => updateLine(i, { account_id: e.target.value })}
                >
                  <option value="">Pilih akun...</option>
                  {leafAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </Select>
                <Input
                  type="number"
                  min="0"
                  placeholder="0"
                  value={line.debit}
                  onChange={(e) => updateLine(i, { debit: e.target.value })}
                />
                <Input
                  type="number"
                  min="0"
                  placeholder="0"
                  value={line.credit}
                  onChange={(e) => updateLine(i, { credit: e.target.value })}
                />
                <button
                  type="button"
                  onClick={() => removeLine(i)}
                  disabled={lines.length <= 2}
                  className="text-slate-400 hover:text-red-600 disabled:opacity-30"
                  aria-label="Hapus baris"
                >
                  ✕
                </button>
              </div>
            ))}
            <Button type="button" variant="secondary" onClick={addLine} className="w-fit">
              + Tambah baris
            </Button>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
            <span>
              Total debit:{" "}
              <strong className="font-mono">{totalDebit.toLocaleString("id-ID")}</strong> — Total
              kredit: <strong className="font-mono">{totalCredit.toLocaleString("id-ID")}</strong>
            </span>
            <span className={isBalanced ? "font-medium text-emerald-600" : "font-medium text-red-600"}>
              {isBalanced ? "Balance ✓" : "Belum balance"}
            </span>
          </div>

          {formError && <FormError>{formError}</FormError>}

          <Button type="submit" disabled={submitting || !isBalanced} className="w-fit">
            {submitting ? "Menyimpan..." : "Simpan Entry"}
          </Button>
        </form>
      </div>
      )}
    </div>
  );
}
