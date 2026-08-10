"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";

type CatalogItem = {
  id: string;
  name: string;
  uom: string;
  price: number;
  qtyOnHand: number;
};

type Customer = {
  id: string;
  name: string;
};

type CartLine = {
  item_id: string;
  name: string;
  unit_price: number;
  qty_sold: number;
  available: number;
};

type ChargeType = {
  id: string;
  name: string;
  account_id: string;
};

type TaxSettings = {
  is_active: boolean;
  ppn_rate: number;
};

type ExtraLine = { category_id: string; amount: string };

const ACCOUNT_CODES = {
  KAS_TOKO: "1100",
  KAS_BANK: "1200",
  PENDAPATAN_TOKO: "4100",
  HPP: "5100",
  PERSEDIAAN_BARANG_JADI: "1420",
} as const;

export default function CheckoutPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [accountIds, setAccountIds] = useState<Record<string, string>>({});
  const [chargeTypes, setChargeTypes] = useState<ChargeType[]>([]);
  const [taxSettings, setTaxSettings] = useState<TaxSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [cart, setCart] = useState<CartLine[]>([]);
  const [extraLines, setExtraLines] = useState<ExtraLine[]>([]);
  const [applyTax, setApplyTax] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<"CASH" | "QRIS">("CASH");
  const [customerId, setCustomerId] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const loadCatalog = useCallback(async () => {
    setLoading(true);
    setLoadError(null);

    const [itemsRes, accountsRes, customersRes, chargeTypesRes, taxSettingsRes] = await Promise.all([
      supabase
        .from("items")
        .select(
          "id, name, uom, item_units(price, is_base), inventory_balances(qty_on_hand)"
        )
        .eq("item_type", "FINISHED_GOOD")
        .is("archived_at", null)
        .order("name"),
      supabase
        .from("accounts")
        .select("id, code")
        .in("code", Object.values(ACCOUNT_CODES)),
      supabase.from("customers").select("id, name").is("archived_at", null).order("name"),
      supabase.from("pos_charge_types").select("id, name, account_id").is("archived_at", null).order("name"),
      supabase.from("tax_settings").select("is_active, ppn_rate").maybeSingle(),
    ]);

    if (itemsRes.error) {
      setLoadError(itemsRes.error.message);
      setLoading(false);
      return;
    }
    if (accountsRes.error) {
      setLoadError(accountsRes.error.message);
      setLoading(false);
      return;
    }

    const codeToId: Record<string, string> = {};
    for (const acc of accountsRes.data ?? []) {
      codeToId[acc.code as string] = acc.id as string;
    }
    setAccountIds(codeToId);
    setChargeTypes((chargeTypesRes.data ?? []) as ChargeType[]);
    setTaxSettings((taxSettingsRes.data ?? null) as TaxSettings | null);

    type ItemRow = {
      id: string;
      name: string;
      uom: string;
      item_units: { price: number | null; is_base: boolean }[] | null;
      inventory_balances: { qty_on_hand: number } | null;
    };

    const rows = (itemsRes.data ?? []) as unknown as ItemRow[];
    const mapped: CatalogItem[] = rows
      .map((row) => {
        const baseUnit = (row.item_units ?? []).find((u) => u.is_base);
        return {
          id: row.id,
          name: row.name,
          uom: row.uom,
          price: baseUnit?.price ?? 0,
          qtyOnHand: row.inventory_balances?.qty_on_hand ?? 0,
        };
      })
      .filter((item) => item.price > 0);
    setCatalog(mapped);

    setCustomers((customersRes.data ?? []) as Customer[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) {
        router.replace("/login");
        return;
      }
      if (!active) return;
      await loadCatalog();
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadCatalog]);

  const itemTotal = useMemo(
    () => cart.reduce((sum, line) => sum + line.qty_sold * line.unit_price, 0),
    [cart]
  );

  const extraTotal = useMemo(
    () =>
      extraLines.reduce((sum, l) => {
        const amount = Number(l.amount);
        return l.category_id && !Number.isNaN(amount) ? sum + amount : sum;
      }, 0),
    [extraLines]
  );

  const taxAmount = useMemo(() => {
    if (!applyTax || !taxSettings?.is_active) return 0;
    return Math.round((itemTotal + extraTotal) * taxSettings.ppn_rate) / 100;
  }, [applyTax, taxSettings, itemTotal, extraTotal]);

  const total = itemTotal + extraTotal + taxAmount;

  function addExtraLine() {
    setExtraLines((prev) => [...prev, { category_id: "", amount: "" }]);
  }
  function updateExtraLine(index: number, patch: Partial<ExtraLine>) {
    setExtraLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }
  function removeExtraLine(index: number) {
    setExtraLines((prev) => prev.filter((_, i) => i !== index));
  }

  function addToCart(item: CatalogItem) {
    setCheckoutError(null);
    setSuccessMessage(null);
    setCart((prev) => {
      const existing = prev.find((l) => l.item_id === item.id);
      if (existing) {
        return prev.map((l) =>
          l.item_id === item.id ? { ...l, qty_sold: l.qty_sold + 1 } : l
        );
      }
      return [
        ...prev,
        {
          item_id: item.id,
          name: item.name,
          unit_price: item.price,
          qty_sold: 1,
          available: item.qtyOnHand,
        },
      ];
    });
  }

  function updateQty(itemId: string, qty: number) {
    if (qty <= 0) {
      setCart((prev) => prev.filter((l) => l.item_id !== itemId));
      return;
    }
    setCart((prev) =>
      prev.map((l) => (l.item_id === itemId ? { ...l, qty_sold: qty } : l))
    );
  }

  function removeLine(itemId: string) {
    setCart((prev) => prev.filter((l) => l.item_id !== itemId));
  }

  async function checkout() {
    if (cart.length === 0) return;
    setSubmitting(true);
    setCheckoutError(null);
    setSuccessMessage(null);

    const cashAccountId =
      paymentMethod === "CASH" ? accountIds[ACCOUNT_CODES.KAS_TOKO] : accountIds[ACCOUNT_CODES.KAS_BANK];

    const resolvedExtraLines = extraLines
      .filter((l) => l.category_id && l.amount.trim() !== "")
      .map((l) => {
        const type = chargeTypes.find((c) => c.id === l.category_id);
        return { account_id: type?.account_id ?? "", amount: Number(l.amount) };
      });

    const { error } = await supabase.rpc("create_pos_sale", {
      p_sale_date: new Date().toISOString().slice(0, 10),
      p_source_ref: `POS-${Date.now()}`,
      p_customer_id: customerId || null,
      p_cash_account_id: cashAccountId,
      p_revenue_account_id: accountIds[ACCOUNT_CODES.PENDAPATAN_TOKO],
      p_hpp_account_id: accountIds[ACCOUNT_CODES.HPP],
      p_finished_good_account_id: accountIds[ACCOUNT_CODES.PERSEDIAAN_BARANG_JADI],
      p_extra_credit_lines: resolvedExtraLines,
      p_apply_tax: applyTax && !!taxSettings?.is_active,
      p_lines: cart.map((l) => ({
        item_id: l.item_id,
        qty_sold: l.qty_sold,
        unit_price: l.unit_price,
      })),
    });

    setSubmitting(false);

    if (error) {
      setCheckoutError(error.message);
      return;
    }

    setSuccessMessage(`Transaksi berhasil — total Rp${total.toLocaleString("id-ID")}`);
    setCart([]);
    setCustomerId("");
    setExtraLines([]);
    setApplyTax(false);
    loadCatalog();
  }

  if (checkingSession || loading) {
    return <div className="p-8 text-slate-500">Memuat...</div>;
  }

  if (loadError) {
    return <div className="p-8 text-red-600">Gagal memuat katalog: {loadError}</div>;
  }

  return (
    <div className="flex h-screen">
      <div className="flex-1 overflow-y-auto p-6">
        <h1 className="mb-4 text-xl font-semibold">Kasir — CV Roti Barokah</h1>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {catalog.map((item) => (
            <button
              key={item.id}
              onClick={() => addToCart(item)}
              disabled={item.qtyOnHand <= 0}
              className="rounded-lg border border-slate-200 p-4 text-left hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <div className="font-medium">{item.name}</div>
              <div className="text-sm text-slate-500">
                Rp{item.price.toLocaleString("id-ID")}/{item.uom}
              </div>
              <div className="text-xs text-slate-400">Stok: {item.qtyOnHand}</div>
            </button>
          ))}
          {catalog.length === 0 && (
            <div className="col-span-full text-slate-400">
              Belum ada barang jadi dengan harga jual (`item_units`) yang bisa dijual.
            </div>
          )}
        </div>
      </div>

      <div className="flex w-96 flex-col border-l border-slate-200 p-6">
        <h2 className="mb-3 font-semibold">Keranjang</h2>
        <div className="flex-1 space-y-2 overflow-y-auto">
          {cart.length === 0 && <div className="text-sm text-slate-400">Belum ada item.</div>}
          {cart.map((line) => (
            <div key={line.item_id} className="flex items-center justify-between gap-2 text-sm">
              <div className="flex-1">
                <div>{line.name}</div>
                <div className="text-slate-400">
                  Rp{line.unit_price.toLocaleString("id-ID")} × {line.qty_sold} = Rp
                  {(line.unit_price * line.qty_sold).toLocaleString("id-ID")}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  className="h-6 w-6 rounded border border-slate-300"
                  onClick={() => updateQty(line.item_id, line.qty_sold - 1)}
                >
                  −
                </button>
                <span className="w-6 text-center">{line.qty_sold}</span>
                <button
                  className="h-6 w-6 rounded border border-slate-300"
                  onClick={() => updateQty(line.item_id, line.qty_sold + 1)}
                  disabled={line.qty_sold >= line.available}
                >
                  +
                </button>
                <button
                  className="ml-1 text-red-500"
                  onClick={() => removeLine(line.item_id)}
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-4 space-y-3 border-t border-slate-200 pt-4">
          <div className="space-y-1.5">
            <label className="block text-xs text-slate-500">Biaya Tambahan (opsional)</label>
            {extraLines.map((line, i) => (
              <div key={i} className="flex gap-1.5">
                <select
                  className="flex-1 rounded border border-slate-300 px-2 py-1.5 text-sm"
                  value={line.category_id}
                  onChange={(e) => updateExtraLine(i, { category_id: e.target.value })}
                >
                  <option value="">Pilih kategori...</option>
                  {chargeTypes.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  min="0"
                  placeholder="0"
                  className="w-24 rounded border border-slate-300 px-2 py-1.5 text-sm"
                  value={line.amount}
                  onChange={(e) => updateExtraLine(i, { amount: e.target.value })}
                />
                <button className="text-red-500" onClick={() => removeExtraLine(i)} aria-label="Hapus baris">
                  ✕
                </button>
              </div>
            ))}
            <button
              type="button"
              className="text-xs text-slate-500 underline"
              onClick={addExtraLine}
              disabled={chargeTypes.length === 0}
            >
              + Tambah kategori
            </button>
          </div>

          {taxSettings?.is_active && (
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={applyTax} onChange={(e) => setApplyTax(e.target.checked)} />
              Kena PPN ({taxSettings.ppn_rate}%)
            </label>
          )}

          <div className="space-y-0.5 border-t border-slate-100 pt-2 text-sm text-slate-500">
            <div className="flex justify-between">
              <span>Subtotal Barang</span>
              <span>Rp{itemTotal.toLocaleString("id-ID")}</span>
            </div>
            {extraTotal > 0 && (
              <div className="flex justify-between">
                <span>Biaya Tambahan</span>
                <span>Rp{extraTotal.toLocaleString("id-ID")}</span>
              </div>
            )}
            {taxAmount > 0 && (
              <div className="flex justify-between">
                <span>PPN</span>
                <span>Rp{taxAmount.toLocaleString("id-ID")}</span>
              </div>
            )}
          </div>

          <div className="flex justify-between font-semibold">
            <span>Total</span>
            <span>Rp{total.toLocaleString("id-ID")}</span>
          </div>

          <div>
            <label className="mb-1 block text-xs text-slate-500">Metode Bayar</label>
            <div className="flex gap-2">
              <button
                className={`flex-1 rounded border px-3 py-2 text-sm ${
                  paymentMethod === "CASH" ? "border-slate-800 bg-slate-800 text-white" : "border-slate-300"
                }`}
                onClick={() => setPaymentMethod("CASH")}
              >
                Tunai
              </button>
              <button
                className={`flex-1 rounded border px-3 py-2 text-sm ${
                  paymentMethod === "QRIS" ? "border-slate-800 bg-slate-800 text-white" : "border-slate-300"
                }`}
                onClick={() => setPaymentMethod("QRIS")}
              >
                QRIS
              </button>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs text-slate-500">
              Pelanggan (opsional)
            </label>
            <select
              className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
            >
              <option value="">Walk-in (tanpa nama)</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          {checkoutError && (
            <div className="rounded bg-red-50 p-2 text-sm text-red-700">{checkoutError}</div>
          )}
          {successMessage && (
            <div className="rounded bg-green-50 p-2 text-sm text-green-700">{successMessage}</div>
          )}

          <button
            className="w-full rounded bg-slate-800 py-3 font-medium text-white disabled:opacity-40"
            disabled={cart.length === 0 || submitting}
            onClick={checkout}
          >
            {submitting ? "Memproses..." : "Checkout"}
          </button>
        </div>
      </div>
    </div>
  );
}
