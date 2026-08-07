"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { getLeafAccounts, type Account } from "@/lib/accounts/schema";
import type { BomHeader } from "@/lib/bom/schema";
import { createProductionOrderSchema, type ProductionOrder } from "@/lib/production-orders/schema";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";

export default function ProductionOrdersPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [boms, setBoms] = useState<BomHeader[]>([]);
  const [orders, setOrders] = useState<ProductionOrder[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [bomHeaderId, setBomHeaderId] = useState("");
  const [qtyProduced, setQtyProduced] = useState("");
  const [productionDate, setProductionDate] = useState("");
  const [sourceRef, setSourceRef] = useState("");
  const [finishedGoodDebitAccountId, setFinishedGoodDebitAccountId] = useState("");
  const [rawMaterialCreditAccountId, setRawMaterialCreditAccountId] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const leafAccounts = getLeafAccounts(accounts);
  const activeBoms = boms.filter((b) => b.is_active);

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

  const loadAccounts = useCallback(async () => {
    const { data } = await supabase
      .from("accounts")
      .select("id, code, name, category, normal_balance, parent_id, archived_at")
      .order("code");
    setAccounts((data ?? []) as Account[]);
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
      await Promise.all([loadBoms(), loadAccounts(), loadOrders()]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadBoms, loadAccounts, loadOrders]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const parsed = createProductionOrderSchema.safeParse({
      bom_header_id: bomHeaderId,
      qty_produced: qtyProduced,
      production_date: productionDate,
      source_ref: sourceRef,
      finished_good_debit_account_id: finishedGoodDebitAccountId,
      raw_material_credit_account_id: rawMaterialCreditAccountId,
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setSubmitting(true);
    const { error } = await supabase.rpc("create_production_order", {
      p_bom_header_id: parsed.data.bom_header_id,
      p_qty_produced: parsed.data.qty_produced,
      p_production_date: parsed.data.production_date,
      p_source_ref: parsed.data.source_ref,
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
    setSourceRef("");
    setFinishedGoodDebitAccountId("");
    setRawMaterialCreditAccountId("");
    setShowForm(false);
    await loadOrders();
  }

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");

  return (
    <div className="flex w-full max-w-5xl flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">Production Orders — CV Roti Barokah</h1>
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
              <Button variant="toolbar-primary" onClick={() => setShowForm((v) => !v)}>
                + New
              </Button>
            )}
          </div>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
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
                <tr key={po.id} className="border-b border-slate-100 align-top hover:bg-slate-50">
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
                <td colSpan={5} className="px-4 py-6 text-center text-slate-400">
                  Belum ada production order.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showForm && (
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 font-semibold text-black">Jalankan Produksi</h2>
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
          <form onSubmit={handleCreate} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="bom">Resep (BOM)</Label>
                <Select id="bom" value={bomHeaderId} onChange={(e) => setBomHeaderId(e.target.value)}>
                  <option value="">Pilih resep...</option>
                  {activeBoms.map((bom) => (
                    <option key={bom.id} value={bom.id}>
                      {bom.items.name} ({bom.output_qty} {bom.items.uom}/batch)
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="qty_produced">Qty Diproduksi</Label>
                <Input
                  id="qty_produced"
                  type="number"
                  min="0"
                  placeholder="mis. 50"
                  value={qtyProduced}
                  onChange={(e) => setQtyProduced(e.target.value)}
                />
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
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="source_ref">Rujukan dokumen (source_ref)</Label>
                <Input
                  id="source_ref"
                  placeholder="mis. PROD-002"
                  value={sourceRef}
                  onChange={(e) => setSourceRef(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="finished_good_account">Akun Persediaan Barang Jadi (debit)</Label>
                <Select
                  id="finished_good_account"
                  value={finishedGoodDebitAccountId}
                  onChange={(e) => setFinishedGoodDebitAccountId(e.target.value)}
                >
                  <option value="">Pilih akun...</option>
                  {leafAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="raw_material_account">Akun Persediaan Bahan Baku (kredit)</Label>
                <Select
                  id="raw_material_account"
                  value={rawMaterialCreditAccountId}
                  onChange={(e) => setRawMaterialCreditAccountId(e.target.value)}
                >
                  <option value="">Pilih akun...</option>
                  {leafAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </Select>
              </div>
            </div>

            {formError && <FormError>{formError}</FormError>}

            <Button type="submit" disabled={submitting} className="w-fit">
              {submitting ? "Memproses..." : "Jalankan Produksi"}
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
