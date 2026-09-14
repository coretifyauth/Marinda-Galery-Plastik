"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import { getLeafAccounts, type Account } from "@/lib/accounts/schema";
import { createJournalEntrySchema, type CreateJournalEntryInput } from "@/lib/journal-entries/schema";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { LoadingScreen } from "@/components/ui/loading-screen";

type LineInput = { account_id: string; debit: string; credit: string };

function emptyLine(): LineInput {
  return { account_id: "", debit: "", credit: "" };
}

export default function NewJournalEntryPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [roles, setRoles] = useState<string[]>([]);

  const [entryDate, setEntryDate] = useState("");
  const [description, setDescription] = useState("");
  const [lines, setLines] = useState<LineInput[]>([emptyLine(), emptyLine()]);
  const [formError, setFormError] = useState<string | null>(null);

  const leafAccounts = getLeafAccounts(accounts);

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
        .from("app_user_roles")
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
      const { data, error } = await supabase.rpc("create_journal_entry", {
        p_entry_date: input.entry_date,
        p_description: input.description || null,
        p_source_ref: sourceRef,
        p_lines: input.lines,
      });
      if (error) throw new Error(error.message);
      return data as string;
    },
    onSuccess: (newId) => {
      router.push(`/journal-entries/${newId}`);
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
    return <LoadingScreen />;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/journal-entries" label="Kembali ke Jurnal Umum" />

      <div>
        <h1 className="text-xl font-semibold text-black">Tambah Jurnal Manual</h1>
        <p className="text-sm text-slate-500">
          Baris debit/kredit diisi manual — dipakai buat kasus yang gak lewat modul transaksi
          biasa (mis. koreksi, penyesuaian).
        </p>
      </div>

      {!canWrite && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-700">
          Kamu belum punya role admin/accountant — submit di bawah kemungkinan bakal ketolak RLS.
        </p>
      )}

      <form onSubmit={handleCreate} className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <p className="mb-3 text-sm font-medium text-black">Baris Jurnal</p>
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
          </div>
        </div>

        <div className="flex flex-col gap-4 lg:sticky lg:top-4 lg:col-span-1 lg:self-start">
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <p className="text-sm text-slate-500">Total Debit</p>
            <p className="mt-1 font-mono text-2xl text-black">Rp{totalDebit.toLocaleString("id-ID")}</p>
            <p className="mt-3 text-sm text-slate-500">Total Kredit</p>
            <p className="mt-1 font-mono text-2xl text-black">Rp{totalCredit.toLocaleString("id-ID")}</p>
            <p className={`mt-3 text-sm font-medium ${isBalanced ? "text-emerald-600" : "text-red-600"}`}>
              {isBalanced ? "Balance ✓" : "Belum balance"}
            </p>
          </div>

          {formError && <FormError>{formError}</FormError>}

          <div className="flex flex-col gap-2">
            <Button type="submit" disabled={createMutation.isPending || !isBalanced}>
              {createMutation.isPending ? "Menyimpan..." : "Simpan Jurnal"}
            </Button>
            <Button type="button" variant="secondary" onClick={() => router.back()}>
              Batal
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
