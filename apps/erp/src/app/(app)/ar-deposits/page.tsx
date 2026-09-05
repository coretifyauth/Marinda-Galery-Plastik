"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import type { Customer } from "@/lib/customers/schema";
import { createArDepositSchema, type ArDepositStatus, type CreateArDepositInput } from "@/lib/ar-deposits/schema";
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS, useArDeposits } from "@/lib/ar-deposits/queries";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { Modal } from "@/components/ui/modal";
import { LockedAccountField } from "@/components/ui/locked-account-field";
import { JournalPreviewPanel } from "@/components/ui/journal-preview-panel";
import { CashMethodField, resolveCashAccount, type CashMethod } from "@/components/ui/cash-method-field";
import { Pagination } from "@/components/ui/pagination";
import { fetchDefaultAccounts, type ResolvedAccount } from "@/lib/default-accounts/schema";

// Input kecil buat baris filter di header tabel -- Input/Select biasa terlalu besar buat
// muat di dalam <th>, jadi dibikin versi compact lokal (pola sama journal-entries/page.tsx).
const compactFilterInputClass =
  "w-full rounded border border-slate-200 bg-white px-1.5 py-1 text-xs font-normal normal-case text-slate-700 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-1 focus:ring-blue-600/40";
const compactFilterSelectClass = compactFilterInputClass;

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

export default function ArDepositsPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [checkingSession, setCheckingSession] = useState(true);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [roles, setRoles] = useState<string[]>([]);

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [refSearchInput, setRefSearchInput] = useState("");
  const [customerFilter, setCustomerFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<ArDepositStatus | "">("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const debouncedRefSearch = useDebouncedValue(refSearchInput, 300);

  const [customerId, setCustomerId] = useState("");
  const [depositDate, setDepositDate] = useState("");
  const [amount, setAmount] = useState("");
  const [cashMethod, setCashMethod] = useState<CashMethod>("TUNAI");
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  // Filter berubah -> balik ke halaman 1 (pola "adjust state during render", lihat
  // journal-entries/page.tsx -- BUKAN useEffect, biar gak kena lint react-hooks/set-state-in-effect).
  const filterKey = `${dateFrom}|${dateTo}|${debouncedRefSearch}|${customerFilter}|${statusFilter}|${pageSize}`;
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey);
  if (filterKey !== prevFilterKey) {
    setPrevFilterKey(filterKey);
    setPage(0);
  }

  const filters = {
    dateFrom,
    dateTo,
    sourceRefSearch: debouncedRefSearch,
    customerId: customerFilter,
    status: statusFilter,
    page,
    pageSize,
  };
  const depositsQuery = useArDeposits(filters);
  const deposits = depositsQuery.data?.rows ?? [];
  const total = depositsQuery.data?.total ?? 0;

  const loadCustomers = useCallback(async () => {
    const { data } = await supabase
      .from("counterparties")
      .select("id, name, contact, payment_term_days, archived_at, counterparty_type_mapping!inner(role)")
      .eq("counterparty_type_mapping.role", "customer")
      .order("name");
    setCustomers((data ?? []) as unknown as Customer[]);
  }, []);

  const loadDefaultAccounts = useCallback(async () => {
    setDefaultAccounts(await fetchDefaultAccounts());
  }, []);

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
      await Promise.all([loadCustomers(), loadDefaultAccounts()]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadCustomers, loadDefaultAccounts]);

  const createMutation = useMutation({
    mutationFn: async (input: CreateArDepositInput) => {
      const sourceRef = await generateDocumentNumber("ar_deposits");
      const { error } = await supabase.rpc("create_deposit", {
        p_type: "INBOUND",
        p_counterparty_id: input.customer_id,
        p_deposit_date: input.deposit_date,
        p_source_ref: sourceRef,
        p_amount: input.amount,
        p_cash_account_id: input.cash_account_id,
        p_deposit_account_id: input.deposit_liability_account_id,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      setCustomerId("");
      setDepositDate("");
      setAmount("");
      setCashMethod("TUNAI");
      setShowForm(false);
      queryClient.invalidateQueries({ queryKey: ["ar_deposits"] });
    },
    onError: (err) => {
      setFormError(err instanceof Error ? err.message : "Gagal menyimpan deposit");
    },
  });

  function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const parsed = createArDepositSchema.safeParse({
      customer_id: customerId,
      deposit_date: depositDate,
      amount,
      cash_account_id: resolveCashAccount(cashMethod, defaultAccounts)?.id ?? "",
      deposit_liability_account_id: defaultAccounts["ar.deposit_liability"]?.id ?? "",
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    createMutation.mutate(parsed.data);
  }

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">AR Deposits (Uang Muka)</h1>
        <p className="text-sm text-slate-500">
          Role kamu:{" "}
          {roles.length > 0 ? roles.join(", ") : "belum ada role — cuma bisa lihat"}
        </p>
      </div>

      {depositsQuery.error && <FormError>{(depositsQuery.error as Error).message}</FormError>}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-black">AR Deposits</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
              {total}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="toolbar" onClick={() => depositsQuery.refetch()}>
              Refresh
            </Button>
            {canWrite && (
              <Button variant="toolbar-primary" onClick={() => setShowForm(true)}>
                + New
              </Button>
            )}
          </div>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Customer</th>
              <th className="px-4 py-2">Tanggal</th>
              <th className="px-4 py-2">Source Ref</th>
              <th className="px-4 py-2 text-right">Jumlah</th>
              <th className="px-4 py-2 text-right">Sisa</th>
              <th className="px-4 py-2">Status</th>
            </tr>
            <tr className="border-b border-slate-200 bg-slate-50/50">
              <th className="px-4 py-1.5">
                <select
                  aria-label="Filter customer"
                  value={customerFilter}
                  onChange={(e) => setCustomerFilter(e.target.value)}
                  className={compactFilterSelectClass}
                >
                  <option value="">Semua customer</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </th>
              <th className="px-4 py-1.5">
                <div className="flex gap-1">
                  <input
                    type="date"
                    aria-label="Dari tanggal"
                    value={dateFrom}
                    onChange={(e) => setDateFrom(e.target.value)}
                    className={compactFilterInputClass}
                  />
                  <input
                    type="date"
                    aria-label="Sampai tanggal"
                    value={dateTo}
                    onChange={(e) => setDateTo(e.target.value)}
                    className={compactFilterInputClass}
                  />
                </div>
              </th>
              <th className="px-4 py-1.5">
                <input
                  type="text"
                  placeholder="Cari source ref..."
                  value={refSearchInput}
                  onChange={(e) => setRefSearchInput(e.target.value)}
                  className={compactFilterInputClass}
                />
              </th>
              <th className="px-4 py-1.5" />
              <th className="px-4 py-1.5" />
              <th className="px-4 py-1.5">
                <select
                  aria-label="Filter status"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as ArDepositStatus | "")}
                  className={compactFilterSelectClass}
                >
                  <option value="">Semua status</option>
                  <option value="belum_dipakai">{statusLabel.belum_dipakai}</option>
                  <option value="sebagian">{statusLabel.sebagian}</option>
                  <option value="selesai">{statusLabel.selesai}</option>
                </select>
              </th>
            </tr>
          </thead>
          <tbody>
            {deposits.map((dep) => (
              <tr
                key={dep.id}
                className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                onClick={() => router.push(`/ar-deposits/${dep.id}`)}
              >
                <td className="px-4 py-2 font-medium text-black">{dep.counterparties.name}</td>
                <td className="whitespace-nowrap px-4 py-2">{dep.deposit_date}</td>
                <td className="px-4 py-2">{dep.source_ref}</td>
                <td className="px-4 py-2 text-right font-mono">
                  {dep.amount.toLocaleString("id-ID")}
                </td>
                <td className="px-4 py-2 text-right font-mono">
                  {dep.remaining.toLocaleString("id-ID")}
                </td>
                <td className="px-4 py-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs ${statusStyle[dep.status]}`}>
                    {statusLabel[dep.status]}
                  </span>
                </td>
              </tr>
            ))}
            {deposits.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                  {depositsQuery.isLoading ? "Memuat..." : "Belum ada deposit."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={setPage}
          pageSizeOptions={PAGE_SIZE_OPTIONS}
          onPageSizeChange={setPageSize}
        />
      </div>

      <Modal open={showForm} onClose={() => setShowForm(false)} title="Terima Uang Muka" maxWidth="max-w-xl">
        {!canWrite && (
          <p className="mb-4 text-sm text-amber-600">
            Kamu belum punya role admin/accountant — submit di bawah kemungkinan bakal
            ketolak RLS.
          </p>
        )}
        <JournalPreviewPanel
          groups={[
            [
              {
                label: "Akun Kas/Bank (debit)",
                resolved: resolveCashAccount(cashMethod, defaultAccounts),
                side: "debit",
              },
              {
                label: "Akun Uang Muka Penjualan (kredit)",
                resolved: defaultAccounts["ar.deposit_liability"],
                side: "credit",
              },
            ],
          ]}
        />
        <form onSubmit={handleCreate} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="customer">Customer</Label>
            <Select id="customer" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">Pilih customer...</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="deposit_date">Tanggal</Label>
              <Input
                id="deposit_date"
                type="date"
                value={depositDate}
                onChange={(e) => setDepositDate(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="amount">Jumlah</Label>
              <Input
                id="amount"
                type="number"
                min="0"
                placeholder="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
          </div>
          <CashMethodField
            label="Akun Kas/Bank (debit)"
            htmlFor="cash_account"
            method={cashMethod}
            onChange={setCashMethod}
            defaultAccounts={defaultAccounts}
          />
          <LockedAccountField
            label="Akun Uang Muka Penjualan (kredit)"
            htmlFor="deposit_liability_account"
            resolved={defaultAccounts["ar.deposit_liability"]}
          />

          {formError && <FormError>{formError}</FormError>}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setShowForm(false)}>
              Batal
            </Button>
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? "Menyimpan..." : "Simpan Deposit"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
