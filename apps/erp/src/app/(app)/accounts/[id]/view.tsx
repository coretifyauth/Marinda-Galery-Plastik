"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { type Account } from "@/lib/accounts/schema";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";

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

export function AccountDetailView({ id }: { id: string }) {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [account, setAccount] = useState<Account | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [lines, setLines] = useState<LedgerLine[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<"detail" | "ledger">("detail");

  const load = useCallback(async () => {
    const [{ data: acc, error: accErr }, { data: allAccounts }, { data: ledgerLines, error: ledgerErr }] =
      await Promise.all([
        supabase
          .from("accounts")
          .select("id, code, name, category, normal_balance, is_contra, parent_id, archived_at")
          .eq("id", id)
          .single(),
        supabase
          .from("accounts")
          .select("id, code, name, category, normal_balance, is_contra, parent_id, archived_at"),
        supabase
          .from("journal_lines")
          .select("id, debit, credit, journal_entries(entry_date, description, source_ref)")
          .eq("account_id", id),
      ]);
    if (accErr) {
      setLoadError(accErr.message);
      return;
    }
    setLoadError(ledgerErr?.message ?? null);
    setAccount(acc as Account);
    setAccounts((allAccounts ?? []) as Account[]);
    setLines((ledgerLines ?? []) as unknown as LedgerLine[]);
  }, [id]);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) {
        router.replace("/login");
        return;
      }
      await load();
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, load]);

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  if (!account) {
    return <FormError>{loadError ?? "Akun gak ditemukan."}</FormError>;
  }

  const parent = accounts.find((a) => a.id === account.parent_id) ?? null;
  const isPublished = lines.length > 0;

  const sortedLines = [...lines].sort((a, b) =>
    a.journal_entries.entry_date.localeCompare(b.journal_entries.entry_date)
  );
  const isDebitNormal = account.normal_balance === "debit";
  const rows = sortedLines.reduce<(LedgerLine & { running: number })[]>((acc, line) => {
    const prevRunning = acc.length > 0 ? acc[acc.length - 1].running : 0;
    const delta = isDebitNormal ? line.debit - line.credit : line.credit - line.debit;
    return [...acc, { ...line, running: prevRunning + delta }];
  }, []);
  const finalBalance = rows.length > 0 ? rows[rows.length - 1].running : 0;

  return (
    <div className="flex w-full max-w-4xl flex-1 flex-col gap-6">
      <BackLink href="/accounts" label="Kembali ke Chart of Accounts" />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-mono text-xl font-semibold text-black">
            {account.code} — {account.name}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs capitalize text-slate-600">
              {account.category}
            </span>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs capitalize text-slate-600">
              Normal {account.normal_balance}
            </span>
            {account.is_contra && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">
                Kontra
              </span>
            )}
            {account.archived_at && (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
                Diarsipkan
              </span>
            )}
          </div>
        </div>
        <span className="font-mono text-lg font-medium text-black">
          {finalBalance.toLocaleString("id-ID")}
        </span>
      </div>

      {loadError && <FormError>{loadError}</FormError>}

      <div className="flex gap-1 border-b border-slate-200">
        {(["detail", "ledger"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-2 text-sm font-medium capitalize ${
              tab === t
                ? "border-b-2 border-blue-600 text-blue-700"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            {t === "detail" ? "Detail" : "Ledger"}
          </button>
        ))}
      </div>

      {tab === "detail" && (
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          {isPublished && (
            <p className="mb-4 text-sm text-amber-600">
              🔒 Akun ini sudah dipakai di jurnal — code/category/normal_balance/parent_id/is_contra
              terkunci (<code>accounts_published_lock</code>). Cuma <code>name</code>/
              <code>archived_at</code> yang masih bisa diubah.
            </p>
          )}
          <dl className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-xs uppercase text-slate-400">Kode</dt>
              <dd className="font-mono text-black">{account.code}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-slate-400">Nama</dt>
              <dd className="text-black">{account.name}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-slate-400">Kategori</dt>
              <dd className="capitalize text-black">{account.category}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-slate-400">Normal Balance</dt>
              <dd className="capitalize text-black">
                {account.normal_balance}
                {account.is_contra ? " (kontra)" : ""}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-slate-400">Akun Induk</dt>
              <dd className="text-black">{parent ? `${parent.code} — ${parent.name}` : "-"}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-slate-400">Status</dt>
              <dd className="text-black">{account.archived_at ? "Diarsipkan" : "Aktif"}</dd>
            </div>
          </dl>
        </div>
      )}

      {tab === "ledger" && (
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
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                    Belum ada transaksi buat akun ini.
                  </td>
                </tr>
              )}
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="whitespace-nowrap px-4 py-2">{row.journal_entries.entry_date}</td>
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
