"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import type { Supplier } from "@/lib/suppliers/schema";
import { createApBillSchema, billStatus, billOrigin, type ApBill } from "@/lib/ap-bills/schema";
import type { ApBillExpenseCategory } from "@/lib/ap-bill-expense-categories/schema";
import { fetchTaxSettings, resolvedPpnMasukan, type TaxSettings } from "@/lib/tax-settings/schema";
import {
  resolveChargeLines,
  resolveCategoryLeg,
  resolveChargeLineLegs,
  type ChargeLineInput,
} from "@/lib/charge-lines/schema";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { ChargeLinesEditor } from "@/components/ui/charge-lines-editor";
import { Modal } from "@/components/ui/modal";
import { LockedAccountField } from "@/components/ui/locked-account-field";
import { JournalPreviewPanel } from "@/components/ui/journal-preview-panel";
import { fetchDefaultAccounts, type ResolvedAccount } from "@/lib/default-accounts/schema";

const statusStyle: Record<string, string> = {
  lunas: "bg-emerald-50 text-emerald-700",
  sebagian: "bg-amber-50 text-amber-700",
  belum: "bg-slate-100 text-slate-600",
  dibatalkan: "bg-slate-100 text-slate-400 line-through",
};

export default function ApBillsPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [bills, setBills] = useState<ApBill[]>([]);
  const [reversedEntryIds, setReversedEntryIds] = useState<Set<string>>(new Set());
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

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
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const activeExpenseCategories = expenseCategories.filter((c) => !c.archived_at);

  const loadReversedEntryIds = useCallback(async () => {
    const { data } = await supabase
      .from("journal_entries")
      .select("reverses_entry_id")
      .not("reverses_entry_id", "is", null);
    setReversedEntryIds(
      new Set(((data ?? []) as { reverses_entry_id: string }[]).map((r) => r.reverses_entry_id))
    );
  }, []);

  const loadBills = useCallback(async () => {
    const { data, error } = await supabase
      .from("ap_bills")
      .select(
        "id, supplier_id, bill_date, due_date, description, source_ref, supplier_document_ref, amount, journal_entry_id, created_at, suppliers(name), ap_payments(amount), ap_credit_notes(amount, ap_return_credits(amount)), ap_deposit_applications(amount), goods_receipt_notes(id)"
      )
      .order("bill_date", { ascending: false });
    if (error) {
      setLoadError(error.message);
      return;
    }
    setLoadError(null);
    setBills((data ?? []) as unknown as ApBill[]);
  }, []);

  const loadSuppliers = useCallback(async () => {
    const { data } = await supabase
      .from("suppliers")
      .select("id, name, contact, payment_term_days, archived_at")
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
        loadBills(),
        loadReversedEntryIds(),
        loadExpenseCategories(),
        loadTaxSettings(),
      ]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadSuppliers, loadDefaultAccounts, loadBills, loadReversedEntryIds, loadExpenseCategories, loadTaxSettings]);

  async function handleCreate(e: FormEvent) {
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

    setSubmitting(true);
    let sourceRef: string;
    try {
      sourceRef = await generateDocumentNumber("ap_bills");
    } catch (err) {
      setSubmitting(false);
      setFormError(err instanceof Error ? err.message : "Gagal generate nomor dokumen");
      return;
    }
    const { error } = await supabase.rpc("create_ap_bill", {
      p_supplier_id: parsed.data.supplier_id,
      p_bill_date: parsed.data.bill_date,
      p_description: parsed.data.description || null,
      p_source_ref: sourceRef,
      p_debit_lines: parsed.data.debit_lines,
      p_payable_account_id: parsed.data.payable_account_id,
      p_apply_tax: parsed.data.apply_tax,
      p_supplier_document_ref: parsed.data.supplier_document_ref || null,
    });
    setSubmitting(false);
    if (error) {
      setFormError(error.message);
      return;
    }

    setSupplierId("");
    setBillDate("");
    setDescription("");
    setSupplierDocumentRef("");
    setAmount("");
    setDebitCategoryId("");
    setExtraLines([]);
    setApplyTax(false);
    setShowForm(false);
    await loadBills();
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

      {loadError && <FormError>{loadError}</FormError>}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-black">AP Bills</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
              {bills.length}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="toolbar" onClick={() => loadBills()}>
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
          </thead>
          <tbody>
            {bills.map((bill) => {
              const isCancelled = reversedEntryIds.has(bill.journal_entry_id);
              const { status, outstanding } = billStatus(bill, isCancelled);
              const overdue =
                status !== "lunas" && status !== "dibatalkan" && bill.due_date < new Date().toISOString().slice(0, 10);
              return (
                <tr
                  key={bill.id}
                  className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                  onClick={() => router.push(`/ap-bills/${bill.id}`)}
                >
                  <td className="px-4 py-2 font-medium text-black">{bill.suppliers.name}</td>
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
                    {billOrigin(bill) === "grn" ? (
                      <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700">Dari GRN</span>
                    ) : (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                        Bill Langsung
                      </span>
                    )}
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
                  Belum ada bill.
                </td>
              </tr>
            )}
          </tbody>
        </table>
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
            <Button type="submit" disabled={submitting}>
              {submitting ? "Menyimpan..." : "Simpan Bill"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
