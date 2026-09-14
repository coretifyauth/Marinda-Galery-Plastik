"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import type { BomHeader } from "@/lib/bom/schema";
import type { ItemUnit } from "@/lib/item-units/schema";
import { createProductionOrderSchema, type CreateProductionOrderInput } from "@/lib/production-orders/schema";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { LockedAccountField } from "@/components/ui/locked-account-field";
import { JournalPreviewPanel } from "@/components/ui/journal-preview-panel";
import { fetchDefaultAccounts, type ResolvedAccount } from "@/lib/default-accounts/schema";
import { MultiUomQtyInput } from "@/components/ui/multi-uom-qty-input";
import { LoadingScreen } from "@/components/ui/loading-screen";

export default function NewProductionOrderPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [boms, setBoms] = useState<BomHeader[]>([]);
  const [itemUnits, setItemUnits] = useState<ItemUnit[]>([]);
  const [roles, setRoles] = useState<string[]>([]);

  const [bomHeaderId, setBomHeaderId] = useState("");
  const [qtyProduced, setQtyProduced] = useState("");
  const [productionDate, setProductionDate] = useState("");
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const activeBoms = boms.filter((b) => b.is_active);
  const selectedBom = boms.find((b) => b.id === bomHeaderId);

  const loadBoms = useCallback(async () => {
    const { data } = await supabase
      .from("bom_headers")
      .select(
        "id, finished_item_id, output_qty, is_active, created_at, items(name, uom), bom_lines(id, raw_material_item_id, qty_per_batch, items(name, uom))"
      )
      .order("created_at", { ascending: false });
    setBoms((data ?? []) as unknown as BomHeader[]);
  }, []);

  const loadItemUnits = useCallback(async () => {
    const { data } = await supabase
      .from("item_units")
      .select("id, item_id, unit_label, conversion_factor, price, is_base");
    setItemUnits((data ?? []) as ItemUnit[]);
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
        .from("app_user_roles")
        .select("role_name")
        .eq("user_id", session.user.id);
      if (!active) return;
      setRoles(((roleRows ?? []) as { role_name: string }[]).map((r) => r.role_name));
      await Promise.all([loadBoms(), loadItemUnits(), loadDefaultAccounts()]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadBoms, loadItemUnits, loadDefaultAccounts]);

  const createMutation = useMutation({
    mutationFn: async (input: CreateProductionOrderInput) => {
      const sourceRef = await generateDocumentNumber("production_orders");
      const { data, error } = await supabase.rpc("create_production_order", {
        p_bom_header_id: input.bom_header_id,
        p_qty_produced: input.qty_produced,
        p_production_date: input.production_date,
        p_source_ref: sourceRef,
        p_finished_good_debit_account_id: input.finished_good_debit_account_id,
        p_raw_material_credit_account_id: input.raw_material_credit_account_id,
      });
      if (error) throw new Error(error.message);
      return data as string | null;
    },
    onSuccess: (newId) => {
      router.push(newId ? `/production-orders/${newId}` : "/production-orders");
    },
    onError: (err) => {
      setFormError(err instanceof Error ? err.message : "Gagal menyimpan production order");
    },
  });

  function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const parsed = createProductionOrderSchema.safeParse({
      bom_header_id: bomHeaderId,
      qty_produced: qtyProduced,
      production_date: productionDate,
      finished_good_debit_account_id: defaultAccounts["inventory.finished_good"]?.id ?? "",
      raw_material_credit_account_id: defaultAccounts["inventory.raw_material"]?.id ?? "",
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

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/production-orders" label="Kembali ke Production Order" />

      <div>
        <h1 className="text-xl font-semibold text-black">Jalankan Produksi</h1>
        <p className="text-sm text-slate-500">
          Bahan baku dikonsumsi otomatis sesuai resep (BOM), Weighted Average — gak perlu
          diinput manual di sini.
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
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="bom">Resep (BOM)</Label>
                <Select
                  id="bom"
                  value={bomHeaderId}
                  onChange={(e) => {
                    setBomHeaderId(e.target.value);
                    setQtyProduced("");
                  }}
                >
                  <option value="">Pilih resep...</option>
                  {activeBoms.map((bom) => (
                    <option key={bom.id} value={bom.id}>
                      {bom.items.name} ({bom.output_qty} {bom.items.uom}/batch)
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="qty_produced">Qty Diproduksi per Satuan</Label>
                {selectedBom ? (
                  <MultiUomQtyInput
                    key={selectedBom.id}
                    units={itemUnits.filter((u) => u.item_id === selectedBom.finished_item_id)}
                    baseUom={selectedBom.items.uom}
                    onChange={(change) => setQtyProduced(change.baseQty)}
                  />
                ) : (
                  <span className="flex items-center text-xs text-slate-400">Pilih resep dulu</span>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="production_date">Tanggal Produksi</Label>
                <Input
                  id="production_date"
                  type="date"
                  value={productionDate}
                  onChange={(e) => setProductionDate(e.target.value)}
                />
              </div>
              <LockedAccountField
                label="Akun Persediaan Barang Jadi (debit)"
                htmlFor="finished_good_account"
                resolved={defaultAccounts["inventory.finished_good"]}
              />
              <LockedAccountField
                label="Akun Persediaan Bahan Baku (kredit)"
                htmlFor="raw_material_account"
                resolved={defaultAccounts["inventory.raw_material"]}
              />
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4 lg:sticky lg:top-4 lg:col-span-1 lg:self-start">
          <JournalPreviewPanel
            groups={[
              [
                {
                  label: "Akun Persediaan Barang Jadi (debit)",
                  resolved: defaultAccounts["inventory.finished_good"],
                  side: "debit",
                },
                {
                  label: "Akun Persediaan Bahan Baku (kredit)",
                  resolved: defaultAccounts["inventory.raw_material"],
                  side: "credit",
                },
              ],
            ]}
          />

          {formError && <FormError>{formError}</FormError>}

          <div className="flex flex-col gap-2">
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? "Memproses..." : "Jalankan Produksi"}
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
