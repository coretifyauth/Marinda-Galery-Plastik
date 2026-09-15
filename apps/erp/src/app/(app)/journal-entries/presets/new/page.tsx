"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { getLeafAccounts, type Account } from "@/lib/accounts/schema";
import { createPresetSchema } from "@/lib/journal-presets/schema";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { LoadingScreen } from "@/components/ui/loading-screen";

type LineInput = { account_id: string; side: "debit" | "credit"; label: string };

function emptyLine(): LineInput {
  return { account_id: "", side: "debit", label: "" };
}

export default function NewJournalPresetPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [label, setLabel] = useState("");
  const [lines, setLines] = useState<LineInput[]>([emptyLine(), { ...emptyLine(), side: "credit" }]);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
      await loadAccounts();
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadAccounts]);

  function updateLine(index: number, patch: Partial<LineInput>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function addLine() {
    setLines((prev) => [...prev, emptyLine()]);
  }

  function removeLine(index: number) {
    setLines((prev) => (prev.length > 2 ? prev.filter((_, i) => i !== index) : prev));
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const parsed = createPresetSchema.safeParse({
      label,
      lines: lines.map((l) => ({
        account_id: l.account_id,
        side: l.side,
        label: l.label || undefined,
      })),
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setSubmitting(true);
    const { data: header, error: headerErr } = await supabase
      .from("app_preset_journal_entries")
      .insert({ label: parsed.data.label })
      .select("id")
      .single();
    if (headerErr || !header) {
      setSubmitting(false);
      setFormError(headerErr?.message ?? "Gagal bikin preset");
      return;
    }

    const { error: linesErr } = await supabase.from("app_preset_journal_entry_lines").insert(
      parsed.data.lines.map((l, i) => ({
        preset_id: header.id,
        account_id: l.account_id,
        side: l.side,
        label: l.label ?? null,
        sort_order: i,
      }))
    );
    setSubmitting(false);
    if (linesErr) {
      setFormError(linesErr.message);
      return;
    }

    router.push(`/journal-entries/presets/${header.id}`);
  }

  if (checkingSession) {
    return <LoadingScreen />;
  }

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/journal-entries/presets" label="Kembali ke Preset Jurnal" />

      <div>
        <h1 className="text-xl font-semibold text-black">Tambah Preset Jurnal</h1>
        <p className="text-sm text-slate-500">
          Preset dimulai sebagai draft — akun & sisi tiap baris masih bisa diubah bebas sampai
          kamu klik Aktifkan di halaman detail. Jumlah (amount) TIDAK diisi di sini, itu diisi
          tiap kali preset ini dipakai posting.
        </p>
      </div>

      <form onSubmit={handleCreate} className="flex flex-col gap-6">
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="label">Nama Preset</Label>
            <Input
              id="label"
              placeholder="mis. Bayar Listrik"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="mb-3 text-sm font-medium text-black">Baris Preset</p>
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-[1fr_8rem_1fr_2.5rem] gap-2 text-sm font-medium text-slate-500">
              <span>Akun</span>
              <span>Sisi</span>
              <span>Keterangan (opsional)</span>
              <span />
            </div>
            {lines.map((line, i) => (
              <div key={i} className="grid grid-cols-[1fr_8rem_1fr_2.5rem] gap-2">
                <Select value={line.account_id} onChange={(e) => updateLine(i, { account_id: e.target.value })}>
                  <option value="">Pilih akun...</option>
                  {leafAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </Select>
                <Select
                  value={line.side}
                  onChange={(e) => updateLine(i, { side: e.target.value as "debit" | "credit" })}
                >
                  <option value="debit">Debit</option>
                  <option value="credit">Kredit</option>
                </Select>
                <Input
                  placeholder="mis. Beban Iklan Dept A"
                  value={line.label}
                  onChange={(e) => updateLine(i, { label: e.target.value })}
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

        {formError && <FormError>{formError}</FormError>}

        <div className="flex gap-2">
          <Button type="submit" disabled={submitting}>
            {submitting ? "Menyimpan..." : "Simpan Draft"}
          </Button>
          <Button type="button" variant="secondary" onClick={() => router.back()}>
            Batal
          </Button>
        </div>
      </form>
    </div>
  );
}
