"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { depositStatus, type ApDeposit } from "@/lib/ap-deposits/schema";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { DetailRows } from "@/components/ui/detail-rows";
import { Tabs, type TabDef } from "@/components/ui/tabs";
import { LoadingScreen } from "@/components/ui/loading-screen";

type JournalEntryDetail = {
  id: string;
  entry_date: string;
  description: string | null;
  source_ref: string;
  reverses_entry_id: string | null;
  journal_lines: { id: string; debit: number; credit: number; accounts: { code: string; name: string } }[];
};

const statusLabel: Record<string, string> = {
  belum_dipakai: "Belum Dipakai",
  sebagian: "Sebagian Terpakai",
  selesai: "Selesai",
};

const statusStyle: Record<string, string> = {
  belum_dipakai: "bg-slate-100 text-slate-600",
  sebagian: "bg-amber-50 text-amber-700",
  selesai: "bg-emerald-50 text-emerald-700",
};

export function ApDepositDetailView({ id }: { id: string }) {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [deposit, setDeposit] = useState<ApDeposit | null>(null);
  const [reversedEntryIds, setReversedEntryIds] = useState<Set<string>>(new Set());
  const [journalEntries, setJournalEntries] = useState<JournalEntryDetail[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("jurnal");

  const load = useCallback(async () => {
    const { data: dep, error: depErr } = await supabase
      .from("deposits")
      .select(
        "id, supplier_id:counterparty_id, deposit_date, source_ref, amount, journal_entry_id, created_at, counterparties(name), ap_deposit_applications:deposit_applications(id, amount, source_ref, journal_entry_id, ap_bills:transactions(source_ref)), ap_deposit_refunds:deposit_refunds(id, amount, refund_date, source_ref, journal_entry_id), ap_deposit_forfeitures:deposit_forfeitures(id, amount, forfeiture_date, source_ref, journal_entry_id)"
      )
      .eq("id", id)
      .eq("type", "INBOUND")
      .single();
    if (depErr || !dep) {
      setLoadError(depErr?.message ?? "Deposit gak ditemukan.");
      return;
    }
    const loadedDeposit = dep as unknown as ApDeposit;
    setDeposit(loadedDeposit);

    const [{ data: reversedRows }, { data: entries, error: entriesErr }] = await Promise.all([
      supabase
        .from("journal_entries")
        .select("reverses_entry_id")
        .not("reverses_entry_id", "is", null),
      supabase
        .from("journal_entries")
        .select(
          "id, entry_date, description, source_ref, reverses_entry_id, journal_lines(id, debit, credit, accounts(code, name))"
        )
        .or(`id.eq.${loadedDeposit.journal_entry_id},reverses_entry_id.eq.${loadedDeposit.journal_entry_id}`)
        .order("entry_date"),
    ]);

    setReversedEntryIds(
      new Set(((reversedRows ?? []) as { reverses_entry_id: string }[]).map((r) => r.reverses_entry_id))
    );
    setJournalEntries((entries ?? []) as unknown as JournalEntryDetail[]);
    setLoadError(entriesErr?.message ?? null);
  }, [id]);

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

  if (!deposit) {
    return <FormError>{loadError ?? "Deposit gak ditemukan."}</FormError>;
  }

  const { status, applied, refunded, forfeited, remaining } = depositStatus(deposit, reversedEntryIds);
  const canWrite = roles.includes("admin") || roles.includes("accountant");
  const canSpend = canWrite && remaining > 0.005;
  const activeApplications = deposit.ap_deposit_applications.filter(
    (a) => !reversedEntryIds.has(a.journal_entry_id)
  );
  const reversedApplications = deposit.ap_deposit_applications.filter((a) =>
    reversedEntryIds.has(a.journal_entry_id)
  );

  const detailGroups = [
    {
      title: "Informasi Deposit",
      rows: [
        { label: "Supplier", value: deposit.counterparties.name },
        { label: "Rujukan Dokumen", value: deposit.source_ref },
        { label: "Tanggal Deposit", value: deposit.deposit_date },
        {
          label: "Status",
          value: <span className={`rounded-full px-2 py-0.5 text-xs ${statusStyle[status]}`}>{statusLabel[status]}</span>,
        },
      ],
    },
    {
      title: "Ringkasan",
      rows: [
        { label: "Jumlah Deposit", value: deposit.amount.toLocaleString("id-ID") },
        { label: "Diterapkan", value: applied.toLocaleString("id-ID") },
        { label: "Direfund", value: refunded.toLocaleString("id-ID") },
        { label: "Hangus", value: forfeited.toLocaleString("id-ID") },
        { label: "Sisa", value: remaining.toLocaleString("id-ID") },
      ],
    },
  ];

  const tabs: TabDef[] = [
    { key: "jurnal", label: "Jurnal", badge: journalEntries.length },
    { key: "applications", label: "Diterapkan ke Bill", badge: deposit.ap_deposit_applications.length },
    { key: "refund", label: "Refund Tunai", badge: deposit.ap_deposit_refunds.length },
    { key: "hangus", label: "Hangus", badge: deposit.ap_deposit_forfeitures.length },
  ];

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/ap-deposits" label="Kembali ke Uang Muka AP" />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-black">Detail Uang Muka AP</h1>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-sm font-mono text-slate-600">
            {deposit.source_ref}
          </span>
        </div>
      </div>

      {loadError && <FormError>{loadError}</FormError>}

      <DetailRows groups={detailGroups} />

      <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} />

      {activeTab === "jurnal" && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
                <th className="px-4 py-2">Tanggal</th>
                <th className="px-4 py-2">Deskripsi</th>
                <th className="px-4 py-2">Rujukan Dokumen</th>
                <th className="px-4 py-2">Baris</th>
              </tr>
            </thead>
            <tbody>
              {journalEntries.map((entry) => (
                <tr key={entry.id} className="border-b border-slate-100 align-top hover:bg-slate-50">
                  <td className="whitespace-nowrap px-4 py-2">{entry.entry_date}</td>
                  <td className="px-4 py-2">
                    {entry.description}
                    {entry.reverses_entry_id && (
                      <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700">
                        Pembalikan
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
                </tr>
              ))}
              {journalEntries.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-slate-400">
                    Belum ada jurnal.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === "applications" && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
                <th className="px-4 py-2">Rujukan Dokumen</th>
                <th className="px-4 py-2">Bill</th>
                <th className="px-4 py-2 text-right">Nominal</th>
                <th className="px-4 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {activeApplications.map((a) => (
                <tr key={a.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2">{a.source_ref}</td>
                  <td className="px-4 py-2">{a.ap_bills.source_ref}</td>
                  <td className="px-4 py-2 text-right font-mono">{a.amount.toLocaleString("id-ID")}</td>
                  <td className="px-4 py-2">
                    <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">Aktif</span>
                  </td>
                </tr>
              ))}
              {reversedApplications.map((a) => (
                <tr key={a.id} className="border-b border-slate-100 text-slate-400 hover:bg-slate-50">
                  <td className="px-4 py-2 line-through">{a.source_ref}</td>
                  <td className="px-4 py-2 line-through">{a.ap_bills.source_ref}</td>
                  <td className="px-4 py-2 text-right font-mono line-through">
                    {a.amount.toLocaleString("id-ID")}
                  </td>
                  <td className="px-4 py-2">
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
                      Dibatalkan (bill-nya dibatalkan)
                    </span>
                  </td>
                </tr>
              ))}
              {deposit.ap_deposit_applications.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-slate-400">
                    Belum pernah diterapkan.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === "refund" && (
        <div className="flex flex-col gap-3">
          {canSpend && (
            <div className="flex justify-end">
              <Button variant="toolbar" onClick={() => router.push(`/ap-deposits/${id}/refund`)}>
                Refund Tunai
              </Button>
            </div>
          )}
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
                  <th className="px-4 py-2">Tanggal</th>
                  <th className="px-4 py-2">Rujukan Dokumen</th>
                  <th className="px-4 py-2 text-right">Nominal</th>
                </tr>
              </thead>
              <tbody>
                {deposit.ap_deposit_refunds.map((r) => (
                  <tr key={r.id} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="whitespace-nowrap px-4 py-2">{r.refund_date}</td>
                    <td className="px-4 py-2">{r.source_ref}</td>
                    <td className="px-4 py-2 text-right font-mono">{r.amount.toLocaleString("id-ID")}</td>
                  </tr>
                ))}
                {deposit.ap_deposit_refunds.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-4 py-6 text-center text-slate-400">
                      Belum pernah direfund.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === "hangus" && (
        <div className="flex flex-col gap-3">
          {canSpend && (
            <div className="flex justify-end">
              <Button variant="toolbar" onClick={() => router.push(`/ap-deposits/${id}/hangus`)}>
                Hanguskan
              </Button>
            </div>
          )}
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
                  <th className="px-4 py-2">Tanggal</th>
                  <th className="px-4 py-2">Rujukan Dokumen</th>
                  <th className="px-4 py-2 text-right">Nominal</th>
                </tr>
              </thead>
              <tbody>
                {deposit.ap_deposit_forfeitures.map((f) => (
                  <tr key={f.id} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="whitespace-nowrap px-4 py-2">{f.forfeiture_date}</td>
                    <td className="px-4 py-2">{f.source_ref}</td>
                    <td className="px-4 py-2 text-right font-mono">{f.amount.toLocaleString("id-ID")}</td>
                  </tr>
                ))}
                {deposit.ap_deposit_forfeitures.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-4 py-6 text-center text-slate-400">
                      Belum pernah hangus.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
