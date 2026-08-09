"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { getLeafAccounts, type Account } from "@/lib/accounts/schema";
import { poStatus, lineRemaining, type PurchaseOrder } from "@/lib/purchase-orders/schema";
import { createGoodsReceiptSchema, type GoodsReceiptNote } from "@/lib/goods-receipts/schema";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";

type LineInput = {
  po_line_id: string;
  item_id: string;
  item_label: string;
  qty_received: string;
  unit_cost: string;
};

export default function GoodsReceiptsPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([]);
  const [receipts, setReceipts] = useState<GoodsReceiptNote[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [purchaseOrderId, setPurchaseOrderId] = useState("");
  const [receiptDate, setReceiptDate] = useState("");
  const [deliveryNoteRef, setDeliveryNoteRef] = useState("");
  const [billDescription, setBillDescription] = useState("");
  const [billSourceRef, setBillSourceRef] = useState("");
  const [debitAccountId, setDebitAccountId] = useState("");
  const [payableAccountId, setPayableAccountId] = useState("");
  const [lines, setLines] = useState<LineInput[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const leafAccounts = getLeafAccounts(accounts);
  const receivablePOs = purchaseOrders.filter((po) => poStatus(po) !== "FULLY_RECEIVED");

  const loadReceipts = useCallback(async () => {
    const { data, error } = await supabase
      .from("goods_receipt_notes")
      .select(
        "id, purchase_order_id, bill_id, delivery_note_ref, receipt_date, created_at, purchase_orders(source_ref, suppliers(name)), ap_bills(source_ref, amount), goods_receipt_lines(id, item_id, qty_received, unit_cost, items(name, uom))"
      )
      .order("receipt_date", { ascending: false });
    if (error) {
      setLoadError(error.message);
      return;
    }
    setLoadError(null);
    setReceipts((data ?? []) as unknown as GoodsReceiptNote[]);
  }, []);

  const loadPurchaseOrders = useCallback(async () => {
    const { data } = await supabase
      .from("purchase_orders")
      .select(
        "id, supplier_id, po_date, expected_date, source_ref, created_at, suppliers(name), purchase_order_lines(id, item_id, qty_ordered, unit_cost_expected, items(name, uom), goods_receipt_lines(qty_received))"
      )
      .order("po_date", { ascending: false });
    setPurchaseOrders((data ?? []) as unknown as PurchaseOrder[]);
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
      await Promise.all([loadPurchaseOrders(), loadAccounts(), loadReceipts()]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadPurchaseOrders, loadAccounts, loadReceipts]);

  function selectPurchaseOrder(poId: string) {
    setPurchaseOrderId(poId);
    const po = purchaseOrders.find((p) => p.id === poId);
    if (!po) {
      setLines([]);
      return;
    }
    setLines(
      po.purchase_order_lines
        .filter((l) => lineRemaining(l) > 0)
        .map((l) => ({
          po_line_id: l.id,
          item_id: l.item_id,
          item_label: `${l.items.name} (sisa ${lineRemaining(l)} ${l.items.uom})`,
          qty_received: String(lineRemaining(l)),
          unit_cost: String(l.unit_cost_expected),
        }))
    );
  }

  function updateLine(index: number, patch: Partial<LineInput>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const activeLines = lines.filter((l) => parseFloat(l.qty_received) > 0);

    const parsed = createGoodsReceiptSchema.safeParse({
      purchase_order_id: purchaseOrderId,
      receipt_date: receiptDate,
      delivery_note_ref: deliveryNoteRef || undefined,
      bill_description: billDescription || undefined,
      bill_source_ref: billSourceRef,
      debit_account_id: debitAccountId,
      payable_account_id: payableAccountId,
      lines: activeLines.map((l) => ({
        po_line_id: l.po_line_id,
        item_id: l.item_id,
        qty_received: l.qty_received,
        unit_cost: l.unit_cost,
      })),
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setSubmitting(true);
    const { error } = await supabase.rpc("create_goods_receipt", {
      p_purchase_order_id: parsed.data.purchase_order_id,
      p_receipt_date: parsed.data.receipt_date,
      p_delivery_note_ref: parsed.data.delivery_note_ref || null,
      p_lines: parsed.data.lines,
      p_bill_description: parsed.data.bill_description || null,
      p_bill_source_ref: parsed.data.bill_source_ref,
      p_debit_account_id: parsed.data.debit_account_id,
      p_payable_account_id: parsed.data.payable_account_id,
    });
    setSubmitting(false);
    if (error) {
      setFormError(error.message);
      return;
    }

    setPurchaseOrderId("");
    setReceiptDate("");
    setDeliveryNoteRef("");
    setBillDescription("");
    setBillSourceRef("");
    setDebitAccountId("");
    setPayableAccountId("");
    setLines([]);
    setShowForm(false);
    await Promise.all([loadReceipts(), loadPurchaseOrders()]);
  }

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");

  return (
    <div className="flex w-full max-w-5xl flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">Goods Receipts — CV Roti Barokah</h1>
        <p className="text-sm text-slate-500">
          Role kamu:{" "}
          {roles.length > 0 ? roles.join(", ") : "belum ada role — cuma bisa lihat"}
        </p>
      </div>

      {loadError && <FormError>{loadError}</FormError>}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-black">Goods Receipts</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
              {receipts.length}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="toolbar" onClick={() => loadReceipts()}>
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
              <th className="px-4 py-2">Supplier</th>
              <th className="px-4 py-2">PO</th>
              <th className="px-4 py-2">Tanggal</th>
              <th className="px-4 py-2">Items Diterima</th>
              <th className="px-4 py-2">Bill</th>
              <th className="px-4 py-2 text-right">Jumlah</th>
            </tr>
          </thead>
          <tbody>
            {receipts.map((grn) => (
              <tr
                key={grn.id}
                className="cursor-pointer border-b border-slate-100 align-top hover:bg-slate-50"
                onClick={() => router.push(`/goods-receipts/${grn.id}`)}
              >
                <td className="px-4 py-2 font-medium text-black">{grn.purchase_orders.suppliers.name}</td>
                <td className="px-4 py-2">{grn.purchase_orders.source_ref}</td>
                <td className="whitespace-nowrap px-4 py-2">{grn.receipt_date}</td>
                <td className="px-4 py-2">
                  <ul className="space-y-0.5">
                    {grn.goods_receipt_lines.map((l) => (
                      <li key={l.id}>
                        {l.items.name} — {l.qty_received} {l.items.uom} @ {l.unit_cost.toLocaleString("id-ID")}
                      </li>
                    ))}
                  </ul>
                </td>
                <td className="px-4 py-2">{grn.ap_bills.source_ref}</td>
                <td className="px-4 py-2 text-right font-mono">
                  {grn.ap_bills.amount.toLocaleString("id-ID")}
                </td>
              </tr>
            ))}
            {receipts.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                  Belum ada goods receipt.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showForm && (
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 font-semibold text-black">Terima Barang + Bikin Bill</h2>
          {!canWrite && (
            <p className="mb-4 text-sm text-amber-600">
              Kamu belum punya role admin/accountant — submit di bawah kemungkinan bakal
              ketolak RLS.
            </p>
          )}
          <form onSubmit={handleCreate} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="po">Purchase Order</Label>
                <Select id="po" value={purchaseOrderId} onChange={(e) => selectPurchaseOrder(e.target.value)}>
                  <option value="">Pilih PO...</option>
                  {receivablePOs.map((po) => (
                    <option key={po.id} value={po.id}>
                      {po.source_ref} — {po.suppliers.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="receipt_date">Tanggal Terima</Label>
                <Input
                  id="receipt_date"
                  type="date"
                  value={receiptDate}
                  onChange={(e) => setReceiptDate(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="delivery_note_ref">No. Surat Jalan</Label>
                <Input
                  id="delivery_note_ref"
                  placeholder="mis. SJ-TEPUNG-003"
                  value={deliveryNoteRef}
                  onChange={(e) => setDeliveryNoteRef(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="bill_source_ref">Rujukan Bill (source_ref)</Label>
                <Input
                  id="bill_source_ref"
                  placeholder="mis. GRN-TEPUNG-003"
                  value={billSourceRef}
                  onChange={(e) => setBillSourceRef(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="bill_description">Deskripsi Bill</Label>
                <Input
                  id="bill_description"
                  placeholder="mis. Terima tepung dari Toko Tepung Makmur"
                  value={billDescription}
                  onChange={(e) => setBillDescription(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="debit_account">Akun Persediaan (debit)</Label>
                <Select id="debit_account" value={debitAccountId} onChange={(e) => setDebitAccountId(e.target.value)}>
                  <option value="">Pilih akun...</option>
                  {leafAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="payable_account">Akun Utang Usaha (kredit)</Label>
                <Select
                  id="payable_account"
                  value={payableAccountId}
                  onChange={(e) => setPayableAccountId(e.target.value)}
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

            {purchaseOrderId && (
              <div className="flex flex-col gap-2">
                <div className="grid grid-cols-[1fr_6rem_8rem] gap-2 text-sm font-medium text-slate-500">
                  <span>Item (sisa PO)</span>
                  <span>Qty Terima</span>
                  <span>Harga Riil/Unit</span>
                </div>
                {lines.length === 0 && (
                  <p className="text-sm text-slate-400">PO ini sudah diterima penuh.</p>
                )}
                {lines.map((line, i) => (
                  <div key={line.po_line_id} className="grid grid-cols-[1fr_6rem_8rem] gap-2">
                    <span className="flex items-center text-sm text-slate-700">{line.item_label}</span>
                    <Input
                      type="number"
                      min="0"
                      value={line.qty_received}
                      onChange={(e) => updateLine(i, { qty_received: e.target.value })}
                    />
                    <Input
                      type="number"
                      min="0"
                      value={line.unit_cost}
                      onChange={(e) => updateLine(i, { unit_cost: e.target.value })}
                    />
                  </div>
                ))}
              </div>
            )}

            {formError && <FormError>{formError}</FormError>}

            <Button type="submit" disabled={submitting} className="w-fit">
              {submitting ? "Menyimpan..." : "Simpan Penerimaan"}
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
