"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import { poStatus, lineRemaining, type PurchaseOrder } from "@/lib/purchase-orders/schema";
import { createGoodsReceiptSchema, type CreateGoodsReceiptInput } from "@/lib/goods-receipts/schema";
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS, useGoodsReceipts } from "@/lib/goods-receipts/queries";
import { generateDocumentNumber } from "@/lib/document-numbers";
import type { ItemUnit } from "@/lib/item-units/schema";
import type { Item } from "@/lib/items/schema";
import type { Supplier } from "@/lib/suppliers/schema";
import { fetchTaxSettings, resolvedPpnMasukan, type TaxSettings } from "@/lib/tax-settings/schema";
import {
  resolveChargeLines,
  resolveChargeLineLegs,
  type ChargeLineInput,
  type ChargeCategoryWithAccount,
} from "@/lib/charge-lines/schema";
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
import { UnitCostQtyInput, type UnitCostQtyChange } from "@/components/ui/unit-cost-qty-input";
import { Pagination } from "@/components/ui/pagination";

type LineInput = {
  order_line_id?: string;
  item_id: string;
  item_label: string;
  uom: string;
  qty_received: string;
  unit_cost: string;
};

function emptyDirectLine(): LineInput {
  return { order_line_id: undefined, item_id: "", item_label: "", uom: "", qty_received: "", unit_cost: "" };
}

// Input kecil buat baris filter di header tabel -- pola sama kayak journal-entries/page.tsx.
const compactFilterInputClass =
  "w-full rounded border border-slate-200 bg-white px-1.5 py-1 text-xs font-normal normal-case text-slate-700 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-1 focus:ring-blue-600/40";

export default function GoodsReceiptsPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [checkingSession, setCheckingSession] = useState(true);
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([]);
  const [itemUnits, setItemUnits] = useState<ItemUnit[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [roles, setRoles] = useState<string[]>([]);

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [purchaseOrderFilter, setPurchaseOrderFilter] = useState("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);

  const [receiptMode, setReceiptMode] = useState<"FROM_PO" | "DIRECT">("FROM_PO");
  const [purchaseOrderId, setPurchaseOrderId] = useState("");
  const [directSupplierId, setDirectSupplierId] = useState("");
  const [receiptDate, setReceiptDate] = useState("");
  const [deliveryNoteRef, setDeliveryNoteRef] = useState("");
  const [billDescription, setBillDescription] = useState("");
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});
  const [lines, setLines] = useState<LineInput[]>([]);
  const [extraLines, setExtraLines] = useState<ChargeLineInput[]>([]);
  const [expenseCategories, setExpenseCategories] = useState<ChargeCategoryWithAccount[]>([]);
  const [taxSettings, setTaxSettings] = useState<TaxSettings | null>(null);
  const [applyTax, setApplyTax] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const receivablePOs = purchaseOrders.filter(
    (po) => poStatus(po) !== "FULLY_RECEIVED" && poStatus(po) !== "CANCELLED"
  );

  // Filter berubah -> balik ke halaman 1 (pola "adjust state during render", bukan useEffect --
  // lihat journal-entries/page.tsx).
  const filterKey = `${dateFrom}|${dateTo}|${purchaseOrderFilter}|${pageSize}`;
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey);
  if (filterKey !== prevFilterKey) {
    setPrevFilterKey(filterKey);
    setPage(0);
  }

  const filters = {
    dateFrom,
    dateTo,
    purchaseOrderId: purchaseOrderFilter,
    page,
    pageSize,
  };
  const receiptsQuery = useGoodsReceipts(filters);
  const receipts = receiptsQuery.data?.rows ?? [];
  const total = receiptsQuery.data?.total ?? 0;

  const loadPurchaseOrders = useCallback(async () => {
    const { data } = await supabase
      .from("orders")
      .select(
        "id, counterparty_id, order_date, expected_date, source_ref, created_at, cancelled_at, counterparties(name), order_lines(id, item_id, qty_ordered, unit_price, items(name, uom), goods_receipt_lines(qty_received))"
      )
      .eq("direction", "PURCHASE")
      .order("order_date", { ascending: false });
    setPurchaseOrders((data ?? []) as unknown as PurchaseOrder[]);
  }, []);

  const loadItemUnits = useCallback(async () => {
    const { data } = await supabase
      .from("item_units")
      .select("id, item_id, unit_label, conversion_factor, price, is_base");
    setItemUnits((data ?? []) as ItemUnit[]);
  }, []);

  const loadItems = useCallback(async () => {
    const { data } = await supabase
      .from("items")
      .select("id, name, item_type, uom, inventory_account_id, archived_at")
      .order("name");
    setItems((data ?? []) as Item[]);
  }, []);

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
      await Promise.all([
        loadPurchaseOrders(),
        loadItemUnits(),
        loadItems(),
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
  }, [
    router,
    loadPurchaseOrders,
    loadItemUnits,
    loadItems,
    loadSuppliers,
    loadDefaultAccounts,
    loadExpenseCategories,
    loadTaxSettings,
  ]);

  function selectPurchaseOrder(poId: string) {
    setPurchaseOrderId(poId);
    const po = purchaseOrders.find((p) => p.id === poId);
    if (!po) {
      setLines([]);
      return;
    }
    setLines(
      po.order_lines
        .filter((l) => lineRemaining(l) > 0)
        .map((l) => ({
          order_line_id: l.id,
          item_id: l.item_id,
          item_label: `${l.items.name} (sisa ${lineRemaining(l)} ${l.items.uom})`,
          uom: l.items.uom,
          qty_received: String(lineRemaining(l)),
          unit_cost: String(l.unit_price),
        }))
    );
  }

  // Fase 2 order-generalization: PO opsional -- mode "DIRECT" gak prefill dari PO lines
  // sama sekali, item dipilih manual sendiri-sendiri (pola sama purchase-orders/page.tsx).
  function switchMode(mode: "FROM_PO" | "DIRECT") {
    setReceiptMode(mode);
    setPurchaseOrderId("");
    setDirectSupplierId("");
    setLines(mode === "DIRECT" ? [emptyDirectLine()] : []);
  }

  function addDirectLine() {
    setLines((prev) => [...prev, emptyDirectLine()]);
  }

  function removeDirectLine(index: number) {
    setLines((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  }

  function updateLine(index: number, patch: Partial<LineInput>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function updateLineQtyCost(index: number, change: UnitCostQtyChange | null) {
    updateLine(index, {
      qty_received: change ? String(change.baseQty) : "",
      unit_cost: change ? String(change.baseCost) : "",
    });
  }

  const createMutation = useMutation({
    mutationFn: async (input: CreateGoodsReceiptInput) => {
      const billSourceRef = await generateDocumentNumber("ap_bills");
      const { error } = await supabase.rpc("create_goods_receipt", {
        p_order_id: input.order_id ?? null,
        p_receipt_date: input.receipt_date,
        p_delivery_note_ref: input.delivery_note_ref || null,
        p_lines: input.lines,
        p_bill_description: input.bill_description || null,
        p_bill_source_ref: billSourceRef,
        p_debit_account_id: input.debit_account_id,
        p_payable_account_id: input.payable_account_id,
        p_extra_debit_lines: input.extra_debit_lines,
        p_apply_tax: input.apply_tax,
        p_supplier_id: input.supplier_id ?? null,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      setReceiptMode("FROM_PO");
      setPurchaseOrderId("");
      setDirectSupplierId("");
      setReceiptDate("");
      setDeliveryNoteRef("");
      setBillDescription("");
      setLines([]);
      setExtraLines([]);
      setApplyTax(false);
      setShowForm(false);
      queryClient.invalidateQueries({ queryKey: ["goods_receipt_notes"] });
      loadPurchaseOrders();
    },
    onError: (err) => {
      setFormError(err instanceof Error ? err.message : "Gagal menyimpan goods receipt");
    },
  });

  function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const activeLines = lines.filter((l) => parseFloat(l.qty_received) > 0);

    const parsed = createGoodsReceiptSchema.safeParse({
      order_id: receiptMode === "FROM_PO" ? purchaseOrderId : undefined,
      supplier_id: receiptMode === "DIRECT" ? directSupplierId : undefined,
      receipt_date: receiptDate,
      delivery_note_ref: deliveryNoteRef || undefined,
      bill_description: billDescription || undefined,
      debit_account_id: defaultAccounts["inventory.raw_material"]?.id ?? "",
      payable_account_id: defaultAccounts["ap.payable"]?.id ?? "",
      lines: activeLines.map((l) => ({
        order_line_id: l.order_line_id || undefined,
        item_id: l.item_id,
        qty_received: l.qty_received,
        unit_cost: l.unit_cost,
      })),
      extra_debit_lines: resolveChargeLines(extraLines, expenseCategories),
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
        <h1 className="text-xl font-semibold text-black">Goods Receipts</h1>
        <p className="text-sm text-slate-500">
          Role kamu:{" "}
          {roles.length > 0 ? roles.join(", ") : "belum ada role — cuma bisa lihat"}
        </p>
      </div>

      {receiptsQuery.error && (
        <FormError>{(receiptsQuery.error as Error).message}</FormError>
      )}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-black">Goods Receipts</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
              {total}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="toolbar" onClick={() => receiptsQuery.refetch()}>
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
              <th className="px-4 py-2">PO</th>
              <th className="px-4 py-2">Tanggal</th>
              <th className="px-4 py-2">Items Diterima</th>
              <th className="px-4 py-2">Bill</th>
              <th className="px-4 py-2 text-right">Jumlah</th>
            </tr>
            <tr className="border-b border-slate-200 bg-slate-50/50">
              <th className="px-4 py-1.5" />
              <th className="px-4 py-1.5">
                <select
                  aria-label="Filter purchase order"
                  value={purchaseOrderFilter}
                  onChange={(e) => setPurchaseOrderFilter(e.target.value)}
                  className={compactFilterInputClass}
                >
                  <option value="">Semua PO</option>
                  {purchaseOrders.map((po) => (
                    <option key={po.id} value={po.id}>
                      {po.source_ref}
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
              <th className="px-4 py-1.5" />
              <th className="px-4 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {receipts.map((grn) => (
              <tr
                key={grn.id}
                className="cursor-pointer border-b border-slate-100 align-top hover:bg-slate-50"
                onClick={() => router.push(`/goods-receipts/${grn.id}`)}
              >
                <td className="px-4 py-2 font-medium text-black">
                  {grn.orders?.counterparties.name ?? grn.ap_bills.counterparties.name}
                </td>
                <td className="px-4 py-2">
                  {grn.orders ? (
                    grn.orders.source_ref
                  ) : (
                    <span className="text-slate-400">— (langsung)</span>
                  )}
                </td>
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
                  {receiptsQuery.isLoading ? "Memuat..." : "Belum ada goods receipt."}
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

      <Modal
        open={showForm}
        onClose={() => setShowForm(false)}
        title="Terima Barang + Bikin Bill"
        maxWidth="max-w-4xl"
      >
        {!canWrite && (
          <p className="mb-4 text-sm text-amber-600">
            Kamu belum punya role admin/accountant — submit di bawah kemungkinan bakal
            ketolak RLS.
          </p>
        )}
        <div className="mb-4 flex gap-2">
          <Button
            type="button"
            variant={receiptMode === "FROM_PO" ? "toolbar-primary" : "secondary"}
            onClick={() => switchMode("FROM_PO")}
          >
            Dari Purchase Order
          </Button>
          <Button
            type="button"
            variant={receiptMode === "DIRECT" ? "toolbar-primary" : "secondary"}
            onClick={() => switchMode("DIRECT")}
          >
            Langsung Tanpa PO
          </Button>
        </div>
        <JournalPreviewPanel
          groups={[
            [
              {
                label: "Akun Persediaan (debit)",
                resolved: defaultAccounts["inventory.raw_material"],
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
        <form onSubmit={handleCreate} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {receiptMode === "FROM_PO" ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="po">Purchase Order</Label>
                  <Select id="po" value={purchaseOrderId} onChange={(e) => selectPurchaseOrder(e.target.value)}>
                    <option value="">Pilih PO...</option>
                    {receivablePOs.map((po) => (
                      <option key={po.id} value={po.id}>
                        {po.source_ref} — {po.counterparties.name}
                      </option>
                    ))}
                  </Select>
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="direct_supplier">Supplier</Label>
                  <Select
                    id="direct_supplier"
                    value={directSupplierId}
                    onChange={(e) => setDirectSupplierId(e.target.value)}
                  >
                    <option value="">Pilih supplier...</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </div>
              )}
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
                <Label htmlFor="bill_description">Deskripsi Bill</Label>
                <Input
                  id="bill_description"
                  placeholder="mis. Terima tepung dari Toko Tepung Makmur"
                  value={billDescription}
                  onChange={(e) => setBillDescription(e.target.value)}
                />
              </div>
              <LockedAccountField
                label="Akun Persediaan (debit)"
                htmlFor="debit_account"
                resolved={defaultAccounts["inventory.raw_material"]}
              />
              <LockedAccountField
                label="Akun Utang Usaha (kredit)"
                htmlFor="payable_account"
                resolved={defaultAccounts["ap.payable"]}
              />
            </div>

            {receiptMode === "FROM_PO" && purchaseOrderId && (
              <div className="flex flex-col gap-2">
                <div className="grid grid-cols-[1fr_minmax(16rem,auto)] gap-2 text-sm font-medium text-slate-500">
                  <span>Item (sisa PO)</span>
                  <span>Qty, Satuan & Harga Riil</span>
                </div>
                {lines.length === 0 && (
                  <p className="text-sm text-slate-400">PO ini sudah diterima penuh.</p>
                )}
                {lines.map((line, i) => (
                  <div key={line.order_line_id} className="grid grid-cols-[1fr_minmax(16rem,auto)] gap-2">
                    <span className="flex items-center text-sm text-slate-700">{line.item_label}</span>
                    <UnitCostQtyInput
                      units={itemUnits.filter((u) => u.item_id === line.item_id)}
                      baseUom={line.uom}
                      initialBaseQty={line.qty_received}
                      initialBaseCost={line.unit_cost}
                      onChange={(change) => updateLineQtyCost(i, change)}
                    />
                  </div>
                ))}
              </div>
            )}

            {receiptMode === "DIRECT" && (
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
                      <Select
                        value={line.item_id}
                        onChange={(e) =>
                          updateLine(i, { item_id: e.target.value, qty_received: "", unit_cost: "" })
                        }
                      >
                        <option value="">Pilih item...</option>
                        {items.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name} ({item.uom})
                          </option>
                        ))}
                      </Select>
                      {line.item_id ? (
                        <UnitCostQtyInput
                          key={line.item_id}
                          units={unitsForItem}
                          baseUom={selectedItem?.uom ?? ""}
                          onChange={(change) => updateLineQtyCost(i, change)}
                        />
                      ) : (
                        <span className="flex items-center text-xs text-slate-400">Pilih item dulu</span>
                      )}
                      <button
                        type="button"
                        onClick={() => removeDirectLine(i)}
                        disabled={lines.length <= 1}
                        className="text-slate-400 hover:text-red-600 disabled:opacity-30"
                        aria-label="Hapus baris"
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
                <Button type="button" variant="secondary" onClick={addDirectLine} className="w-fit">
                  + Tambah item
                </Button>
              </div>
            )}

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
                {createMutation.isPending ? "Menyimpan..." : "Simpan Penerimaan"}
              </Button>
            </div>
        </form>
      </Modal>
    </div>
  );
}
