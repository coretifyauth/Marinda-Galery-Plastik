"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { getLeafAccounts, type Account } from "@/lib/accounts/schema";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";

type LedgerLine = {
  id: string;
  debit: number;
  credit: number;
  journal_entries: {
    entry_date: string;
    description: string | null;
    source_ref: string;
  };
};

export default function GeneralLedgerPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [lines, setLines] = useState<LedgerLine[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingLines, setLoadingLines] = useState(false);

  const leafAccounts = getLeafAccounts(accounts);
  const selectedAccount = accounts.find((a) => a.id === selectedAccountId) ?? null;

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) {
        router.replace("/login");
        return;
      }
      const { data } = await supabase
        .from("accounts")
        .select("id, code, name, category, normal_balance, parent_id, archived_at")
        .order("code");
      if (!active) return;
      setAccounts((data ?? []) as Account[]);
      setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router]);

  const loadLedger = useCallback(async (accountId: string) => {
    setLoadingLines(true);
    const { data, error } = await supabase
      .from("journal_lines")
      .select("id, debit, credit, journal_entries(entry_date, description, source_ref)")
      .eq("account_id", accountId);
    setLoadingLines(false);
    if (error) {
      setLoadError(error.message);
      return;
    }
    setLoadError(null);
    setLines((data ?? []) as unknown as LedgerLine[]);
  }, []);

  useEffect(() => {
    if (!selectedAccountId) {
      return;
    }
    Promise.resolve().then(() => loadLedger(selectedAccountId));
  }, [selectedAccountId, loadLedger]);

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  const sortedLines = [...lines].sort((a, b) =>
    a.journal_entries.entry_date.localeCompare(b.journal_entries.entry_date)
  );

  const isDebitNormal = selectedAccount?.normal_balance === "debit";
  const rows = sortedLines.reduce<(LedgerLine & { running: number })[]>((acc, line) => {
    const prevRunning = acc.length > 0 ? acc[acc.length - 1].running : 0;
    const delta = isDebitNormal ? line.debit - line.credit : line.credit - line.debit;
    return [...acc, { ...line, running: prevRunning + delta }];
  }, []);

  return (
    <div className="flex w-full max-w-4xl flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">General Ledger — CV Roti Barokah</h1>
        <p className="text-sm text-slate-500">Histori transaksi + saldo berjalan per akun.</p>
      </div>

      <div className="flex flex-col gap-1.5 sm:w-80">
        <Label htmlFor="account">Pilih akun</Label>
        <Select
          id="account"
          value={selectedAccountId}
          onChange={(e) => setSelectedAccountId(e.target.value)}
        >
          <option value="">-- pilih akun --</option>
          {leafAccounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.code} — {a.name}
            </option>
          ))}
        </Select>
      </div>

      {loadError && <p className="text-sm text-red-600">{loadError}</p>}

      {selectedAccount && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
                <th className="px-4 py-2">Tanggal</th>
                <th className="px-4 py-2">Deskripsi</th>
                <th className="px-4 py-2">Source Ref</th>
                <th className="px-4 py-2 text-right">Debit</th>
                <th className="px-4 py-2 text-right">Kredit</th>
                <th className="px-4 py-2 text-right">Saldo Berjalan</th>
              </tr>
            </thead>
            <tbody>
              {loadingLines && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                    Memuat...
                  </td>
                </tr>
              )}
              {!loadingLines && rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                    Belum ada transaksi buat akun ini.
                  </td>
                </tr>
              )}
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="whitespace-nowrap px-4 py-2">
                    {row.journal_entries.entry_date}
                  </td>
                  <td className="px-4 py-2">{row.journal_entries.description}</td>
                  <td className="px-4 py-2">{row.journal_entries.source_ref}</td>
                  <td className="px-4 py-2 text-right font-mono">
                    {row.debit > 0 ? row.debit.toLocaleString("id-ID") : ""}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    {row.credit > 0 ? row.credit.toLocaleString("id-ID") : ""}
                  </td>
                  <td className="px-4 py-2 text-right font-mono font-medium">
                    {row.running.toLocaleString("id-ID")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
