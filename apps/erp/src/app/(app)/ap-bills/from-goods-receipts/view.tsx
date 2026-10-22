"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import { useUnbilledReceipts } from "@/lib/goods-receipts/queries";
import { hasZeroValueLine, receiptNumber } from "@/lib/goods-receipts/types";
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
import { ReceiptLinesTable } from "@/components/goods-receipts/receipt-lines-table";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function ApBillFromGoodsReceiptsView({
  initialSupplierId,
  initialNoteId,
}: {
  initialSupplierId: string;
  initialNoteId: string;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [checkingSession, setCheckingSession] = useState(true);
  const [roles, setRoles] = useState<string[]>([]);

  const [supplierId, setSupplierId] = useState(initialSupplierId);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initialNoteId ? [initialNoteId] : []));
  const [billDate, setBillDate] = useState("");
  const [description, setDescription] = useState("");
  const [supplierDocumentRef, setSupplierDocumentRef] = useState("");
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});
  const [extraLines, setExtraLines] = useState<ChargeLineInput[]>([]);
  const [expenseCategories, setExpenseCategories] = useState<ChargeCategoryWithAccount[]>([]);
  const [taxSettings, setTaxSettings] = useState<TaxSettings | null>(null);
  const [applyTax, setApplyTax] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const notesQuery = useUnbilledReceipts(supplierId);
  const notes = notesQuery.data ?? [];

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

  const createMutation = useMutation({
    mutationFn: async () => {
      const sourceRef = await generateDocumentNumber("ap_bills");
      const { data, error } = await supabase.rpc("create_ap_bill_from_goods_receipts", {
        p_goods_note_ids: [...selected],
        p_bill_date: billDate,
        p_description: description || null,
        p_source_ref: sourceRef,
        p_payable_account_id: defaultAccounts["ap.payable"]?.id,
        p_extra_debit_lines: resolveChargeLines(extraLines, expenseCategories),
        p_apply_tax: applyTax,
        p_supplier_document_ref: supplierDocumentRef || null,
      });
      if (error) throw new Error(error.message);
      return data as string;
    },
    onSuccess: (newId) => {
      queryClient.invalidateQueries({ queryKey: ["ap_bills"] });
      queryClient.invalidateQueries({ queryKey: ["goods_receipt_notes"] });
      queryClient.invalidateQueries({ queryKey: ["unbilled_goods_receipts"] });
      router.push(`/ap-bills/${newId}`);
    },
    onError: (err) => {
      setFormError(err instanceof Error ? err.message : "Gagal menyimpan tagihan");
    },
  });

  function changeSupplier(id: string) {
    setSupplierId(id);
    setSelected(new Set());
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!supplierId) return setFormError("Pilih supplier");
    if (selected.size === 0) return setFormError("Pilih minimal 1 barang masuk yang mau ditagih");
    if (!billDate) return setFormError("Tanggal wajib diisi");
    if (!defaultAccounts["ap.payable"]?.id) return setFormError("Default Akun Utang Usaha belum diset");
    createMutation.mutate();
  }

  if (checkingSession) {
    return <LoadingScreen />;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");
  const chosen = notes.filter((n) => selected.has(n.id));
  const goodsTotal = round2(chosen.reduce((sum, n) => sum + n.total_value, 0));
  const extraTotal = round2(resolveChargeLines(extraLines, expenseCategories).reduce((sum, l) => sum + l.amount, 0));
  const subtotal = round2(goodsTotal + extraTotal);
  const taxAmount = applyTax && taxSettings ? round2((subtotal * taxSettings.ppn_rate) / 100) : 0;
  const totalAmount = round2(subtotal + taxAmount);

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/ap-bills" label="Kembali ke Tagihan" />

      <div>
        <h1 className="text-xl font-semibold text-black">Tagihan dari Barang Masuk</h1>
        <p className="text-sm text-slate-500">
          Pilih supplier, lalu centang barang masuk yang sudah ada notanya. Nominal tagihan mengikuti nilai barang masuk
          yang dipilih — kalau harga di nota beda, revisi harga barang masuknya dulu. Satu barang masuk ditagih utuh dan
          hanya sekali. Untuk biaya/jasa tanpa barang masuk, pakai Tagihan Langsung.
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
                <CounterpartyPicker id="supplier" role="supplier" value={supplierId} onChange={changeSupplier} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="bill_date">Tanggal Tagihan</Label>
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
                <Label htmlFor="description">Deskripsi (opsional)</Label>
                <Input
                  id="description"
                  placeholder="mis. Nota pembelian kantong plastik"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
              <LockedAccountField
                label="Akun Utang Usaha (kredit)"
                htmlFor="payable_account"
                resolved={defaultAccounts["ap.payable"]}
              />
              <LockedAccountField
                label="Akun Barang Diterima Belum Ditagih (debit)"
                htmlFor="grni_account"
                resolved={defaultAccounts["inventory.goods_received_not_invoiced"]}
              />
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <p className="mb-3 text-sm font-medium text-black">Barang Masuk yang Belum Ditagih</p>
            {!supplierId && <p className="text-sm text-slate-400">Pilih supplier dulu.</p>}
            {supplierId && notesQuery.isLoading && <p className="text-sm text-slate-400">Memuat...</p>}
            {supplierId && notesQuery.error && <FormError>{(notesQuery.error as Error).message}</FormError>}
            {supplierId && !notesQuery.isLoading && notes.length === 0 && (
              <p className="text-sm text-slate-400">Supplier ini tidak punya barang masuk yang belum ditagih.</p>
            )}
            <div className="flex flex-col gap-3">
              {notes.map((n) => {
                const zero = hasZeroValueLine(n);
                return (
                  <label
                    key={n.id}
                    className={`flex gap-3 rounded-lg border px-4 py-3 ${
                      zero
                        ? "cursor-not-allowed border-amber-200 bg-amber-50/60"
                        : selected.has(n.id)
                          ? "cursor-pointer border-blue-300 bg-blue-50/50"
                          : "cursor-pointer border-slate-200 hover:bg-slate-50"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="mt-1"
                      disabled={zero}
                      checked={selected.has(n.id)}
                      onChange={() => toggle(n.id)}
                    />
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          <span className="font-mono text-xs text-slate-600">{receiptNumber(n)}</span>
                          <span className="text-slate-500">{n.note_date}</span>
                          {n.delivery_note_ref && <span className="text-xs text-slate-400">SJ: {n.delivery_note_ref}</span>}
                          {n.unbilled_age_days != null && n.unbilled_age_days > 0 && (
                            <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700">
                              {n.unbilled_age_days} hari
                            </span>
                          )}
                        </div>
                        <span className="font-mono text-sm font-medium text-black">
                          Rp{n.total_value.toLocaleString("id-ID")}
                        </span>
                      </div>
                      <ReceiptLinesTable lines={n.goods_note_lines} variant="compact" />
                      {zero && (
                        <p className="text-xs text-amber-700">
                          Ada baris berharga 0 — beri harga dulu lewat{" "}
                          <button
                            type="button"
                            className="underline"
                            onClick={(e) => {
                              e.preventDefault();
                              router.push(`/goods-receipts/${n.id}/revisi`);
                            }}
                          >
                            Revisi Harga
                          </button>
                          .
                        </p>
                      )}
                    </div>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <ChargeLinesEditor
              label="Kategori Debit Tambahan (opsional — mis. ongkir yang tertera di nota)"
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
                  label: "Akun Barang Diterima Belum Ditagih (debit)",
                  resolved: defaultAccounts["inventory.goods_received_not_invoiced"],
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
              <span>Barang masuk dipilih</span>
              <span className="font-mono">{chosen.length}</span>
            </div>
            <div className="flex items-center justify-between text-sm text-slate-500">
              <span>Nilai barang masuk</span>
              <span className="font-mono">Rp{goodsTotal.toLocaleString("id-ID")}</span>
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
            <Button type="submit" disabled={createMutation.isPending || selected.size === 0}>
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
