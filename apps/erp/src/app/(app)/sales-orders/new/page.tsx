"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import { fetchWalkInCustomerId } from "@/lib/pos-settings/schema";
import type { Customer } from "@/lib/customers/schema";
import type { Item } from "@/lib/items/schema";
import type { ItemUnit } from "@/lib/item-units/schema";
import { createSalesOrderSchema, type CreateSalesOrderInput } from "@/lib/sales-orders/schema";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { UomPriceQtyInput, type UomQtyChange } from "@/components/ui/uom-price-qty-input";
import { LoadingScreen } from "@/components/ui/loading-screen";

type LineInput = { item_id: string; qty_ordered: string; unit_price: string };

function emptyLine(): LineInput {
  return { item_id: "", qty_ordered: "", unit_price: "" };
}

export default function NewSalesOrderPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [itemUnits, setItemUnits] = useState<ItemUnit[]>([]);
  const [roles, setRoles] = useState<string[]>([]);

  const [customerId, setCustomerId] = useState("");
  const [soDate, setSoDate] = useState("");
  const [expectedDate, setExpectedDate] = useState("");
  const [lines, setLines] = useState<LineInput[]>([emptyLine()]);
  const [formError, setFormError] = useState<string | null>(null);

  const loadCustomers = useCallback(async () => {
    const walkInCustomerId = await fetchWalkInCustomerId();
    let query = supabase
      .from("counterparties")
      .select("id, name, contact, payment_term_days, archived_at, counterparty_type_mapping!inner(role)")
      .eq("counterparty_type_mapping.role", "customer")
      .order("name");
    if (walkInCustomerId) query = query.neq("id", walkInCustomerId);
    const { data } = await query;
    setCustomers((data ?? []) as unknown as Customer[]);
  }, []);

  const loadItems = useCallback(async () => {
    const [{ data }, { data: units }] = await Promise.all([
      supabase
        .from("items")
        .select("id, name, item_type, uom, inventory_account_id, archived_at")
        .order("name"),
      supabase.from("item_units").select("id, item_id, unit_label, conversion_factor, price, is_base"),
    ]);
    setItems((data ?? []) as Item[]);
    setItemUnits((units ?? []) as ItemUnit[]);
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
      await Promise.all([loadCustomers(), loadItems()]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadCustomers, loadItems]);

  const createMutation = useMutation({
    mutationFn: async (input: CreateSalesOrderInput) => {
      const sourceRef = await generateDocumentNumber("sales_orders");
      const { data, error } = await supabase.rpc("create_order", {
        p_direction: "SALE",
        p_counterparty_id: input.customer_id,
        p_order_date: input.so_date,
        p_expected_date: input.expected_date || null,
        p_source_ref: sourceRef,
        p_lines: input.lines,
      });
      if (error) throw new Error(error.message);
      return data as string;
    },
    onSuccess: (newId) => {
      router.push(`/sales-orders/${newId}`);
    },
    onError: (err) => {
      setFormError(err instanceof Error ? err.message : "Gagal menyimpan sales order");
    },
  });

  function updateLine(index: number, patch: Partial<LineInput>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function updateLineQty(index: number, change: UomQtyChange | null) {
    updateLine(index, {
      qty_ordered: change ? String(change.baseQty) : "",
      unit_price: change ? String(change.basePrice) : "",
    });
  }

  function addLine() {
    setLines((prev) => [...prev, emptyLine()]);
  }

  function removeLine(index: number) {
    setLines((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  }

  const totalValue = lines.reduce(
    (sum, l) => sum + (parseFloat(l.qty_ordered) || 0) * (parseFloat(l.unit_price) || 0),
    0
  );

  function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const parsed = createSalesOrderSchema.safeParse({
      customer_id: customerId,
      so_date: soDate,
      expected_date: expectedDate || undefined,
      lines: lines.map((l) => ({
        item_id: l.item_id,
        qty_ordered: l.qty_ordered,
        unit_price: l.unit_price,
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
  // Cuma barang yang punya minimal 1 item_units berharga yang bisa dipesan lewat form ini --
  // harga wajib otomatis dari item_units.price, gak ada lagi jalur input manual (lihat
  // docs/domain/inventory.md submodule "Satuan Jual & Harga").
  const sellableItems = items.filter((item) =>
    itemUnits.some((u) => u.item_id === item.id && u.price != null)
  );

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/sales-orders" label="Kembali ke Sales Order" />

      <div>
        <h1 className="text-xl font-semibold text-black">Buat Sales Order</h1>
        <p className="text-sm text-slate-500">
          Belum ada jurnal apa pun di titik ini — piutang & pendapatan baru diakui nanti pas
          barang beneran dikirim, lewat <span className="font-medium">Barang Keluar</span>{" "}
          (halaman detail sales order ini).
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
                <Label htmlFor="customer">Pelanggan</Label>
                <Select id="customer" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                  <option value="">Pilih pelanggan...</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="so_date">Tanggal Pesan</Label>
                <Input id="so_date" type="date" value={soDate} onChange={(e) => setSoDate(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="expected_date">Butuh Tanggal</Label>
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
              <div className="grid grid-cols-[1fr_minmax(14rem,auto)_2.5rem] gap-2 text-sm font-medium text-slate-500">
                <span>Item</span>
                <span>Qty & Satuan (harga otomatis)</span>
                <span />
              </div>
              {lines.map((line, i) => {
                const unitsForItem = itemUnits.filter((u) => u.item_id === line.item_id && u.price != null);
                return (
                  <div key={i} className="grid grid-cols-[1fr_minmax(14rem,auto)_2.5rem] gap-2">
                    <Select
                      value={line.item_id}
                      onChange={(e) => updateLine(i, { item_id: e.target.value, qty_ordered: "", unit_price: "" })}
                    >
                      <option value="">Pilih item...</option>
                      {sellableItems.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name} ({item.uom})
                        </option>
                      ))}
                    </Select>
                    {line.item_id && unitsForItem.length > 0 ? (
                      <UomPriceQtyInput key={line.item_id} units={unitsForItem} onChange={(change) => updateLineQty(i, change)} />
                    ) : (
                      <span className="flex items-center text-xs text-slate-400">
                        {line.item_id ? "Barang ini belum punya harga jual" : "Pilih item dulu"}
                      </span>
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
              {sellableItems.length === 0 && (
                <p className="text-xs text-amber-600">
                  Belum ada barang dengan harga jual (item_units). Tambah satuan + harga di
                  halaman Items dulu.
                </p>
              )}
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
              {createMutation.isPending ? "Menyimpan..." : "Simpan Sales Order"}
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
