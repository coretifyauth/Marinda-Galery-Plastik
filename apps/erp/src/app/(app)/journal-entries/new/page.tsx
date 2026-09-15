"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import { fetchActivePresets } from "@/lib/journal-presets/queries";
import type { Preset } from "@/lib/journal-presets/schema";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { LoadingScreen } from "@/components/ui/loading-screen";

export default function NewJournalEntryPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [roles, setRoles] = useState<string[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);

  const [presetId, setPresetId] = useState("");
  const [entryDate, setEntryDate] = useState("");
  const [description, setDescription] = useState("");
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const selectedPreset = presets.find((p) => p.id === presetId) ?? null;

  const loadPresets = useCallback(async () => {
    setPresets(await fetchActivePresets());
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
      await loadPresets();
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadPresets]);

  useEffect(() => {
    setAmounts({});
  }, [presetId]);

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!selectedPreset) throw new Error("Pilih preset dulu");
      const sourceRef = await generateDocumentNumber("journal_entries");
      const lineAmounts = selectedPreset.app_preset_journal_entry_lines.map((line) => ({
        line_id: line.id,
        amount: Number(amounts[line.id] || 0),
      }));
      const { data, error } = await supabase.rpc("create_journal_entry_from_preset", {
        p_preset_id: selectedPreset.id,
        p_entry_date: entryDate,
        p_description: description || null,
        p_source_ref: sourceRef,
        p_line_amounts: lineAmounts,
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

  const totalDebit = selectedPreset
    ? selectedPreset.app_preset_journal_entry_lines
        .filter((l) => l.side === "debit")
        .reduce((sum, l) => sum + (Number(amounts[l.id]) || 0), 0)
    : 0;
  const totalCredit = selectedPreset
    ? selectedPreset.app_preset_journal_entry_lines
        .filter((l) => l.side === "credit")
        .reduce((sum, l) => sum + (Number(amounts[l.id]) || 0), 0)
    : 0;
  const allAmountsFilled = selectedPreset
    ? selectedPreset.app_preset_journal_entry_lines.every((l) => Number(amounts[l.id]) > 0)
    : false;
  const isBalanced = allAmountsFilled && totalDebit > 0 && Math.abs(totalDebit - totalCredit) < 0.005;

  function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!selectedPreset) {
      setFormError("Pilih preset dulu");
      return;
    }
    if (!entryDate) {
      setFormError("Tanggal wajib diisi");
      return;
    }
    if (!isBalanced) {
      setFormError("Total debit harus sama dengan total kredit, semua baris wajib diisi > 0");
      return;
    }
    createMutation.mutate();
  }

  if (checkingSession) {
    return <LoadingScreen />;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/journal-entries" label="Kembali ke Jurnal Umum" />

      <div>
        <h1 className="text-xl font-semibold text-black">Tambah Jurnal (Preset)</h1>
        <p className="text-sm text-slate-500">
          Akun & sisi (debit/kredit) tiap baris sudah dikunci dari preset yang dipilih role
          master — kamu cuma isi jumlah per baris. Gak ada lagi pilih akun bebas di sini.
        </p>
      </div>

      {!canWrite && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-700">
          Kamu belum punya role admin/accountant — submit di bawah kemungkinan bakal ketolak RLS.
        </p>
      )}

      {presets.length === 0 && (
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-600">
          Belum ada preset aktif. Minta role master bikin & aktifkan preset dulu lewat{" "}
          <a href="/journal-entries/presets" className="underline">
            Preset Jurnal
          </a>
          .
        </p>
      )}

      <form onSubmit={handleCreate} className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label htmlFor="preset">Preset</Label>
                <Select id="preset" value={presetId} onChange={(e) => setPresetId(e.target.value)}>
                  <option value="">Pilih preset...</option>
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </Select>
              </div>
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
                  placeholder="mis. Bayar listrik Juli"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
            </div>
          </div>

          {selectedPreset && (
            <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
              <p className="mb-3 text-sm font-medium text-black">Baris Jurnal</p>
              <div className="flex flex-col gap-2">
                <div className="grid grid-cols-[1fr_6rem_8rem] gap-2 text-sm font-medium text-slate-500">
                  <span>Akun</span>
                  <span>Sisi</span>
                  <span>Jumlah</span>
                </div>
                {selectedPreset.app_preset_journal_entry_lines.map((line) => (
                  <div key={line.id} className="grid grid-cols-[1fr_6rem_8rem] gap-2">
                    <span className="flex flex-col justify-center text-sm text-black">
                      {line.accounts.code} — {line.accounts.name}
                      {line.label && <span className="text-xs text-slate-400">{line.label}</span>}
                    </span>
                    <span className="flex items-center text-sm capitalize text-slate-500">
                      {line.side === "debit" ? "Debit" : "Kredit"}
                    </span>
                    <Input
                      type="number"
                      min="0"
                      placeholder="0"
                      value={amounts[line.id] ?? ""}
                      onChange={(e) => setAmounts((prev) => ({ ...prev, [line.id]: e.target.value }))}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
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
