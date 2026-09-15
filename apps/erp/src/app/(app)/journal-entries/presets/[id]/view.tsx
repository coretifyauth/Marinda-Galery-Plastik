"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { getLeafAccounts, type Account } from "@/lib/accounts/schema";
import { fetchPreset } from "@/lib/journal-presets/queries";
import type { Preset, PresetSide } from "@/lib/journal-presets/schema";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { DetailRows } from "@/components/ui/detail-rows";
import { LoadingScreen } from "@/components/ui/loading-screen";

const statusBadge: Record<Preset["status"], string> = {
  draft: "bg-slate-100 text-slate-500",
  active: "bg-emerald-50 text-emerald-700",
  inactive: "bg-amber-50 text-amber-700",
};

const statusLabel: Record<Preset["status"], string> = {
  draft: "Draft",
  active: "Aktif",
  inactive: "Nonaktif",
};

export function JournalPresetDetailView({ id }: { id: string }) {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [roles, setRoles] = useState<string[]>([]);
  const [preset, setPreset] = useState<Preset | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [newAccountId, setNewAccountId] = useState("");
  const [newSide, setNewSide] = useState<PresetSide>("debit");
  const [newLabel, setNewLabel] = useState("");

  const leafAccounts = getLeafAccounts(accounts);

  const load = useCallback(async () => {
    setPreset(await fetchPreset(id));
  }, [id]);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) {
        router.replace("/login");
        return;
      }
      const [{ data: roleRows }, { data: accountRows }] = await Promise.all([
        supabase.from("app_user_roles").select("role_name").eq("user_id", session.user.id),
        supabase.from("accounts").select("id, code, name, category, normal_balance, parent_id, archived_at").order("code"),
      ]);
      if (!active) return;
      setRoles(((roleRows ?? []) as { role_name: string }[]).map((r) => r.role_name));
      setAccounts((accountRows ?? []) as Account[]);
      await load();
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, load]);

  if (checkingSession) {
    return <LoadingScreen />;
  }

  if (!preset) {
    return <FormError>Preset gak ditemukan.</FormError>;
  }

  const canWrite = roles.includes("master");
  const isDraft = preset.status === "draft";

  async function handleAddLine() {
    if (!preset) return;
    if (!newAccountId) {
      setActionError("Pilih akun dulu");
      return;
    }
    setActionError(null);
    setBusy(true);
    const nextSortOrder = preset.app_preset_journal_entry_lines.length;
    const { error } = await supabase.from("app_preset_journal_entry_lines").insert({
      preset_id: preset.id,
      account_id: newAccountId,
      side: newSide,
      label: newLabel || null,
      sort_order: nextSortOrder,
    });
    setBusy(false);
    if (error) {
      setActionError(error.message);
      return;
    }
    setNewAccountId("");
    setNewSide("debit");
    setNewLabel("");
    await load();
  }

  async function handleRemoveLine(lineId: string) {
    setActionError(null);
    setBusy(true);
    const { error } = await supabase.from("app_preset_journal_entry_lines").delete().eq("id", lineId);
    setBusy(false);
    if (error) {
      setActionError(error.message);
      return;
    }
    await load();
  }

  async function handleActivate() {
    if (!preset) return;
    setActionError(null);
    setBusy(true);
    const { error } = await supabase
      .from("app_preset_journal_entries")
      .update({ status: "active" })
      .eq("id", preset.id);
    setBusy(false);
    if (error) {
      setActionError(error.message);
      return;
    }
    await load();
  }

  async function handleToggleActive() {
    if (!preset) return;
    setActionError(null);
    setBusy(true);
    const nextStatus = preset.status === "active" ? "inactive" : "active";
    const { error } = await supabase
      .from("app_preset_journal_entries")
      .update({ status: nextStatus })
      .eq("id", preset.id);
    setBusy(false);
    if (error) {
      setActionError(error.message);
      return;
    }
    await load();
  }

  async function handleDelete() {
    if (!preset) return;
    if (!window.confirm(`Hapus preset "${preset.label}" permanen?`)) return;
    setActionError(null);
    setBusy(true);
    const { error } = await supabase.from("app_preset_journal_entries").delete().eq("id", preset.id);
    setBusy(false);
    if (error) {
      setActionError(error.message);
      return;
    }
    router.push("/journal-entries/presets");
  }

  const detailGroups = [
    {
      title: "Informasi Preset",
      rows: [
        { label: "Nama", value: preset.label },
        {
          label: "Status",
          value: (
            <span className={`rounded-full px-2 py-0.5 text-xs ${statusBadge[preset.status]}`}>
              {statusLabel[preset.status]}
            </span>
          ),
        },
        { label: "Diaktifkan Pada", value: preset.activated_at ? new Date(preset.activated_at).toLocaleString("id-ID") : "-" },
      ],
    },
  ];

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/journal-entries/presets" label="Kembali ke Preset Jurnal" />

      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-black">Detail Preset Jurnal</h1>
        {canWrite && (
          <div className="flex items-center gap-1.5">
            {isDraft && (
              <>
                <Button variant="secondary" onClick={handleDelete} disabled={busy}>
                  Hapus Preset
                </Button>
                <Button onClick={handleActivate} disabled={busy}>
                  Aktifkan
                </Button>
              </>
            )}
            {!isDraft && (
              <Button variant="secondary" onClick={handleToggleActive} disabled={busy}>
                {preset.status === "active" ? "Nonaktifkan" : "Aktifkan"}
              </Button>
            )}
          </div>
        )}
      </div>

      {actionError && <FormError>{actionError}</FormError>}

      <DetailRows groups={detailGroups} />

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <span className="text-sm font-medium text-black">Baris Preset</span>
          <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
            {preset.app_preset_journal_entry_lines.length}
          </span>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Akun</th>
              <th className="px-4 py-2">Sisi</th>
              <th className="px-4 py-2">Keterangan</th>
              {canWrite && isDraft && <th className="px-4 py-2" />}
            </tr>
          </thead>
          <tbody>
            {preset.app_preset_journal_entry_lines.map((line) => (
              <tr key={line.id} className="border-b border-slate-100">
                <td className="px-4 py-2">
                  {line.accounts.code} — {line.accounts.name}
                </td>
                <td className="px-4 py-2 capitalize">{line.side === "debit" ? "Debit" : "Kredit"}</td>
                <td className="px-4 py-2 text-slate-500">{line.label || "-"}</td>
                {canWrite && isDraft && (
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => handleRemoveLine(line.id)}
                      disabled={busy}
                      className="text-slate-400 hover:text-red-600 disabled:opacity-30"
                      aria-label="Hapus baris"
                    >
                      ✕
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {canWrite && isDraft && (
          <div className="grid grid-cols-[1fr_8rem_1fr_5rem] gap-2 border-t border-slate-100 p-4">
            <Select value={newAccountId} onChange={(e) => setNewAccountId(e.target.value)}>
              <option value="">Pilih akun...</option>
              {leafAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} — {a.name}
                </option>
              ))}
            </Select>
            <Select value={newSide} onChange={(e) => setNewSide(e.target.value as PresetSide)}>
              <option value="debit">Debit</option>
              <option value="credit">Kredit</option>
            </Select>
            <Input
              placeholder="Keterangan (opsional)"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
            />
            <Button type="button" variant="secondary" onClick={handleAddLine} disabled={busy}>
              + Baris
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
