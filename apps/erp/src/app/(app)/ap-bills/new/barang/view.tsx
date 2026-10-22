"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import { fetchTaxSettings, resolvedPpnMasukan, type TaxSettings } from "@/lib/tax-settings/schema";
import {
  resolveChargeLines,
  resolveChargeLineLegs,
  type ChargeLineInput,
  type ChargeCategoryWithAccount,
} from "@/lib/charge-lines/schema";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { fetchDefaultAccounts, type ResolvedAccount } from "@/lib/default-accounts/schema";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { ChargeLinesEditor } from "@/components/ui/charge-lines-editor";
import { LockedAccountField } from "@/components/ui/locked-account-field";
import { JournalPreviewPanel } from "@/components/ui/journal-preview-panel";
import { LoadingScreen } from "@/components/ui/loading-screen";
import { CounterpartyPicker } from "@/components/pickers/counterparty-picker";
import { SupplierBalanceNotice } from "@/components/supplier-balance-notice";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Tagihan Barang: nota supplier dicatat dulu (boleh dibayar kapan saja), barangnya menyusul bertahap. Bagian barang
 * jadi "kolam" yang dihabiskan barang masuk yang dibuat dari tagihan ini. Jurnal: Debit Pembelian Belum Diterima /
 * Kredit Utang Usaha -- bukan Debit Persediaan, karena barangnya belum ada di gudang.
 */
export function NewApBillWithGoodsView() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [checkingSession, setCheckingSession] = useState(true);
  const [roles, setRoles] = useState<string[]>([]);

  const [supplierId, setSupplierId] = useState("");
  const [billDate, setBillDate] = useState("");
  const [goodsAmount, setGoodsAmount] = useState("");
  const [description, setDescription] = useState("");
  const [supplierDocumentRef, setSupplierDocumentRef] = useState("");
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});
  const [extraLines, setExtraLines] = useState<ChargeLineInput[]>([]);
  const [expenseCategories, setExpenseCategories] = useState<ChargeCategoryWithAccount[]>([]);
  const [taxSettings, setTaxSettings] = useState<TaxSettings | null>(null);
  const [applyTax, setApplyTax] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const loadExpenseCategories = useCallback(async () => {
    const { data } = await supabase
      .from("charge_categories")
      .select("id, name, account_id, archived_at, accounts(code, name)")
      .eq("module", "ap")
      .order("name");
    setExpenseCategories((data ?? []) as unknown as ChargeCategoryWithAccount[]);
  }, []);

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
      await Promise.all([
        fetchDefaultAccounts().then(setDefaultAccounts),
        loadExpenseCategories(),
        fetchTaxSettings().then(setTaxSettings),
      ]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadExpenseCategories]);

  const goods = parseFloat(goodsAmount) || 0;

  const createMutation = useMutation({
    mutationFn: async () => {
      const sourceRef = await generateDocumentNumber("ap_bills");
      const { data, error } = await supabase.rpc("create_ap_bill_with_goods_pool", {
        p_supplier_id: supplierId,
        p_bill_date: billDate,
        p_description: description || null,
        p_source_ref: sourceRef,
        p_payable_account_id: defaultAccounts["ap.payable"]?.id,
        p_goods_amount: goods,
        p_extra_debit_lines: resolveChargeLines(extraLines, expenseCategories),
        p_apply_tax: applyTax,
        p_supplier_document_ref: supplierDocumentRef || null,
      });
      if (error) throw new Error(error.message);
      return data as string;
    },
    onSuccess: (newId) => {
      queryClient.invalidateQueries({ queryKey: ["ap_bills"] });
      queryClient.invalidateQueries({ queryKey: ["open_pool_bills"] });
      router.push(`/ap-bills/${newId}`);
    },
    onError: (err) => {
      setFormError(err instanceof Error ? err.message : "Gagal menyimpan tagihan");
    },
  });

  function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!supplierId) return setFormError("Pilih supplier");
    if (!billDate) return setFormError("Tanggal wajib diisi");
    if (goods <= 0) return setFormError("Nilai barang di nota harus lebih dari 0");
    if (Math.abs(goods * 100 - Math.round(goods * 100)) > 1e-6) return setFormError("Nilai barang maksimal 2 desimal");
    if (!defaultAccounts["ap.payable"]?.id) return setFormError("Default Akun Utang Usaha belum diset");
    if (!defaultAccounts["inventory.purchase_not_received"]?.id) {
      return setFormError("Default Akun Pembelian Belum Diterima belum diset -- cek Pengaturan > Default Akun");
    }
    createMutation.mutate();
  }

  if (checkingSession) {
    return <LoadingScreen />;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");
  const extraTotal = round2(resolveChargeLines(extraLines, expenseCategories).reduce((sum, l) => sum + l.amount, 0));
  const subtotal = round2(goods + extraTotal);
  const taxAmount = applyTax && taxSettings ? round2((subtotal * taxSettings.ppn_rate) / 100) : 0;
  const totalAmount = round2(subtotal + taxAmount);

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/ap-bills" label="Kembali ke Tagihan" />

      <div>
        <h1 className="text-xl font-semibold text-black">Tagihan Barang</h1>
        <p className="text-sm text-slate-500">
          Catat nota supplier untuk barang yang akan datang (sekaligus atau bertahap). Setiap kiriman barang dicatat
          sebagai Barang Masuk dari tagihan ini, dan nilainya mengurangi barang yang belum diterima dari nota ini. Tagihan boleh
          dibayar kapan saja, tidak harus menunggu barangnya. Kalau notanya belum pasti, isi nominal perkiraan.
          Untuk biaya atau jasa tanpa barang fisik, pakai Tagihan Langsung.
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
            {supplierId && (
              <div className="mb-4">
                <SupplierBalanceNotice supplierId={supplierId} />
              </div>
            )}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="supplier">Supplier</Label>
                <CounterpartyPicker id="supplier" role="supplier" value={supplierId} onChange={setSupplierId} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="bill_date">Tanggal Tagihan</Label>
                <Input id="bill_date" type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="goods_amount">Nilai Barang di Nota (Rp)</Label>
                <Input
                  id="goods_amount"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="mis. 10000000"
                  value={goodsAmount}
                  onChange={(e) => setGoodsAmount(e.target.value)}
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
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label htmlFor="description">Deskripsi (opsional)</Label>
                <Input
                  id="description"
                  placeholder="mis. Nota pembelian kantong plastik"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
              <LockedAccountField
                label="Akun Pembelian Belum Diterima (debit)"
                htmlFor="pbd_account"
                resolved={defaultAccounts["inventory.purchase_not_received"]}
              />
              <LockedAccountField
                label="Akun Utang Usaha (kredit)"
                htmlFor="payable_account"
                resolved={defaultAccounts["ap.payable"]}
              />
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <ChargeLinesEditor
              label="Kategori Debit Tambahan (opsional — mis. ongkir yang tertera di nota; di luar nilai barang)"
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

        <div className="flex flex-col gap-4 lg:sticky lg:top-4 lg:col-span-1 lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-y-auto">
          <JournalPreviewPanel
            groups={[
              [
                {
                  label: "Akun Pembelian Belum Diterima (debit)",
                  resolved: defaultAccounts["inventory.purchase_not_received"],
                  side: "debit",
                },
                ...resolveChargeLineLegs(extraLines, expenseCategories, "debit"),
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
            <div className="flex items-center justify-between text-sm text-slate-500">
              <span>Nilai barang di nota</span>
              <span className="font-mono">Rp{goods.toLocaleString("id-ID")}</span>
            </div>
            {extraTotal > 0 && (
              <div className="flex items-center justify-between text-sm text-slate-500">
                <span>Biaya tambahan</span>
                <span className="font-mono">Rp{extraTotal.toLocaleString("id-ID")}</span>
              </div>
            )}
            {taxAmount > 0 && (
              <div className="flex items-center justify-between text-sm text-slate-500">
                <span>PPN Masukan</span>
                <span className="font-mono">Rp{taxAmount.toLocaleString("id-ID")}</span>
              </div>
            )}
            <p className="mt-2 text-sm text-slate-500">Nilai Tagihan</p>
            <p className="mt-1 font-mono text-2xl text-black">Rp{totalAmount.toLocaleString("id-ID")}</p>
          </div>

          {formError && <FormError>{formError}</FormError>}

          <div className="flex flex-col gap-2">
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? "Menyimpan..." : "Simpan Tagihan"}
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
