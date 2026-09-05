"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import type { Customer } from "@/lib/customers/schema";
import {
  createArInvoiceSchema,
  type ArInvoiceOrigin,
  type ArInvoiceStatus,
  type CreateArInvoiceInput,
} from "@/lib/ar-invoices/schema";
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS, useArInvoices } from "@/lib/ar-invoices/queries";
import type { ArInvoiceChargeType } from "@/lib/ar-invoice-charge-types/schema";
import { fetchTaxSettings, resolvedPpnKeluaran, type TaxSettings } from "@/lib/tax-settings/schema";
import { resolveChargeLines, resolveChargeLineLegs, type ChargeLineInput } from "@/lib/charge-lines/schema";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { ChargeLinesEditor } from "@/components/ui/charge-lines-editor";
import { Modal } from "@/components/ui/modal";
import { LockedAccountField } from "@/components/ui/locked-account-field";
import { JournalPreviewPanel } from "@/components/ui/journal-preview-panel";
import { Pagination } from "@/components/ui/pagination";
import { fetchDefaultAccounts, type ResolvedAccount } from "@/lib/default-accounts/schema";

// Input kecil buat baris filter di header tabel -- Input/Select biasa terlalu besar buat
// muat di dalam <th>, jadi dibikin versi compact lokal (pola sama journal-entries/page.tsx).
const compactFilterInputClass =
  "w-full rounded border border-slate-200 bg-white px-1.5 py-1 text-xs font-normal normal-case text-slate-700 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-1 focus:ring-blue-600/40";
const compactFilterSelectClass = compactFilterInputClass;

const statusStyle: Record<string, string> = {
  lunas: "bg-emerald-50 text-emerald-700",
  sebagian: "bg-amber-50 text-amber-700",
  belum: "bg-slate-100 text-slate-600",
  dibatalkan: "bg-slate-100 text-slate-400 line-through",
};

const originLabel: Record<string, string> = {
  order: "Dari Sales Order",
  goods_movement: "Goods Issue Langsung",
  financial_only: "Financial Only",
};

const originStyle: Record<string, string> = {
  order: "bg-blue-50 text-blue-700",
  goods_movement: "bg-slate-100 text-slate-600",
  financial_only: "bg-purple-50 text-purple-700",
};

export default function ArInvoicesPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [checkingSession, setCheckingSession] = useState(true);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [roles, setRoles] = useState<string[]>([]);

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [refSearchInput, setRefSearchInput] = useState("");
  const [customerFilter, setCustomerFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<ArInvoiceStatus | "">("");
  const [originFilter, setOriginFilter] = useState<ArInvoiceOrigin | "">("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const debouncedRefSearch = useDebouncedValue(refSearchInput, 300);

  const [customerId, setCustomerId] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});
  const [extraLines, setExtraLines] = useState<ChargeLineInput[]>([]);
  const [chargeTypes, setChargeTypes] = useState<ArInvoiceChargeType[]>([]);
  const [taxSettings, setTaxSettings] = useState<TaxSettings | null>(null);
  const [applyTax, setApplyTax] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  // Filter berubah -> balik ke halaman 1 (pola "adjust state during render", lihat
  // journal-entries/page.tsx -- BUKAN useEffect, biar gak kena lint react-hooks/set-state-in-effect).
  const filterKey = `${dateFrom}|${dateTo}|${debouncedRefSearch}|${customerFilter}|${statusFilter}|${originFilter}|${pageSize}`;
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
    origin: originFilter,
    page,
    pageSize,
  };
  const invoicesQuery = useArInvoices(filters);
  const invoices = invoicesQuery.data?.rows ?? [];
  const total = invoicesQuery.data?.total ?? 0;

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

  const loadChargeTypes = useCallback(async () => {
    const { data } = await supabase
      .from("ar_invoice_charge_types")
      .select("id, name, account_id, archived_at, accounts(code, name)")
      .order("name");
    setChargeTypes((data ?? []) as unknown as ArInvoiceChargeType[]);
  }, []);

  const loadTaxSettings = useCallback(async () => {
    setTaxSettings(await fetchTaxSettings());
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
      await Promise.all([
        loadCustomers(),
        loadDefaultAccounts(),
        loadChargeTypes(),
        loadTaxSettings(),
      ]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadCustomers, loadDefaultAccounts, loadChargeTypes, loadTaxSettings]);

  const createMutation = useMutation({
    mutationFn: async (input: CreateArInvoiceInput) => {
      const sourceRef = await generateDocumentNumber("ar_invoices");
      const { error } = await supabase.rpc("create_transaction", {
        p_type: "INBOUND",
        p_counterparty_id: input.customer_id,
        p_date: input.invoice_date,
        p_description: input.description || null,
        p_source_ref: sourceRef,
        p_lines: input.credit_lines,
        p_control_account_id: input.receivable_account_id,
        p_apply_tax: input.apply_tax,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      setCustomerId("");
      setInvoiceDate("");
      setDescription("");
      setAmount("");
      setExtraLines([]);
      setApplyTax(false);
      setShowForm(false);
      queryClient.invalidateQueries({ queryKey: ["ar_invoices"] });
    },
    onError: (err) => {
      setFormError(err instanceof Error ? err.message : "Gagal menyimpan invoice");
    },
  });

  function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const creditLines = [
      { account_id: defaultAccounts["ar.revenue"]?.id ?? "", amount: Number(amount) },
      ...resolveChargeLines(extraLines, chargeTypes),
    ];

    const parsed = createArInvoiceSchema.safeParse({
      customer_id: customerId,
      invoice_date: invoiceDate,
      description,
      credit_lines: creditLines,
      receivable_account_id: defaultAccounts["ar.receivable"]?.id ?? "",
      apply_tax: applyTax,
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
        <h1 className="text-xl font-semibold text-black">AR Invoices</h1>
        <p className="text-sm text-slate-500">
          Role kamu:{" "}
          {roles.length > 0 ? roles.join(", ") : "belum ada role — cuma bisa lihat"}
        </p>
      </div>

      {invoicesQuery.error && <FormError>{(invoicesQuery.error as Error).message}</FormError>}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-black">AR Invoices</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
              {total}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="toolbar" onClick={() => invoicesQuery.refetch()}>
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
              <th className="px-4 py-2">Jatuh Tempo</th>
              <th className="px-4 py-2">Source Ref</th>
              <th className="px-4 py-2">Tipe</th>
              <th className="px-4 py-2 text-right">Jumlah</th>
              <th className="px-4 py-2 text-right">Outstanding</th>
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
              <th className="px-4 py-1.5" />
              <th className="px-4 py-1.5">
                <input
                  type="text"
                  placeholder="Cari source ref..."
                  value={refSearchInput}
                  onChange={(e) => setRefSearchInput(e.target.value)}
                  className={compactFilterInputClass}
                />
              </th>
              <th className="px-4 py-1.5">
                <select
                  aria-label="Filter tipe"
                  value={originFilter}
                  onChange={(e) => setOriginFilter(e.target.value as ArInvoiceOrigin | "")}
                  className={compactFilterSelectClass}
                >
                  <option value="">Semua tipe</option>
                  <option value="order">{originLabel.order}</option>
                  <option value="goods_movement">{originLabel.goods_movement}</option>
                  <option value="financial_only">{originLabel.financial_only}</option>
                </select>
              </th>
              <th className="px-4 py-1.5" />
              <th className="px-4 py-1.5" />
              <th className="px-4 py-1.5">
                <select
                  aria-label="Filter status"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as ArInvoiceStatus | "")}
                  className={compactFilterSelectClass}
                >
                  <option value="">Semua status</option>
                  <option value="belum">Belum</option>
                  <option value="sebagian">Sebagian</option>
                  <option value="lunas">Lunas</option>
                  <option value="dibatalkan">Dibatalkan</option>
                </select>
              </th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((inv) => {
              const { status, outstanding, returned } = inv;
              const overdue =
                status !== "lunas" && status !== "dibatalkan" && inv.due_date < new Date().toISOString().slice(0, 10);
              return (
                <tr
                  key={inv.id}
                  className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                  onClick={() => router.push(`/ar-invoices/${inv.id}`)}
                >
                  <td className="px-4 py-2 font-medium text-black">{inv.counterparties.name}</td>
                  <td className="whitespace-nowrap px-4 py-2">{inv.invoice_date}</td>
                  <td className="whitespace-nowrap px-4 py-2">
                    {inv.due_date}
                    {overdue && (
                      <span className="ml-2 rounded bg-red-50 px-1.5 py-0.5 text-xs text-red-700">
                        Telat
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">{inv.source_ref}</td>
                  <td className="px-4 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs ${originStyle[inv.origin]}`}>
                      {originLabel[inv.origin]}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    {inv.amount.toLocaleString("id-ID")}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    {outstanding.toLocaleString("id-ID")}
                    {returned > 0 && (
                      <span className="ml-1 block text-xs font-normal text-amber-600">
                        retur {returned.toLocaleString("id-ID")}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs capitalize ${statusStyle[status]}`}>
                      {status}
                    </span>
                  </td>
                </tr>
              );
            })}
            {invoices.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-slate-400">
                  {invoicesQuery.isLoading ? "Memuat..." : "Belum ada invoice."}
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

      <Modal open={showForm} onClose={() => setShowForm(false)} title="Tambah AR Invoice" maxWidth="max-w-2xl">
        {!canWrite && (
          <p className="mb-4 text-sm text-amber-600">
            Kamu belum punya role admin/accountant — submit di bawah kemungkinan bakal
            ketolak RLS.
          </p>
        )}
        <JournalPreviewPanel
          groups={[
            [
              { label: "Akun Piutang Usaha (debit)", resolved: defaultAccounts["ar.receivable"], side: "debit" },
              { label: "Akun Pendapatan (kredit)", resolved: defaultAccounts["ar.revenue"], side: "credit" },
              ...resolveChargeLineLegs(extraLines, chargeTypes, "credit"),
              applyTax && {
                label: "Akun PPN Keluaran (kredit)",
                resolved: resolvedPpnKeluaran(taxSettings),
                side: "credit",
              },
            ],
          ]}
        />
        <form onSubmit={handleCreate} className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="customer">Customer</Label>
              <Select id="customer" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                <option value="">Pilih customer...</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} (net-{c.payment_term_days})
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invoice_date">Tanggal</Label>
              <Input
                id="invoice_date"
                type="date"
                value={invoiceDate}
                onChange={(e) => setInvoiceDate(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="description">Deskripsi</Label>
              <Input
                id="description"
                placeholder="mis. Kirim barang ke Warung Bu Siti"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
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
            <LockedAccountField
              label="Akun Piutang Usaha (debit)"
              htmlFor="receivable_account"
              resolved={defaultAccounts["ar.receivable"]}
            />
            <LockedAccountField
              label="Akun Pendapatan (kredit)"
              htmlFor="revenue_account"
              resolved={defaultAccounts["ar.revenue"]}
            />
          </div>

          <ChargeLinesEditor
            label="Kategori Pendapatan Tambahan (opsional — mis. jasa antar)"
            lines={extraLines}
            chargeTypes={chargeTypes}
            onChange={setExtraLines}
          />

          {taxSettings?.is_active && (
            <label className="flex w-fit items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={applyTax}
                onChange={(e) => setApplyTax(e.target.checked)}
              />
              Kena PPN Keluaran ({taxSettings.ppn_rate}%, dihitung otomatis dari subtotal)
            </label>
          )}

          {formError && <FormError>{formError}</FormError>}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setShowForm(false)}>
              Batal
            </Button>
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? "Menyimpan..." : "Simpan Invoice"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
