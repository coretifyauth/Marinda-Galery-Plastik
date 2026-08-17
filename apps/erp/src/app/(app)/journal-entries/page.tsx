"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import { getLeafAccounts, type Account } from "@/lib/accounts/schema";
import { createJournalEntrySchema, type CreateJournalEntryInput } from "@/lib/journal-entries/schema";
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS, useJournalEntries } from "@/lib/journal-entries/queries";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { Modal } from "@/components/ui/modal";
import { Pagination } from "@/components/ui/pagination";

type LineInput = { account_id: string; debit: string; credit: string };

function emptyLine(): LineInput {
  return { account_id: "", debit: "", credit: "" };
}

// Input kecil buat baris filter di header tabel -- Input/Select biasa terlalu besar buat
// muat di dalam <th>, jadi dibikin versi compact lokal daripada nambah varian ke komponen
// bersama (dipakai lagi kalau modul lain butuh pola sama).
const compactFilterInputClass =
  "w-full rounded border border-slate-200 bg-white px-1.5 py-1 text-xs font-normal normal-case text-slate-700 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-1 focus:ring-blue-600/40";

export default function JournalEntriesPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [checkingSession, setCheckingSession] = useState(true);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [roles, setRoles] = useState<string[]>([]);

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [descSearchInput, setDescSearchInput] = useState("");
  const [refSearchInput, setRefSearchInput] = useState("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const debouncedDescSearch = useDebouncedValue(descSearchInput, 300);
  const debouncedRefSearch = useDebouncedValue(refSearchInput, 300);

  const [entryDate, setEntryDate] = useState("");
  const [description, setDescription] = useState("");
  const [lines, setLines] = useState<LineInput[]>([emptyLine(), emptyLine()]);
  const [formError, setFormError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const leafAccounts = getLeafAccounts(accounts);

  // Filter berubah -> balik ke halaman 1, biar gak kejebak di halaman kosong (mis. lagi di
  // halaman 3 terus filter dipersempit sampai cuma 1 halaman). Reset dilakukan pas render
  // (pola "adjust state during render" React), BUKAN di useEffect -- setState sinkron di
  // effect kena lint react-hooks/set-state-in-effect (cascading render).
  const filterKey = `${dateFrom}|${dateTo}|${debouncedDescSearch}|${debouncedRefSearch}|${pageSize}`;
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey);
  if (filterKey !== prevFilterKey) {
    setPrevFilterKey(filterKey);
    setPage(0);
  }

  const filters = {
    dateFrom,
    dateTo,
    descriptionSearch: debouncedDescSearch,
    sourceRefSearch: debouncedRefSearch,
    page,
    pageSize,
  };
  const entriesQuery = useJournalEntries(filters);
  const entries = entriesQuery.data?.rows ?? [];
  const total = entriesQuery.data?.total ?? 0;

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
      await loadAccounts();
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadAccounts]);

  const createMutation = useMutation({
    mutationFn: async (input: CreateJournalEntryInput) => {
      const sourceRef = await generateDocumentNumber("journal_entries");
      const { error } = await supabase.rpc("create_journal_entry", {
        p_entry_date: input.entry_date,
        p_description: input.description || null,
        p_source_ref: sourceRef,
        p_lines: input.lines,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      setEntryDate("");
      setDescription("");
      setLines([emptyLine(), emptyLine()]);
      setShowForm(false);
      queryClient.invalidateQueries({ queryKey: ["journal_entries"] });
    },
    onError: (err) => {
      setFormError(err instanceof Error ? err.message : "Gagal menyimpan entry");
    },
  });

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

  function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const parsed = createJournalEntrySchema.safeParse({
      entry_date: entryDate,
      description,
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

    createMutation.mutate(parsed.data);
  }

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">Journal Entries</h1>
        <p className="text-sm text-slate-500">
          Role kamu:{" "}
          {roles.length > 0 ? roles.join(", ") : "belum ada role — cuma bisa lihat"}
        </p>
      </div>

      {entriesQuery.error && (
        <FormError>{(entriesQuery.error as Error).message}</FormError>
      )}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-black">Journal Entries</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
              {total}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="toolbar" onClick={() => entriesQuery.refetch()}>
              Refresh
            </Button>
            {canWrite && (
              <Button variant="toolbar-primary" onClick={() => setShowForm(true)}>
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
            <tr className="border-b border-slate-200 bg-slate-50/50">
              <th className="px-4 py-1.5" />
              <th className="px-4 py-1.5">
                <div className="flex gap-1">
                  <input
                    type="date"
                    aria-label="Dari tanggal"
                    value={dateFrom}
                    onChange={(e) => setDateFrom(e.target.value)}
                    className={compactFilterInputClass}
                  />
                  <input
                    type="date"
                    aria-label="Sampai tanggal"
                    value={dateTo}
                    onChange={(e) => setDateTo(e.target.value)}
                    className={compactFilterInputClass}
                  />
                </div>
              </th>
              <th className="px-4 py-1.5">
                <input
                  type="text"
                  placeholder="Cari deskripsi..."
                  value={descSearchInput}
                  onChange={(e) => setDescSearchInput(e.target.value)}
                  className={compactFilterInputClass}
                />
              </th>
              <th className="px-4 py-1.5">
                <input
                  type="text"
                  placeholder="Cari source ref..."
                  value={refSearchInput}
                  onChange={(e) => setRefSearchInput(e.target.value)}
                  className={compactFilterInputClass}
                />
              </th>
              <th className="px-4 py-1.5" />
              <th className="px-4 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const total = entry.journal_lines.reduce((sum, l) => sum + l.debit, 0);
              return (
                <tr
                  key={entry.id}
                  className="cursor-pointer border-b border-slate-100 align-top hover:bg-slate-50"
                  onClick={() => router.push(`/journal-entries/${entry.id}`)}
                >
                  <td className="px-4 py-2" onClick={(e) => e.stopPropagation()}>
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
                  {entriesQuery.isLoading ? "Memuat..." : "Belum ada journal entry."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={setPage}
          pageSizeOptions={PAGE_SIZE_OPTIONS}
          onPageSizeChange={setPageSize}
        />
      </div>

      <Modal open={showForm} onClose={() => setShowForm(false)} title="Tambah Journal Entry" maxWidth="max-w-3xl">
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
                placeholder="mis. Jual barang tunai"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
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

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setShowForm(false)}>
              Batal
            </Button>
            <Button type="submit" disabled={createMutation.isPending || !isBalanced}>
              {createMutation.isPending ? "Menyimpan..." : "Simpan Entry"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
