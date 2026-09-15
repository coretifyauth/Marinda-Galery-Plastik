"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { fetchPresets } from "@/lib/journal-presets/queries";
import type { Preset } from "@/lib/journal-presets/schema";
import { Button } from "@/components/ui/button";
import { BackLink } from "@/components/ui/back-link";
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

export default function JournalPresetsPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [roles, setRoles] = useState<string[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setPresets(await fetchPresets());
    setLoading(false);
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

  const canWrite = roles.includes("master");

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/journal-entries" label="Kembali ke Jurnal Umum" />

      <div>
        <h1 className="text-xl font-semibold text-black">Preset Jurnal</h1>
        <p className="text-sm text-slate-500">
          Jurnal Umum cuma bisa diposting lewat preset — akun & sisi (debit/kredit) tiap baris
          terkunci di sini, gak bisa dipilih bebas lagi pas posting.{" "}
          {!canWrite && "Cuma role master yang bisa bikin/ubah preset — kamu cuma bisa lihat."}
        </p>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-black">Daftar Preset</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
              {presets.length}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="toolbar" onClick={load}>
              Muat Ulang
            </Button>
            {canWrite && (
              <Button
                variant="toolbar-primary"
                onClick={() => router.push("/journal-entries/presets/new")}
              >
                + Tambah Preset
              </Button>
            )}
          </div>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Label</th>
              <th className="px-4 py-2">Baris</th>
              <th className="px-4 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {presets.map((p) => (
              <tr
                key={p.id}
                className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                onClick={() => router.push(`/journal-entries/presets/${p.id}`)}
              >
                <td className="px-4 py-2">{p.label}</td>
                <td className="px-4 py-2 text-slate-500">
                  {p.app_preset_journal_entry_lines.length} baris (
                  {p.app_preset_journal_entry_lines.filter((l) => l.side === "debit").length} debit /{" "}
                  {p.app_preset_journal_entry_lines.filter((l) => l.side === "credit").length} kredit)
                </td>
                <td className="px-4 py-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs ${statusBadge[p.status]}`}>
                    {statusLabel[p.status]}
                  </span>
                </td>
              </tr>
            ))}
            {!loading && presets.length === 0 && (
              <tr>
                <td colSpan={3} className="py-6 text-center text-slate-400">
                  Belum ada preset.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
