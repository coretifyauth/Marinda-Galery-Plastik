"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { type Account } from "@/lib/accounts/schema";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { Button } from "@/components/ui/button";
import { DetailRows } from "@/components/ui/detail-rows";

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
  const [roles, setRoles] = useState<string[]>([]);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

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
      const { data: roleRows } = await supabase
        .from("user_roles")
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

  async function handleDelete() {
    if (!account) return;
    if (!window.confirm(`Hapus akun "${account.code} — ${account.name}"?`)) return;
    setDeleteError(null);
    setDeleting(true);
    const { data, error } = await supabase.rpc("delete_account", { p_account_id: account.id });
    setDeleting(false);
    if (error) {
      setDeleteError(error.message);
      return;
    }
    if (data === "deleted") {
      router.push("/accounts");
      return;
    }
    window.alert(
      "Akun ini sudah pernah dipakai di jurnal (atau masih punya akun anak), jadi diarsipkan (bukan dihapus permanen)."
    );
    await load();
  }

  async function handleReactivate() {
    if (!account) return;
    setDeleteError(null);
    setDeleting(true);
    const { error } = await supabase.from("accounts").update({ archived_at: null }).eq("id", account.id);
    setDeleting(false);
    if (error) {
      setDeleteError(error.message);
      return;
    }
    await load();
  }

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  if (!account) {
    return <FormError>{loadError ?? "Akun gak ditemukan."}</FormError>;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");

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

  const detailGroups = [
    {
      title: "Informasi Akun",
      rows: [
        { label: "Kode", value: <span className="font-mono">{account.code}</span> },
        { label: "Nama", value: account.name },
        {
          label: "Kategori",
          value: (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs capitalize text-slate-600">
              {account.category}
            </span>
          ),
        },
        {
          label: "Normal Balance",
          value: (
            <span className="flex items-center gap-1.5 capitalize">
              {account.normal_balance}
              {account.is_contra && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">Kontra</span>
              )}
            </span>
          ),
        },
        { label: "Akun Induk", value: parent ? `${parent.code} — ${parent.name}` : "-" },
        {
          label: "Status",
          value: account.archived_at ? (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">Diarsipkan</span>
          ) : (
            "Aktif"
          ),
        },
      ],
    },
    {
      title: "Ringkasan",
      rows: [{ label: "Saldo Akhir", value: finalBalance.toLocaleString("id-ID") }],
    },
  ];

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/accounts" label="Kembali ke Chart of Accounts" />
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-black">Account Details</h1>
        {canWrite && (
          <div className="flex gap-2">
            {account.archived_at ? (
              <Button variant="toolbar" onClick={handleReactivate} disabled={deleting}>
                {deleting ? "Memproses..." : "Aktifkan"}
              </Button>
            ) : (
              <Button variant="toolbar" onClick={handleDelete} disabled={deleting}>
                {deleting ? "Memproses..." : "Hapus"}
              </Button>
            )}
          </div>
        )}
      </div>

      {loadError && <FormError>{loadError}</FormError>}
      {deleteError && <FormError>{deleteError}</FormError>}

      {isPublished && (
        <p className="text-sm text-amber-600">
          🔒 Akun ini sudah dipakai di jurnal — code/category/normal_balance/parent_id/is_contra
          terkunci (<code>accounts_published_lock</code>). Cuma <code>name</code>/
          <code>archived_at</code> yang masih bisa diubah.
        </p>
      )}

      <DetailRows groups={detailGroups} />

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-4 py-2">
          <span className="text-sm font-medium text-black">Ledger</span>
          <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">{rows.length}</span>
        </div>
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
                <td className="px-4 py-2 text-right font-mono font-medium">{row.running.toLocaleString("id-ID")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
