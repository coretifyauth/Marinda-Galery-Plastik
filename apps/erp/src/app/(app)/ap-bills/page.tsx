"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import type { Supplier } from "@/lib/suppliers/schema";
import { createApBillSchema, type ApBillOrigin, type ApBillStatus, type CreateApBillInput } from "@/lib/ap-bills/schema";
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS, useApBills } from "@/lib/ap-bills/queries";
import type { ApBillExpenseCategory } from "@/lib/ap-bill-expense-categories/schema";
import { fetchTaxSettings, resolvedPpnMasukan, type TaxSettings } from "@/lib/tax-settings/schema";
import {
  resolveChargeLines,
  resolveCategoryLeg,
  resolveChargeLineLegs,
  type ChargeLineInput,
} from "@/lib/charge-lines/schema";
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
  order: "Dari Purchase Order",
  goods_movement: "Terima Barang Langsung",
  financial_only: "Bill Langsung",
};

const originStyle: Record<string, string> = {
  order: "bg-blue-50 text-blue-700",
  goods_movement: "bg-slate-100 text-slate-600",
  financial_only: "bg-purple-50 text-purple-700",
};

export default function ApBillsPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [checkingSession, setCheckingSession] = useState(true);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [roles, setRoles] = useState<string[]>([]);

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [refSearchInput, setRefSearchInput] = useState("");
  const [supplierDocRefSearchInput, setSupplierDocRefSearchInput] = useState("");
  const [supplierFilter, setSupplierFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<ApBillStatus | "">("");
  const [originFilter, setOriginFilter] = useState<ApBillOrigin | "">("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const debouncedRefSearch = useDebouncedValue(refSearchInput, 300);
  const debouncedSupplierDocRefSearch = useDebouncedValue(supplierDocRefSearchInput, 300);

  const [supplierId, setSupplierId] = useState("");
  const [billDate, setBillDate] = useState("");
  const [description, setDescription] = useState("");
  const [supplierDocumentRef, setSupplierDocumentRef] = useState("");
  const [amount, setAmount] = useState("");
  const [debitCategoryId, setDebitCategoryId] = useState("");
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});
  const [extraLines, setExtraLines] = useState<ChargeLineInput[]>([]);
  const [expenseCategories, setExpenseCategories] = useState<ApBillExpenseCategory[]>([]);
  const [taxSettings, setTaxSettings] = useState<TaxSettings | null>(null);
  const [applyTax, setApplyTax] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const activeExpenseCategories = expenseCategories.filter((c) => !c.archived_at);

  // Filter berubah -> balik ke halaman 1 (pola "adjust state during render", lihat
  // journal-entries/page.tsx -- BUKAN useEffect, biar gak kena lint react-hooks/set-state-in-effect).
  const filterKey = `${dateFrom}|${dateTo}|${debouncedRefSearch}|${debouncedSupplierDocRefSearch}|${supplierFilter}|${statusFilter}|${originFilter}|${pageSize}`;
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey);
  if (filterKey !== prevFilterKey) {
    setPrevFilterKey(filterKey);
    setPage(0);
  }

  const filters = {
    dateFrom,
    dateTo,
    sourceRefSearch: debouncedRefSearch,
    supplierDocumentRefSearch: debouncedSupplierDocRefSearch,
    supplierId: supplierFilter,
    status: statusFilter,
    origin: originFilter,
    page,
    pageSize,
  };
  const billsQuery = useApBills(filters);
  const bills = billsQuery.data?.rows ?? [];
  const total = billsQuery.data?.total ?? 0;

  const loadSuppliers = useCallback(async () => {
    const { data } = await supabase
      .from("counterparties")
      .select("id, name, contact, payment_term_days, archived_at, counterparty_type_mapping!inner(role)")
      .eq("counterparty_type_mapping.role", "supplier")
      .order("name");
    setSuppliers((data ?? []) as Supplier[]);
  }, []);

  const loadDefaultAccounts = useCallback(async () => {
    setDefaultAccounts(await fetchDefaultAccounts());
  }, []);

  const loadExpenseCategories = useCallback(async () => {
    const { data } = await supabase
      .from("ap_bill_expense_categories")
      .select("id, name, account_id, archived_at, accounts(code, name)")
      .order("name");
    setExpenseCategories((data ?? []) as unknown as ApBillExpenseCategory[]);
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
        loadSuppliers(),
        loadDefaultAccounts(),
        loadExpenseCategories(),
        loadTaxSettings(),
      ]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadSuppliers, loadDefaultAccounts, loadExpenseCategories, loadTaxSettings]);

  const createMutation = useMutation({
    mutationFn: async (input: CreateApBillInput) => {
      const sourceRef = await generateDocumentNumber("ap_bills");
      const { error } = await supabase.rpc("create_transaction", {
        p_type: "OUTBOUND",
        p_counterparty_id: input.supplier_id,
        p_date: input.bill_date,
        p_description: input.description || null,
        p_source_ref: sourceRef,
        p_lines: input.debit_lines,
        p_control_account_id: input.payable_account_id,
        p_apply_tax: input.apply_tax,
        p_supplier_document_ref: input.supplier_document_ref || null,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      setSupplierId("");
      setBillDate("");
      setDescription("");
      setSupplierDocumentRef("");
      setAmount("");
      setDebitCategoryId("");
      setExtraLines([]);
      setApplyTax(false);
      setShowForm(false);
      queryClient.invalidateQueries({ queryKey: ["ap_bills"] });
    },
    onError: (err) => {
      setFormError(err instanceof Error ? err.message : "Gagal menyimpan bill");
    },
  });

  function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const debitCategory = expenseCategories.find((c) => c.id === debitCategoryId);
    const debitLines = [
      { account_id: debitCategory?.account_id ?? "", amount: Number(amount) },
      ...resolveChargeLines(extraLines, expenseCategories),
    ];

    const parsed = createApBillSchema.safeParse({
      supplier_id: supplierId,
      bill_date: billDate,
      description,
      supplier_document_ref: supplierDocumentRef || undefined,
      debit_lines: debitLines,
      payable_account_id: defaultAccounts["ap.payable"]?.id ?? "",
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
        <h1 className="text-xl font-semibold text-black">AP Bills</h1>
        <p className="text-sm text-slate-500">
          Role kamu:{" "}
          {roles.length > 0 ? roles.join(", ") : "belum ada role — cuma bisa lihat"}
        </p>
      </div>

      {billsQuery.error && <FormError>{(billsQuery.error as Error).message}</FormError>}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-black">AP Bills</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
              {total}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="toolbar" onClick={() => billsQuery.refetch()}>
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
              <th className="px-4 py-2">Supplier</th>
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
                  aria-label="Filter supplier"
                  value={supplierFilter}
                  onChange={(e) => setSupplierFilter(e.target.value)}
                  className={compactFilterSelectClass}
                >
                  <option value="">Semua supplier</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
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
                <div className="flex gap-1">
                  <input
                    type="text"
                    placeholder="Cari source ref..."
                    value={refSearchInput}
                    onChange={(e) => setRefSearchInput(e.target.value)}
                    className={compactFilterInputClass}
                  />
                  <input
                    type="text"
                    placeholder="Cari nota supplier..."
                    value={supplierDocRefSearchInput}
                    onChange={(e) => setSupplierDocRefSearchInput(e.target.value)}
                    className={compactFilterInputClass}
                  />
                </div>
              </th>
              <th className="px-4 py-1.5">
                <select
                  aria-label="Filter tipe"
                  value={originFilter}
                  onChange={(e) => setOriginFilter(e.target.value as ApBillOrigin | "")}
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
                  onChange={(e) => setStatusFilter(e.target.value as ApBillStatus | "")}
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
            {bills.map((bill) => {
              const { status, outstanding } = bill;
              const overdue =
                status !== "lunas" && status !== "dibatalkan" && bill.due_date < new Date().toISOString().slice(0, 10);
              return (
                <tr
                  key={bill.id}
                  className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                  onClick={() => router.push(`/ap-bills/${bill.id}`)}
                >
                  <td className="px-4 py-2 font-medium text-black">{bill.counterparties.name}</td>
                  <td className="whitespace-nowrap px-4 py-2">{bill.bill_date}</td>
                  <td className="whitespace-nowrap px-4 py-2">
                    {bill.due_date}
                    {overdue && (
                      <span className="ml-2 rounded bg-red-50 px-1.5 py-0.5 text-xs text-red-700">
                        Telat
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {bill.source_ref}
                    {bill.supplier_document_ref && (
                      <span className="ml-1 block text-xs font-normal text-slate-400">
                        nota: {bill.supplier_document_ref}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs ${originStyle[bill.origin]}`}>
                      {originLabel[bill.origin]}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    {bill.amount.toLocaleString("id-ID")}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    {outstanding.toLocaleString("id-ID")}
                  </td>
                  <td className="px-4 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs capitalize ${statusStyle[status]}`}>
                      {status}
                    </span>
                  </td>
                </tr>
              );
            })}
            {bills.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-slate-400">
                  {billsQuery.isLoading ? "Memuat..." : "Belum ada bill."}
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

      <Modal open={showForm} onClose={() => setShowForm(false)} title="Tambah AP Bill" maxWidth="max-w-2xl">
        {!canWrite && (
          <p className="mb-4 text-sm text-amber-600">
            Kamu belum punya role admin/accountant — submit di bawah kemungkinan bakal
            ketolak RLS.
          </p>
        )}
        <JournalPreviewPanel
          groups={[
            [
              resolveCategoryLeg(debitCategoryId, activeExpenseCategories, "debit"),
              ...resolveChargeLineLegs(extraLines, activeExpenseCategories, "debit"),
              { label: "Akun Utang Usaha (kredit)", resolved: defaultAccounts["ap.payable"], side: "credit" },
              applyTax && {
                label: "Akun PPN Masukan (debit)",
                resolved: resolvedPpnMasukan(taxSettings),
                side: "debit",
              },
            ],
          ]}
        />
        <form onSubmit={handleCreate} className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="supplier">Supplier</Label>
              <Select id="supplier" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                <option value="">Pilih supplier...</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} (net-{s.payment_term_days})
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="bill_date">Tanggal</Label>
              <Input
                id="bill_date"
                type="date"
                value={billDate}
                onChange={(e) => setBillDate(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="supplier_document_ref">Nomor Nota Supplier (opsional)</Label>
              <Input
                id="supplier_document_ref"
                placeholder="mis. SP-0451 (nomor asli dari nota fisik supplier)"
                value={supplierDocumentRef}
                onChange={(e) => setSupplierDocumentRef(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="description">Deskripsi</Label>
              <Input
                id="description"
                placeholder="mis. Ambil stok dari PT Plastindo Jaya"
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
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="debit_category">Kategori Persediaan/Beban (debit)</Label>
              <Select
                id="debit_category"
                value={debitCategoryId}
                onChange={(e) => setDebitCategoryId(e.target.value)}
              >
                <option value="">Pilih kategori...</option>
                {activeExpenseCategories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
              {activeExpenseCategories.length === 0 && (
                <p className="text-xs text-amber-600">
                  Belum ada kategori aktif — admin bisa setup di halaman Pengaturan &gt; Kategori & Pajak.
                </p>
              )}
            </div>
            <LockedAccountField
              label="Akun Utang Usaha (kredit)"
              htmlFor="payable_account"
              resolved={defaultAccounts["ap.payable"]}
            />
          </div>

          <ChargeLinesEditor
            label="Kategori Debit Tambahan (opsional — mis. ongkir supplier)"
            lines={extraLines}
            chargeTypes={expenseCategories}
            onChange={setExtraLines}
          />

          {taxSettings?.is_active && (
            <label className="flex w-fit items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={applyTax}
                onChange={(e) => setApplyTax(e.target.checked)}
              />
              Kena PPN Masukan ({taxSettings.ppn_rate}%, dihitung otomatis dari subtotal)
            </label>
          )}

          {formError && <FormError>{formError}</FormError>}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setShowForm(false)}>
              Batal
            </Button>
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? "Menyimpan..." : "Simpan Bill"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
