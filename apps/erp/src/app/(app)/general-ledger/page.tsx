"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { getLeafAccounts, type Account } from "@/lib/accounts/schema";
import {
  DEFAULT_LEDGER_PAGE_SIZE,
  LEDGER_PAGE_SIZE_OPTIONS,
  fetchAccountLedgerPage,
  type LedgerLine,
  type LedgerPage,
} from "@/lib/reports/ledger";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { FormHint } from "@/components/ui/form-message";
import { Pagination } from "@/components/ui/pagination";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const EMPTY_LEDGER_PAGE: LedgerPage = { rows: [], total: 0, openingBalance: { debit: 0, credit: 0 } };

export default function GeneralLedgerPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [asOfDate, setAsOfDate] = useState(today());
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_LEDGER_PAGE_SIZE);
  const [ledgerPage, setLedgerPage] = useState<LedgerPage>(EMPTY_LEDGER_PAGE);
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

  const loadLedger = useCallback(
    async (accountId: string, asOf: string, pageArg: number, pageSizeArg: number) => {
      setLoadingLines(true);
      try {
        const result = await fetchAccountLedgerPage(accountId, asOf, pageArg, pageSizeArg);
        setLedgerPage(result);
        setLoadError(null);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : "Gagal memuat ledger");
      } finally {
        setLoadingLines(false);
      }
    },
    []
  );

  useEffect(() => {
    if (!selectedAccountId) {
      return;
    }
    Promise.resolve().then(() => {
      setPage(0);
      loadLedger(selectedAccountId, asOfDate, 0, pageSize);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAccountId, loadLedger]);

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  const isDebitNormal = selectedAccount?.normal_balance === "debit";
  const openingNet = isDebitNormal
    ? ledgerPage.openingBalance.debit - ledgerPage.openingBalance.credit
    : ledgerPage.openingBalance.credit - ledgerPage.openingBalance.debit;
  const rows = ledgerPage.rows.reduce<(LedgerLine & { running: number })[]>((acc, line) => {
    const prevRunning = acc.length > 0 ? acc[acc.length - 1].running : openingNet;
    const delta = isDebitNormal ? line.debit - line.credit : line.credit - line.debit;
    return [...acc, { ...line, running: prevRunning + delta }];
  }, []);

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">General Ledger</h1>
        <p className="text-sm text-slate-500">Histori transaksi + saldo berjalan per akun.</p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
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

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="as_of_date">Sampai Tanggal</Label>
          <Input
            id="as_of_date"
            type="date"
            value={asOfDate}
            onChange={(e) => {
              setAsOfDate(e.target.value);
              setPage(0);
              if (selectedAccountId) loadLedger(selectedAccountId, e.target.value, 0, pageSize);
            }}
          />
        </div>
      </div>

      <FormHint>
        Transaksi bertanggal setelah &quot;Sampai Tanggal&quot; disembunyikan dari daftar dan saldo
        berjalan di bawah — samakan dengan filter yang dipakai Trial Balance/Balance Sheet.
      </FormHint>

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
          <Pagination
            page={page}
            pageSize={pageSize}
            total={ledgerPage.total}
            onPageChange={(newPage) => {
              setPage(newPage);
              loadLedger(selectedAccountId, asOfDate, newPage, pageSize);
            }}
            pageSizeOptions={LEDGER_PAGE_SIZE_OPTIONS}
            onPageSizeChange={(newSize) => {
              setPageSize(newSize);
              setPage(0);
              loadLedger(selectedAccountId, asOfDate, 0, newSize);
            }}
          />
        </div>
      )}
    </div>
  );
}
