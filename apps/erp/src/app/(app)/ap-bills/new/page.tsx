"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import type { Supplier } from "@/lib/suppliers/schema";
import { createApBillSchema, type CreateApBillInput } from "@/lib/ap-bills/schema";
import { fetchTaxSettings, resolvedPpnMasukan, type TaxSettings } from "@/lib/tax-settings/schema";
import {
  resolveChargeLines,
  resolveCategoryLeg,
  resolveChargeLineLegs,
  type ChargeLineInput,
  type ChargeCategoryWithAccount,
} from "@/lib/charge-lines/schema";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { ChargeLinesEditor } from "@/components/ui/charge-lines-editor";
import { LockedAccountField } from "@/components/ui/locked-account-field";
import { JournalPreviewPanel } from "@/components/ui/journal-preview-panel";
import { fetchDefaultAccounts, type ResolvedAccount } from "@/lib/default-accounts/schema";
import { LoadingScreen } from "@/components/ui/loading-screen";

export default function NewApBillPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [checkingSession, setCheckingSession] = useState(true);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [roles, setRoles] = useState<string[]>([]);

  const [supplierId, setSupplierId] = useState("");
  const [billDate, setBillDate] = useState("");
  const [description, setDescription] = useState("");
  const [supplierDocumentRef, setSupplierDocumentRef] = useState("");
  const [amount, setAmount] = useState("");
  const [debitCategoryId, setDebitCategoryId] = useState("");
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});
  const [extraLines, setExtraLines] = useState<ChargeLineInput[]>([]);
  const [expenseCategories, setExpenseCategories] = useState<ChargeCategoryWithAccount[]>([]);
  const [taxSettings, setTaxSettings] = useState<TaxSettings | null>(null);
  const [applyTax, setApplyTax] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const activeExpenseCategories = expenseCategories.filter((c) => !c.archived_at);

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
      .from("charge_categories")
      .select("id, name, account_id, archived_at, accounts(code, name)")
      .eq("module", "ap")
      .order("name");
    setExpenseCategories((data ?? []) as unknown as ChargeCategoryWithAccount[]);
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
      await Promise.all([loadSuppliers(), loadDefaultAccounts(), loadExpenseCategories(), loadTaxSettings()]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadSuppliers, loadDefaultAccounts, loadExpenseCategories, loadTaxSettings]);

  const createMutation = useMutation({
    mutationFn: async (input: CreateApBillInput) => {
      const sourceRef = await generateDocumentNumber("ap_bills");
      const { data, error } = await supabase.rpc("create_transaction", {
        p_type: "INBOUND",
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
      return data as string;
    },
    onSuccess: (newId) => {
      queryClient.invalidateQueries({ queryKey: ["ap_bills"] });
      router.push(`/ap-bills/${newId}`);
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
    return <LoadingScreen />;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");
  const totalAmount = (Number(amount) || 0) + resolveChargeLines(extraLines, expenseCategories).reduce(
    (sum, l) => sum + l.amount,
    0
  );

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/ap-bills" label="Kembali ke Tagihan" />

      <div>
        <h1 className="text-xl font-semibold text-black">Tambah Tagihan</h1>
        <p className="text-sm text-slate-500">
          Bill langsung ke supplier tanpa Goods Receipt — buat beban/persediaan yang gak
          lewat penerimaan barang fisik.
        </p>
      </div>

      {!canWrite && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-700">
          Kamu belum punya role admin/accountant — submit di bawah kemungkinan bakal ketolak RLS.
        </p>
      )}

      <form onSubmit={handleCreate} className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
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
                <Input id="bill_date" type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} />
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
                <Select id="debit_category" value={debitCategoryId} onChange={(e) => setDebitCategoryId(e.target.value)}>
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
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <ChargeLinesEditor
              label="Kategori Debit Tambahan (opsional — mis. ongkir supplier)"
              lines={extraLines}
              chargeTypes={expenseCategories}
              onChange={setExtraLines}
            />

            {taxSettings?.is_active && (
              <label className="mt-4 flex w-fit items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={applyTax} onChange={(e) => setApplyTax(e.target.checked)} />
                Kena PPN Masukan ({taxSettings.ppn_rate}%, dihitung otomatis dari subtotal)
              </label>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-4 lg:sticky lg:top-4 lg:col-span-1 lg:self-start">
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

          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <p className="text-sm text-slate-500">Nilai Tagihan</p>
            <p className="mt-1 font-mono text-2xl text-black">Rp{totalAmount.toLocaleString("id-ID")}</p>
          </div>

          {formError && <FormError>{formError}</FormError>}

          <div className="flex flex-col gap-2">
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? "Menyimpan..." : "Simpan Bill"}
            </Button>
            <Button type="button" variant="secondary" onClick={() => router.back()}>
              Batal
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
