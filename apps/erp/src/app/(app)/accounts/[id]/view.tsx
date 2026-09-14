"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { type Account } from "@/lib/accounts/schema";
import { fetchLinesUpTo } from "@/lib/reports/balances";
import { formatCreatedBy } from "@/lib/created-by";
import {
  DEFAULT_LEDGER_PAGE_SIZE,
  LEDGER_PAGE_SIZE_OPTIONS,
  fetchAccountLedgerPage,
  type LedgerLine,
  type LedgerPage,
} from "@/lib/reports/ledger";
import { FormError, FormHint } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { Button } from "@/components/ui/button";
import { DetailRows } from "@/components/ui/detail-rows";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Pagination } from "@/components/ui/pagination";
import { LoadingScreen } from "@/components/ui/loading-screen";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const EMPTY_LEDGER_PAGE: LedgerPage = { rows: [], total: 0, openingBalance: { debit: 0, credit: 0 } };

export function AccountDetailView({ id }: { id: string }) {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [account, setAccount] = useState<Account | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [asOfDate, setAsOfDate] = useState(today());
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_LEDGER_PAGE_SIZE);
  const [ledgerPage, setLedgerPage] = useState<LedgerPage>(EMPTY_LEDGER_PAGE);
  const [loadingLedger, setLoadingLedger] = useState(false);
  const [endingBalance, setEndingBalance] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ledgerError, setLedgerError] = useState<string | null>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [isPublished, setIsPublished] = useState(false);

  const load = useCallback(
    async (asOf: string) => {
      try {
        const [{ data: acc, error: accErr }, { data: allAccounts }, balances, { count: anyLinesCount }] =
          await Promise.all([
            supabase
              .from("accounts")
              .select(
                "id, code, name, category, normal_balance, is_contra, parent_id, archived_at, created_by, created_at"
              )
              .eq("id", id)
              .single(),
            supabase
              .from("accounts")
              .select("id, code, name, category, normal_balance, is_contra, parent_id, archived_at"),
            // Saldo Akhir — dihitung independen dari halaman Ledger yang lagi ditampilkan
            // (`fetchAccountLedgerPage` di bawah cuma narik 1 halaman transaksi), lewat RPC
            // agregat yang sama dipakai Trial Balance (`memory/scope-debt/journal-lines-unbounded-aggregate.md`).
            fetchLinesUpTo(asOf),
            // Lock status (`accounts_published_lock`) gak boleh ikut kefilter tanggal — akun yang
            // baru dipakai di transaksi bertanggal masa depan tetap harus terkunci sekarang juga.
            supabase.from("journal_lines").select("id", { count: "exact", head: true }).eq("account_id", id),
          ]);
        if (accErr) {
          setLoadError(accErr.message);
          return;
        }
        setLoadError(null);
        setAccount(acc as Account);
        setAccounts((allAccounts ?? []) as Account[]);
        setIsPublished((anyLinesCount ?? 0) > 0);

        const isDebitNormal = (acc as Account | null)?.normal_balance === "debit";
        const balanceRow = balances.find((b) => b.account_id === id);
        const netBalance = balanceRow
          ? isDebitNormal
            ? balanceRow.debit - balanceRow.credit
            : balanceRow.credit - balanceRow.debit
          : 0;
        setEndingBalance(netBalance);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : "Gagal memuat akun");
      }
    },
    [id]
  );

  const loadLedgerPage = useCallback(
    async (asOf: string, pageArg: number, pageSizeArg: number) => {
      setLoadingLedger(true);
      try {
        const result = await fetchAccountLedgerPage(id, asOf, pageArg, pageSizeArg);
        setLedgerPage(result);
        setLedgerError(null);
      } catch (err) {
        setLedgerError(err instanceof Error ? err.message : "Gagal memuat ledger");
      } finally {
        setLoadingLedger(false);
      }
    },
    [id]
  );

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
      await Promise.all([load(asOfDate), loadLedgerPage(asOfDate, 0, pageSize)]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, load, loadLedgerPage]);

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
    await load(asOfDate);
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
    await load(asOfDate);
  }

  if (checkingSession) {
    return <LoadingScreen />;
  }

  if (!account) {
    return <FormError>{loadError ?? "Akun gak ditemukan."}</FormError>;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");

  const parent = accounts.find((a) => a.id === account.parent_id) ?? null;

  const isDebitNormal = account.normal_balance === "debit";
  const openingNet = isDebitNormal
    ? ledgerPage.openingBalance.debit - ledgerPage.openingBalance.credit
    : ledgerPage.openingBalance.credit - ledgerPage.openingBalance.debit;
  const rows = ledgerPage.rows.reduce<(LedgerLine & { running: number })[]>((acc, line) => {
    const prevRunning = acc.length > 0 ? acc[acc.length - 1].running : openingNet;
    const delta = isDebitNormal ? line.debit - line.credit : line.credit - line.debit;
    return [...acc, { ...line, running: prevRunning + delta }];
  }, []);

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
        {
          label: "Dibuat oleh",
          value: account.created_at ? formatCreatedBy(account.created_by ?? null, account.created_at) : "-",
        },
      ],
    },
    {
      title: "Ringkasan",
      rows: [{ label: "Saldo Akhir", value: endingBalance.toLocaleString("id-ID") }],
    },
  ];

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/accounts" label="Kembali ke Chart of Accounts" />
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-black">Detail Akun</h1>
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
      {ledgerError && <FormError>{ledgerError}</FormError>}
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
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-black">Buku Besar</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
              {ledgerPage.total}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Label htmlFor="as_of_date">Sampai Tanggal</Label>
            <Input
              id="as_of_date"
              type="date"
              value={asOfDate}
              onChange={(e) => {
                const newDate = e.target.value;
                setAsOfDate(newDate);
                setPage(0);
                load(newDate);
                loadLedgerPage(newDate, 0, pageSize);
              }}
            />
          </div>
        </div>
        <FormHint>
          <span className="px-4">
            Transaksi bertanggal setelah tanggal ini disembunyikan dari Saldo Akhir & Buku Besar di bawah.
          </span>
        </FormHint>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Tanggal</th>
              <th className="px-4 py-2">Deskripsi</th>
              <th className="px-4 py-2">Rujukan Dokumen</th>
              <th className="px-4 py-2 text-right">Debit</th>
              <th className="px-4 py-2 text-right">Kredit</th>
              <th className="px-4 py-2 text-right">Saldo Berjalan</th>
            </tr>
          </thead>
          <tbody>
            {loadingLedger && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                  Memuat...
                </td>
              </tr>
            )}
            {!loadingLedger && rows.length === 0 && (
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
        <Pagination
          page={page}
          pageSize={pageSize}
          total={ledgerPage.total}
          onPageChange={(newPage) => {
            setPage(newPage);
            loadLedgerPage(asOfDate, newPage, pageSize);
          }}
          pageSizeOptions={LEDGER_PAGE_SIZE_OPTIONS}
          onPageSizeChange={(newSize) => {
            setPageSize(newSize);
            setPage(0);
            loadLedgerPage(asOfDate, 0, newSize);
          }}
        />
      </div>
    </div>
  );
}
