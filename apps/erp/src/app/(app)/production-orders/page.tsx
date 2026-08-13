"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import type { BomHeader } from "@/lib/bom/schema";
import type { ItemUnit } from "@/lib/item-units/schema";
import { createProductionOrderSchema, type ProductionOrder } from "@/lib/production-orders/schema";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { Modal } from "@/components/ui/modal";
import { LockedAccountField } from "@/components/ui/locked-account-field";
import { JournalPreviewPanel } from "@/components/ui/journal-preview-panel";
import { fetchDefaultAccounts, type ResolvedAccount } from "@/lib/default-accounts/schema";
import { MultiUomQtyInput } from "@/components/ui/multi-uom-qty-input";

export default function ProductionOrdersPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [boms, setBoms] = useState<BomHeader[]>([]);
  const [itemUnits, setItemUnits] = useState<ItemUnit[]>([]);
  const [orders, setOrders] = useState<ProductionOrder[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [bomHeaderId, setBomHeaderId] = useState("");
  const [qtyProduced, setQtyProduced] = useState("");
  const [productionDate, setProductionDate] = useState("");
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const activeBoms = boms.filter((b) => b.is_active);
  const selectedBom = boms.find((b) => b.id === bomHeaderId);

  const loadOrders = useCallback(async () => {
    const { data, error } = await supabase
      .from("production_orders")
      .select(
        "id, bom_header_id, qty_produced, production_date, source_ref, journal_entry_id, created_at, bom_headers(items(name)), production_order_lines(id, item_id, qty_consumed, total_cost, items(name, uom))"
      )
      .order("production_date", { ascending: false });
    if (error) {
      setLoadError(error.message);
      return;
    }
    setLoadError(null);
    setOrders((data ?? []) as unknown as ProductionOrder[]);
  }, []);

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
        .from("user_roles")
        .select("role_name")
        .eq("user_id", session.user.id);
      if (!active) return;
      setRoles(((roleRows ?? []) as { role_name: string }[]).map((r) => r.role_name));
      await Promise.all([loadBoms(), loadItemUnits(), loadDefaultAccounts(), loadOrders()]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadBoms, loadItemUnits, loadDefaultAccounts, loadOrders]);

  async function handleCreate(e: FormEvent) {
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

    setSubmitting(true);
    let sourceRef: string;
    try {
      sourceRef = await generateDocumentNumber("production_orders");
    } catch (err) {
      setSubmitting(false);
      setFormError(err instanceof Error ? err.message : "Gagal generate nomor dokumen");
      return;
    }
    const { error } = await supabase.rpc("create_production_order", {
      p_bom_header_id: parsed.data.bom_header_id,
      p_qty_produced: parsed.data.qty_produced,
      p_production_date: parsed.data.production_date,
      p_source_ref: sourceRef,
      p_finished_good_debit_account_id: parsed.data.finished_good_debit_account_id,
      p_raw_material_credit_account_id: parsed.data.raw_material_credit_account_id,
    });
    setSubmitting(false);
    if (error) {
      setFormError(error.message);
      return;
    }

    setBomHeaderId("");
    setQtyProduced("");
    setProductionDate("");
    setShowForm(false);
    await loadOrders();
  }

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">Production Orders</h1>
        <p className="text-sm text-slate-500">
          Role kamu:{" "}
          {roles.length > 0 ? roles.join(", ") : "belum ada role — cuma bisa lihat"}
        </p>
      </div>

      {loadError && <FormError>{loadError}</FormError>}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-black">Production Orders</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
              {orders.length}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="toolbar" onClick={() => loadOrders()}>
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
              <th className="px-4 py-2">Source Ref</th>
              <th className="px-4 py-2">Barang Jadi</th>
              <th className="px-4 py-2">Qty Produksi</th>
              <th className="px-4 py-2">Tanggal</th>
              <th className="px-4 py-2">Konsumsi Bahan Baku</th>
              <th className="px-4 py-2 text-right">Total Biaya</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((po) => {
              const totalCost = po.production_order_lines.reduce((sum, l) => sum + l.total_cost, 0);
              return (
                <tr
                  key={po.id}
                  className="cursor-pointer border-b border-slate-100 align-top hover:bg-slate-50"
                  onClick={() => router.push(`/production-orders/${po.id}`)}
                >
                  <td className="px-4 py-2">{po.source_ref}</td>
                  <td className="px-4 py-2 font-medium text-black">{po.bom_headers.items.name}</td>
                  <td className="px-4 py-2">{po.qty_produced}</td>
                  <td className="whitespace-nowrap px-4 py-2">{po.production_date}</td>
                  <td className="px-4 py-2">
                    <ul className="space-y-0.5">
                      {po.production_order_lines.map((l) => (
                        <li key={l.id}>
                          {l.items.name} — {l.qty_consumed} {l.items.uom} = {l.total_cost.toLocaleString("id-ID")}
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td className="px-4 py-2 text-right font-mono">{totalCost.toLocaleString("id-ID")}</td>
                </tr>
              );
            })}
            {orders.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                  Belum ada production order.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Modal open={showForm} onClose={() => setShowForm(false)} title="Jalankan Produksi" maxWidth="max-w-2xl">
        {!canWrite && (
          <p className="mb-4 text-sm text-amber-600">
            Kamu belum punya role admin/accountant — submit di bawah kemungkinan bakal
            ketolak RLS.
          </p>
        )}
        <p className="mb-4 text-sm text-slate-500">
          Bahan baku dikonsumsi otomatis sesuai resep (BOM), Weighted Average — gak perlu
          diinput manual di sini.
        </p>
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
        <form onSubmit={handleCreate} className="flex flex-col gap-4">
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

            {formError && <FormError>{formError}</FormError>}

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="secondary" onClick={() => setShowForm(false)}>
                Batal
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? "Memproses..." : "Jalankan Produksi"}
              </Button>
            </div>
        </form>
      </Modal>
    </div>
  );
}
