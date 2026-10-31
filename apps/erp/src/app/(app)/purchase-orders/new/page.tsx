"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import { createPurchaseOrderSchema, type CreatePurchaseOrderInput } from "@/lib/purchase-orders/schema";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { DraftNotice } from "@/components/ui/draft-notice";
import { useFormDraft } from "@/lib/form-draft/use-form-draft";
import { UnitCostQtyInput, type UnitCostEntered, type UnitCostQtyChange } from "@/components/ui/unit-cost-qty-input";
import { LoadingScreen } from "@/components/ui/loading-screen";
import { ItemPicker } from "@/components/pickers/item-picker";
import { useItemCache } from "@/lib/pickers/use-item-cache";
import { CounterpartyPicker } from "@/components/pickers/counterparty-picker";

type LineInput = { item_id: string; qty_ordered: string; unit_cost_expected: string; entered?: UnitCostEntered };

function emptyLine(): LineInput {
  return { item_id: "", qty_ordered: "", unit_cost_expected: "" };
}

export default function NewPurchaseOrderPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const { items, itemUnits, remember } = useItemCache();
  const [roles, setRoles] = useState<string[]>([]);

  const [supplierId, setSupplierId] = useState("");
  const [poDate, setPoDate] = useState("");
  const [expectedDate, setExpectedDate] = useState("");
  const [lines, setLines] = useState<LineInput[]>([emptyLine()]);
  const [formError, setFormError] = useState<string | null>(null);
  const draft = useFormDraft(
    "purchase-orders/new",
    { supplierId, poDate, expectedDate, lines },
    (d) => {
      setSupplierId(d.supplierId);
      setPoDate(d.poDate);
      setExpectedDate(d.expectedDate);
      setLines(d.lines);
    },
    !checkingSession
  );

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
      
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router]);

  const createMutation = useMutation({
    mutationFn: async (input: CreatePurchaseOrderInput) => {
      const sourceRef = await generateDocumentNumber("purchase_orders");
      const { data, error } = await supabase.rpc("create_order", {
        p_direction: "PURCHASE",
        p_counterparty_id: input.supplier_id,
        p_order_date: input.po_date,
        p_expected_date: input.expected_date || null,
        p_source_ref: sourceRef,
        p_lines: input.lines,
      });
      if (error) throw new Error(error.message);
      return data as string;
    },
    onSuccess: (newId) => {
      draft.clear();
      router.push(`/purchase-orders/${newId}`);
    },
    onError: (err) => {
      setFormError(err instanceof Error ? err.message : "Gagal menyimpan purchase order");
    },
  });

  function updateLine(index: number, patch: Partial<LineInput>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function updateLineQtyCost(index: number, change: UnitCostQtyChange | null) {
    updateLine(index, {
      qty_ordered: change ? String(change.baseQty) : "",
      unit_cost_expected: change ? String(change.baseCost) : "",
    });
  }

  function addLine() {
    setLines((prev) => [...prev, emptyLine()]);
  }

  function removeLine(index: number) {
    setLines((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  }

  const totalValue = lines.reduce(
    (sum, l) => sum + (parseFloat(l.qty_ordered) || 0) * (parseFloat(l.unit_cost_expected) || 0),
    0
  );

  function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const parsed = createPurchaseOrderSchema.safeParse({
      supplier_id: supplierId,
      po_date: poDate,
      expected_date: expectedDate || undefined,
      lines: lines.map((l) => ({
        item_id: l.item_id,
        qty_ordered: l.qty_ordered,
        unit_price: l.unit_cost_expected,
      })),
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
      <BackLink href="/purchase-orders" label="Kembali ke Purchase Order" />
      <DraftNotice draft={draft} />

      <div>
        <h1 className="text-xl font-semibold text-black">Buat Purchase Order</h1>
        <p className="text-sm text-slate-500">
          Pesanan pembelian ke supplier. Belum bikin jurnal apa pun di titik ini — beban
          persediaan & utang baru diakui nanti pas barang beneran diterima, lewat halaman detail
          purchase order ini.
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
                <Label htmlFor="supplier">Supplier</Label>
                <CounterpartyPicker id="supplier" role="supplier" value={supplierId} onChange={setSupplierId} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="po_date">Tanggal PO</Label>
                <Input id="po_date" type="date" value={poDate} onChange={(e) => setPoDate(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="expected_date">Estimasi Tiba</Label>
                <Input
                  id="expected_date"
                  type="date"
                  value={expectedDate}
                  onChange={(e) => setExpectedDate(e.target.value)}
                />
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <p className="mb-3 text-sm font-medium text-black">Item Pesanan</p>
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-[1fr_minmax(16rem,auto)_2.5rem] gap-2 text-sm font-medium text-slate-500">
                <span>Item</span>
                <span>Qty, Satuan & Harga Beli</span>
                <span />
              </div>
              {lines.map((line, i) => {
                const selectedItem = items.find((it) => it.id === line.item_id);
                const unitsForItem = itemUnits.filter((u) => u.item_id === line.item_id);
                return (
                  <div key={i} className="grid grid-cols-[1fr_minmax(16rem,auto)_2.5rem] gap-2">
                    <ItemPicker
                      value={line.item_id}
                      onChange={(id) => updateLine(i, { item_id: id, qty_ordered: "", unit_cost_expected: "" })}
                      onResolve={remember}
                    />
                    {line.item_id && selectedItem ? (
                      <UnitCostQtyInput
                        key={line.item_id}
                        units={unitsForItem}
                        baseUom={selectedItem.uom}
                        initialEntered={line.entered}
                        onEnteredChange={(entered) => updateLine(i, { entered })}
                        onChange={(change) => updateLineQtyCost(i, change)}
                      />
                    ) : (
                      <span className="flex items-center text-xs text-slate-400">Pilih item dulu</span>
                    )}
                    <button
                      type="button"
                      onClick={() => removeLine(i)}
                      disabled={lines.length <= 1}
                      className="text-slate-400 hover:text-red-600 disabled:opacity-30"
                      aria-label="Hapus baris"
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
              <Button type="button" variant="secondary" onClick={addLine} className="w-fit">
                + Tambah item
              </Button>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4 lg:sticky lg:top-4 lg:col-span-1 lg:self-start">
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <p className="text-sm text-slate-500">Nilai Pesanan</p>
            <p className="mt-1 font-mono text-2xl text-black">Rp{totalValue.toLocaleString("id-ID")}</p>
          </div>

          {formError && <FormError>{formError}</FormError>}

          <div className="flex flex-col gap-2">
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? "Menyimpan..." : "Simpan PO"}
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
