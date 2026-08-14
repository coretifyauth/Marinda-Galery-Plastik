"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { generateDocumentNumber } from "@/lib/document-numbers";

type PricedUnit = {
  unit_label: string;
  conversion_factor: number;
  price: number;
};

type CatalogItem = {
  id: string;
  name: string;
  uom: string;
  units: PricedUnit[];
  qtyOnHand: number;
};

// 1 baris per satuan jual (item_units) yang punya barcode -- dipakai buat lookup
// scan, BUKAN cuma satuan dasar seperti CatalogItem. Ref: docs/domain/inventory.md
// submodule "Kode Scan Barang (Barcode/QR per Satuan Jual)".
type ScannableUnit = {
  itemId: string;
  itemName: string;
  unitLabel: string;
  conversionFactor: number;
  price: number;
  qtyOnHand: number;
  barcode: string;
};

type Customer = {
  id: string;
  name: string;
};

// unit_price & qty_sold di sini SELALU dalam satuan jual baris ini (bisa base
// unit ATAU satuan lain kayak lusin/pack kalau ditambah lewat scan) -- konversi
// ke satuan dasar (dipakai RPC create_pos_sale) baru terjadi pas checkout().
type CartLine = {
  item_id: string;
  name: string;
  unit_label: string;
  conversion_factor: number;
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

function CatalogCard({ item, onAdd }: { item: CatalogItem; onAdd: (item: CatalogItem, unit: PricedUnit) => void }) {
  const [unitLabel, setUnitLabel] = useState(item.units[0].unit_label);
  const unit = item.units.find((u) => u.unit_label === unitLabel) ?? item.units[0];

  return (
    <div className="rounded-lg border border-slate-200 p-4 text-left">
      <button
        onClick={() => onAdd(item, unit)}
        disabled={item.qtyOnHand <= 0}
        className="w-full text-left disabled:cursor-not-allowed disabled:opacity-40"
      >
        <div className="font-medium">{item.name}</div>
        <div className="text-sm text-slate-500">
          Rp{unit.price.toLocaleString("id-ID")}/{unit.unit_label}
        </div>
        <div className="text-xs text-slate-400">Stok: {item.qtyOnHand}</div>
      </button>
      {item.units.length > 1 && (
        <select
          value={unitLabel}
          onChange={(e) => setUnitLabel(e.target.value)}
          className="mt-2 w-full rounded border border-slate-200 text-xs"
        >
          {item.units.map((u) => (
            <option key={u.unit_label} value={u.unit_label}>
              {u.unit_label}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

export default function CheckoutPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [scannableUnits, setScannableUnits] = useState<ScannableUnit[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [accountIds, setAccountIds] = useState<Record<string, string>>({});
  const [chargeTypes, setChargeTypes] = useState<ChargeType[]>([]);
  const [taxSettings, setTaxSettings] = useState<TaxSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [cart, setCart] = useState<CartLine[]>([]);
  const [scanInput, setScanInput] = useState("");
  const [scanError, setScanError] = useState<string | null>(null);
  const scanInputRef = useRef<HTMLInputElement>(null);
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
          "id, name, uom, item_units(unit_label, conversion_factor, price, is_base, barcode), inventory_balances(qty_on_hand)"
        )
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
      item_units:
        | { unit_label: string; conversion_factor: number; price: number | null; is_base: boolean; barcode: string | null }[]
        | null;
      inventory_balances: { qty_on_hand: number } | null;
    };

    const rows = (itemsRes.data ?? []) as unknown as ItemRow[];
    const mapped: CatalogItem[] = rows
      .map((row) => {
        const priced = (row.item_units ?? [])
          .filter((u): u is typeof u & { price: number } => u.price != null && u.price > 0)
          .sort((a, b) => Number(b.is_base) - Number(a.is_base))
          .map((u) => ({ unit_label: u.unit_label, conversion_factor: u.conversion_factor, price: u.price }));
        return {
          id: row.id,
          name: row.name,
          uom: row.uom,
          units: priced,
          qtyOnHand: row.inventory_balances?.qty_on_hand ?? 0,
        };
      })
      .filter((item) => item.units.length > 0);
    setCatalog(mapped);

    // Semua satuan jual (base ATAU bukan) yang punya barcode + harga -- dipakai
    // lookup scan, beda dari `catalog` yang cuma nampilin satuan dasar di grid.
    const units: ScannableUnit[] = rows.flatMap((row) =>
      (row.item_units ?? [])
        .filter((u) => u.barcode && u.price != null)
        .map((u) => ({
          itemId: row.id,
          itemName: row.name,
          unitLabel: u.unit_label,
          conversionFactor: u.conversion_factor,
          price: u.price as number,
          qtyOnHand: row.inventory_balances?.qty_on_hand ?? 0,
          barcode: u.barcode as string,
        }))
    );
    setScannableUnits(units);

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

  function addToCart(item: CatalogItem, unit: PricedUnit) {
    setCheckoutError(null);
    setSuccessMessage(null);
    setCart((prev) => {
      const existing = prev.find((l) => l.item_id === item.id && l.unit_label === unit.unit_label);
      if (existing) {
        return prev.map((l) =>
          l === existing ? { ...l, qty_sold: l.qty_sold + 1 } : l
        );
      }
      return [
        ...prev,
        {
          item_id: item.id,
          name: item.name,
          unit_label: unit.unit_label,
          conversion_factor: unit.conversion_factor,
          unit_price: unit.price,
          qty_sold: 1,
          available: item.qtyOnHand,
        },
      ];
    });
  }

  // Tambah ke keranjang lewat kode scan/ketik manual -- BEDA dari addToCart (klik
  // katalog, selalu satuan dasar). Satuan bisa apa aja (base atau bukan), harga &
  // qty_sold tetap dalam satuan itu -- konversi ke satuan dasar baru terjadi pas
  // checkout() manggil create_pos_sale. Ref: docs/domain/inventory.md submodule
  // "Kode Scan Barang (Barcode/QR per Satuan Jual)".
  function addScannedUnit(unit: ScannableUnit) {
    setCheckoutError(null);
    setSuccessMessage(null);
    const available = Math.floor(unit.qtyOnHand / unit.conversionFactor);
    if (available <= 0) {
      setScanError(`Stok ${unit.itemName} (${unit.unitLabel}) habis`);
      return;
    }
    setScanError(null);
    setCart((prev) => {
      const existing = prev.find((l) => l.item_id === unit.itemId && l.unit_label === unit.unitLabel);
      if (existing) {
        if (existing.qty_sold >= available) return prev;
        return prev.map((l) => (l === existing ? { ...l, qty_sold: l.qty_sold + 1 } : l));
      }
      return [
        ...prev,
        {
          item_id: unit.itemId,
          name: unit.itemName,
          unit_label: unit.unitLabel,
          conversion_factor: unit.conversionFactor,
          unit_price: unit.price,
          qty_sold: 1,
          available,
        },
      ];
    });
  }

  function handleScanSubmit(e: FormEvent) {
    e.preventDefault();
    const code = scanInput.trim();
    setScanInput("");
    if (!code) return;
    const unit = scannableUnits.find((u) => u.barcode === code);
    if (!unit) {
      setScanError("Kode gak ketemu — cari manual dari katalog di bawah");
      return;
    }
    addScannedUnit(unit);
  }

  function updateQty(itemId: string, unitLabel: string, qty: number) {
    if (qty <= 0) {
      setCart((prev) => prev.filter((l) => !(l.item_id === itemId && l.unit_label === unitLabel)));
      return;
    }
    setCart((prev) =>
      prev.map((l) => (l.item_id === itemId && l.unit_label === unitLabel ? { ...l, qty_sold: qty } : l))
    );
  }

  function removeLine(itemId: string, unitLabel: string) {
    setCart((prev) => prev.filter((l) => !(l.item_id === itemId && l.unit_label === unitLabel)));
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

    let sourceRef: string;
    try {
      sourceRef = await generateDocumentNumber("pos_sales");
    } catch (err) {
      setSubmitting(false);
      setCheckoutError(err instanceof Error ? err.message : "Gagal generate nomor dokumen");
      return;
    }

    const { error } = await supabase.rpc("create_pos_sale", {
      p_sale_date: new Date().toISOString().slice(0, 10),
      p_source_ref: sourceRef,
      p_customer_id: customerId || null,
      p_cash_account_id: cashAccountId,
      p_revenue_account_id: accountIds[ACCOUNT_CODES.PENDAPATAN_TOKO],
      p_hpp_account_id: accountIds[ACCOUNT_CODES.HPP],
      p_finished_good_account_id: accountIds[ACCOUNT_CODES.PERSEDIAAN_BARANG_JADI],
      p_extra_credit_lines: resolvedExtraLines,
      p_apply_tax: applyTax && !!taxSettings?.is_active,
      // create_pos_sale SELALU nerima qty di satuan dasar (0 perubahan RPC, pola
      // sama item_units di modul lain) -- baris keranjang yang qty_sold/unit_price-
      // nya dalam satuan bukan-dasar (dari scan) dikonversi di sini, tepat sebelum
      // manggil RPC. unit_price base = harga satuan jual dibagi faktor konversi,
      // biar qty_base x unit_price_base tetap = total harga satuan jual asli.
      p_lines: cart.map((l) => ({
        item_id: l.item_id,
        qty_sold: l.qty_sold * l.conversion_factor,
        unit_price: l.unit_price / l.conversion_factor,
      })),
    });

    setSubmitting(false);

    if (error) {
      setCheckoutError(error.message);
      return;
    }

    setSuccessMessage(`Transaksi berhasil (${sourceRef}) — total Rp${total.toLocaleString("id-ID")}`);
    setCart([]);
    setCustomerId("");
    setExtraLines([]);
    setApplyTax(false);
    setScanError(null);
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
        <h1 className="mb-4 text-xl font-semibold">Kasir</h1>
        <form onSubmit={handleScanSubmit} className="mb-4">
          <input
            ref={scanInputRef}
            type="text"
            autoFocus
            placeholder="Scan / ketik kode..."
            value={scanInput}
            onChange={(e) => setScanInput(e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-4 py-2.5 text-sm focus:border-slate-500 focus:outline-none"
          />
          {scanError && <p className="mt-1 text-xs text-amber-600">{scanError}</p>}
        </form>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {catalog.map((item) => (
            <CatalogCard key={item.id} item={item} onAdd={addToCart} />
          ))}
          {catalog.length === 0 && (
            <div className="col-span-full text-slate-400">
              Belum ada barang dengan harga jual (`item_units`) yang bisa dijual.
            </div>
          )}
        </div>
      </div>

      <div className="flex w-96 flex-col border-l border-slate-200 p-6">
        <h2 className="mb-3 font-semibold">Keranjang</h2>
        <div className="flex-1 space-y-2 overflow-y-auto">
          {cart.length === 0 && <div className="text-sm text-slate-400">Belum ada item.</div>}
          {cart.map((line) => (
            <div key={`${line.item_id}-${line.unit_label}`} className="flex items-center justify-between gap-2 text-sm">
              <div className="flex-1">
                <div>
                  {line.name}
                  {line.conversion_factor !== 1 && (
                    <span className="ml-1 text-xs text-slate-400">({line.unit_label})</span>
                  )}
                </div>
                <div className="text-slate-400">
                  Rp{line.unit_price.toLocaleString("id-ID")} × {line.qty_sold} = Rp
                  {(line.unit_price * line.qty_sold).toLocaleString("id-ID")}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  className="h-6 w-6 rounded border border-slate-300"
                  onClick={() => updateQty(line.item_id, line.unit_label, line.qty_sold - 1)}
                >
                  −
                </button>
                <span className="w-6 text-center">{line.qty_sold}</span>
                <button
                  className="h-6 w-6 rounded border border-slate-300"
                  onClick={() => updateQty(line.item_id, line.unit_label, line.qty_sold + 1)}
                  disabled={line.qty_sold >= line.available}
                >
                  +
                </button>
                <button
                  className="ml-1 text-red-500"
                  onClick={() => removeLine(line.item_id, line.unit_label)}
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
