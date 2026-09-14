"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { formatStockBreakdown } from "@/lib/stock-display";
import { CameraScanner } from "@/components/camera-scanner";
import { LoadingScreen } from "@/components/loading-screen";
import {
  buildReceiptHtml,
  buildWhatsappLink,
  buildWhatsappReceiptText,
  printReceipt,
  type ReceiptData,
} from "@/lib/print-window";

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
  contact: string | null;
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

// Riwayat singkat buat panel "Transaksi Terakhir" + cetak ulang/kirim WA -- goods_issue_lines
// nyimpen qty/harga dalam SATUAN DASAR selalu (create_pos_sale konversi sebelum insert),
// jadi unit_label transaksi asli (kalau dari scan satuan bukan-dasar) gak tersimpan --
// riwayat nampilin qty x harga dalam satuan dasar item, bukan satuan yang dipilih pas jual.
type SaleHistoryLine = { name: string; uom: string; qty: number; unitPrice: number; amount: number };
type SaleHistoryItem = {
  id: string;
  sourceRef: string;
  createdAt: string;
  customerName: string | null;
  customerContact: string | null;
  cashAccountId: string;
  lines: SaleHistoryLine[];
  extraTotal: number;
  taxTotal: number;
};

const ACCOUNT_CODES = {
  KAS_TOKO: "1100",
  KAS_BANK: "1200",
  PENDAPATAN_TOKO: "4100",
  HPP: "5100",
  PERSEDIAAN_BARANG_JADI: "1420",
} as const;

// Baris mentah dari query "items" -- disimpen di cache React Query APA ADANYA (bukan
// CatalogItem/ScannableUnit yang udah diolah), biar checkout() bisa nge-patch
// `inventory_balances.qty_on_hand` langsung di cache abis sukses (tanpa refetch ulang
// seluruh katalog) -- CatalogItem/ScannableUnit diturunkan dari ini lewat useMemo.
type ItemRow = {
  id: string;
  name: string;
  uom: string;
  item_units:
    | { unit_label: string; conversion_factor: number; price: number | null; is_base: boolean; barcode: string | null }[]
    | null;
  inventory_balances: { qty_on_hand: number } | null;
};

async function fetchItemRows(): Promise<ItemRow[]> {
  const { data, error } = await supabase
    .from("items")
    .select(
      "id, name, uom, item_units(unit_label, conversion_factor, price, is_base, barcode), inventory_balances(qty_on_hand)"
    )
    .is("archived_at", null)
    .order("name");
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as ItemRow[];
}

async function fetchAccountIds(): Promise<Record<string, string>> {
  const { data, error } = await supabase
    .from("accounts")
    .select("id, code")
    .in("code", Object.values(ACCOUNT_CODES));
  if (error) throw new Error(error.message);
  const codeToId: Record<string, string> = {};
  for (const acc of data ?? []) codeToId[acc.code as string] = acc.id as string;
  return codeToId;
}

async function fetchCustomers(): Promise<Customer[]> {
  const { data, error } = await supabase
    .from("counterparties")
    .select("id, name, contact, counterparty_type_mapping!inner(role)")
    .eq("counterparty_type_mapping.role", "customer")
    .is("archived_at", null)
    .order("name");
  if (error) throw new Error(error.message);
  return (data ?? []) as Customer[];
}

async function fetchChargeTypes(): Promise<ChargeType[]> {
  const { data, error } = await supabase
    .from("charge_categories")
    .select("id, name, account_id")
    .eq("module", "pos")
    .is("archived_at", null)
    .order("name");
  if (error) throw new Error(error.message);
  return (data ?? []) as ChargeType[];
}

// tax_settings/company_settings digabung jadi app_settings (migration 0028)
async function fetchTaxSettings(): Promise<TaxSettings | null> {
  const { data, error } = await supabase.from("app_settings").select("is_active, ppn_rate").maybeSingle();
  if (error) throw new Error(error.message);
  return (data ?? null) as TaxSettings | null;
}

async function fetchCompanyName(): Promise<string | null> {
  const { data, error } = await supabase.from("app_settings").select("name").maybeSingle();
  if (error) throw new Error(error.message);
  return ((data as { name: string } | null) ?? null)?.name ?? null;
}

// Sejak migration pos-sales-simplify: pos_sales/pos_sale_lines/pos_sale_extra_credit_lines
// (tabel salinan struk) DIHAPUS TOTAL -- gak ada lagi tabel penanda POS sama sekali.
// Item dibaca langsung dari goods_issues->goods_issue_lines (qty_issued+unit_price baru,
// harga jual per baris, ditambahkan RPC create_goods_issue), kategori tambahan+PPN dari
// transaction_lines langsung. transaction_lines berisi SEMUA baris kredit (basket item +
// extra + PPN) tanpa pembeda kolom -- baris basket item dibedakan dari baris extra BUKAN
// lewat amount (bisa kebetulan sama) tapi lewat MEMBERSHIP ke charge_categories (module
// 'pos') -- akun basket item gak pernah ada di katalog itu (LockedAccountField, bukan
// pilihan kasir), pola sama ar-invoices/[id]/view.tsx (chargeLabelByAccountId).
async function fetchRecentSales(date: string, chargeAccountIds: Set<string>): Promise<SaleHistoryItem[]> {
  const { data, error } = await supabase
    .from("transactions")
    .select(
      "id, source_ref, date, counterparties(name, contact), goods_notes!inner(goods_note_lines(qty, unit_price, items(name, uom))), payments!inner(id, journal_entry_id), transaction_lines(account_id, amount, is_tax)"
    )
    .eq("type", "OUTBOUND")
    .eq("date", date)
    .order("id", { ascending: false });
  if (error) throw new Error(error.message);

  type Row = {
    id: string;
    source_ref: string;
    date: string;
    counterparties: { name: string; contact: string | null } | null;
    goods_notes: { goods_note_lines: { qty: number; unit_price: number | null; items: { name: string; uom: string } | null }[] }[];
    payments: { id: string; journal_entry_id: string }[];
    transaction_lines: { account_id: string; amount: number; is_tax: boolean }[];
  };

  const rows = (data ?? []) as unknown as Row[];

  // Cari akun kas per transaksi dari baris debit jurnal pelunasan (record_payment selalu
  // tulis persis 2 baris: debit akun kas, kredit akun kontrol) -- query terpisah (bukan
  // embed 2-level payments->journal_entries->journal_lines lewat PostgREST), pola sama
  // "loadAux" terpisah di apps/erp/pos-sales/page.tsx.
  const journalEntryIds = rows.flatMap((r) => r.payments.map((p) => p.journal_entry_id));
  const cashAccountByEntry = new Map<string, string>();
  if (journalEntryIds.length > 0) {
    const { data: jlData, error: jlError } = await supabase
      .from("journal_lines")
      .select("journal_entry_id, account_id")
      .in("journal_entry_id", journalEntryIds)
      .gt("debit", 0);
    if (jlError) throw new Error(jlError.message);
    for (const l of jlData ?? []) cashAccountByEntry.set(l.journal_entry_id as string, l.account_id as string);
  }

  return rows.map((row) => {
    const goodsIssueLines = row.goods_notes.flatMap((gi) => gi.goods_note_lines);
    const paymentEntryId = row.payments[0]?.journal_entry_id ?? "";
    return {
      id: row.id,
      sourceRef: row.source_ref,
      createdAt: row.date,
      customerName: row.counterparties?.name ?? null,
      customerContact: row.counterparties?.contact ?? null,
      cashAccountId: cashAccountByEntry.get(paymentEntryId) ?? "",
      lines: goodsIssueLines.map((l) => ({
        name: l.items?.name ?? "-",
        uom: l.items?.uom ?? "",
        qty: l.qty,
        unitPrice: l.unit_price ?? 0,
        amount: (l.unit_price ?? 0) * l.qty,
      })),
      extraTotal: row.transaction_lines
        .filter((l) => !l.is_tax && chargeAccountIds.has(l.account_id))
        .reduce((s, l) => s + l.amount, 0),
      taxTotal: row.transaction_lines.filter((l) => l.is_tax).reduce((s, l) => s + l.amount, 0),
    };
  });
}

function mapItemRowsToCatalog(rows: ItemRow[]): CatalogItem[] {
  return rows
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
}

// Semua satuan jual (base ATAU bukan) yang punya barcode + harga -- dipakai lookup
// scan, beda dari CatalogItem yang cuma nampilin satuan dasar di grid.
function mapItemRowsToScannableUnits(rows: ItemRow[]): ScannableUnit[] {
  return rows.flatMap((row) =>
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
}

function CatalogCard({
  item,
  cart,
  onAdd,
  onUpdateQty,
}: {
  item: CatalogItem;
  cart: CartLine[];
  onAdd: (item: CatalogItem, unit: PricedUnit) => void;
  onUpdateQty: (itemId: string, unitLabel: string, qty: number) => void;
}) {
  const [unitLabel, setUnitLabel] = useState(item.units[0].unit_label);
  const unit = item.units.find((u) => u.unit_label === unitLabel) ?? item.units[0];
  const cartQty =
    cart.find((l) => l.item_id === item.id && l.unit_label === unit.unit_label)?.qty_sold ?? 0;
  const available = item.qtyOnHand > 0;

  return (
    <div
      className={`relative rounded-lg border p-4 text-left transition-all duration-150 ${
        available
          ? "border-slate-200 hover:-translate-y-0.5 hover:border-slate-400 hover:shadow-md"
          : "border-slate-100 bg-slate-50"
      }`}
    >
      {!available && (
        <span className="absolute right-2 top-2 rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-medium text-red-600">
          Habis
        </span>
      )}
      <button
        onClick={() => onAdd(item, unit)}
        disabled={!available}
        className="w-full text-left disabled:cursor-not-allowed"
      >
        <div className={`font-medium ${available ? "text-slate-900" : "text-slate-400"}`}>{item.name}</div>
        <div className={`text-sm ${available ? "text-slate-500" : "text-slate-400"}`}>
          Rp{unit.price.toLocaleString("id-ID")}/{unit.unit_label}
        </div>
        <div className={`text-xs ${available ? "text-slate-400" : "text-red-400"}`}>
          {available ? `Stok: ${formatStockBreakdown(item.qtyOnHand, item.uom, item.units)}` : "Stok habis"}
        </div>
      </button>
      {item.units.length > 1 && (
        <div className="relative mt-2">
          <select
            value={unitLabel}
            onChange={(e) => setUnitLabel(e.target.value)}
            disabled={!available}
            className="w-full appearance-none rounded-md border border-slate-300 bg-white py-1.5 pl-2 pr-7 text-xs text-slate-700 transition hover:border-slate-400 focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-800/10 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400"
          >
            {item.units.map((u) => (
              <option key={u.unit_label} value={u.unit_label}>
                {u.unit_label}
              </option>
            ))}
          </select>
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-slate-400">
            ▾
          </span>
        </div>
      )}
      {available && (
        <div className="mt-2 flex items-center gap-1">
          <button
            type="button"
            className="h-6 w-6 rounded border border-slate-300 text-sm disabled:opacity-30"
            onClick={() => onUpdateQty(item.id, unit.unit_label, cartQty - 1)}
            disabled={cartQty === 0}
          >
            −
          </button>
          <span className="w-6 text-center text-xs">{cartQty}</span>
          <button
            type="button"
            className="h-6 w-6 rounded border border-slate-300 text-sm disabled:opacity-30"
            onClick={() => onAdd(item, unit)}
            disabled={cartQty >= item.qtyOnHand}
          >
            +
          </button>
        </div>
      )}
    </div>
  );
}

export default function CheckoutPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [checkingSession, setCheckingSession] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");

  const [cart, setCart] = useState<CartLine[]>([]);
  const [scanInput, setScanInput] = useState("");
  const [scanError, setScanError] = useState<string | null>(null);
  const scanInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [showCameraScanner, setShowCameraScanner] = useState(false);
  const [extraLines, setExtraLines] = useState<ExtraLine[]>([]);
  // null = ikut default tax_settings.is_active; true/false = kasir override manual
  // buat transaksi ini doang (reset ke null lagi abis checkout sukses).
  const [taxOverride, setTaxOverride] = useState<boolean | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<"CASH" | "BANK">("CASH");
  const [cashReceived, setCashReceived] = useState("");
  const [customerId, setCustomerId] = useState<string>("");
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [historyDate, setHistoryDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [lastCompletedRef, setLastCompletedRef] = useState<string | null>(null);
  const [lastReceiptMeta, setLastReceiptMeta] = useState<{ cashReceived: number | null; change: number | null } | null>(
    null
  );

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) {
        router.replace("/login");
        return;
      }
      if (!active) return;
      setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router]);

  // 6 query lepas (bukan 1 kitchen-sink fetch) -- masing-masing punya staleTime
  // sendiri, jadi checkout gak perlu refetch akun/kategori/pajak/nama toko yang
  // hampir gak pernah berubah, cukup nge-patch cache "items" doang (lihat onSuccess
  // checkoutMutation). Semua nunggu sesi login kelar dulu (`enabled`).
  const itemsQuery = useQuery({
    queryKey: ["items"],
    queryFn: fetchItemRows,
    enabled: !checkingSession,
    staleTime: 15_000,
  });
  const accountsQuery = useQuery({
    queryKey: ["accounts"],
    queryFn: fetchAccountIds,
    enabled: !checkingSession,
    staleTime: 10 * 60_000,
  });
  const customersQuery = useQuery({
    queryKey: ["customers"],
    queryFn: fetchCustomers,
    enabled: !checkingSession,
    staleTime: 2 * 60_000,
  });
  const chargeTypesQuery = useQuery({
    queryKey: ["pos_charge_types"],
    queryFn: fetchChargeTypes,
    enabled: !checkingSession,
    staleTime: 10 * 60_000,
  });
  const taxSettingsQuery = useQuery({
    queryKey: ["tax_settings"],
    queryFn: fetchTaxSettings,
    enabled: !checkingSession,
    staleTime: 10 * 60_000,
  });
  const companyNameQuery = useQuery({
    queryKey: ["company_settings"],
    queryFn: fetchCompanyName,
    enabled: !checkingSession,
    staleTime: 10 * 60_000,
  });
  // Key ikut `historyDate` -- ganti tanggal di drawer otomatis refetch, gak perlu
  // panggil manual.
  const chargeAccountIds = new Set((chargeTypesQuery.data ?? []).map((c) => c.account_id));
  const recentSalesQuery = useQuery({
    queryKey: ["pos_sales", historyDate, chargeTypesQuery.data],
    queryFn: () => fetchRecentSales(historyDate, chargeAccountIds),
    enabled: !checkingSession && !!chargeTypesQuery.data,
    staleTime: 10_000,
  });

  const catalog = useMemo(() => mapItemRowsToCatalog(itemsQuery.data ?? []), [itemsQuery.data]);
  const scannableUnits = useMemo(() => mapItemRowsToScannableUnits(itemsQuery.data ?? []), [itemsQuery.data]);
  const accountIds = accountsQuery.data ?? {};
  const customers = customersQuery.data ?? [];
  const chargeTypes = chargeTypesQuery.data ?? [];
  const taxSettings = taxSettingsQuery.data ?? null;
  const companyName = companyNameQuery.data ?? null;
  const recentSales = recentSalesQuery.data ?? [];
  const applyTax = taxOverride ?? (taxSettings?.is_active ?? false);

  const filteredCatalog = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return catalog;
    return catalog.filter((item) => item.name.toLowerCase().includes(query));
  }, [catalog, searchQuery]);

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

  const addToCart = useCallback((item: CatalogItem, unit: PricedUnit) => {
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
  }, []);

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

  const checkoutMutation = useMutation({
    mutationFn: async () => {
      const cashAccountId =
        paymentMethod === "CASH" ? accountIds[ACCOUNT_CODES.KAS_TOKO] : accountIds[ACCOUNT_CODES.KAS_BANK];

      const resolvedExtraLines = extraLines
        .filter((l) => l.category_id && l.amount.trim() !== "")
        .map((l) => {
          const type = chargeTypes.find((c) => c.id === l.category_id);
          return { account_id: type?.account_id ?? "", amount: Number(l.amount) };
        });

      const sourceRef = await generateDocumentNumber("pos_sales");

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
      if (error) throw new Error(error.message);

      const cashReceivedNum = paymentMethod === "CASH" && cashReceived.trim() !== "" ? Number(cashReceived) : null;
      return {
        sourceRef,
        total,
        cartLines: cart,
        cashReceivedNum,
        changeNum: cashReceivedNum != null ? cashReceivedNum - total : null,
      };
    },
    onMutate: () => {
      setCheckoutError(null);
      setSuccessMessage(null);
    },
    onError: (err) => {
      setCheckoutError(err instanceof Error ? err.message : "Gagal memproses transaksi");
    },
    onSuccess: (result) => {
      // Patch stok item yang baru terjual LANGSUNG di cache -- BUKAN refetch seluruh
      // katalog kayak sebelumnya (lihat diskusi performa: refetch abis tiap checkout
      // gak scale kalau katalog gede). Validasi oversell TETAP 100% di server lewat
      // create_pos_sale (RPC udah nolak kalau stok gak cukup sebelum baris ini
      // kejalan) -- cache ini murni angka yang ditampilin ke kasir, bukan sumber
      // kebenaran. memory/architecture/app/tech-stack-decisions.md: POS gak boleh
      // punya cache stok PERMANEN -- staleTime pendek (15s) + refetch-on-focus
      // (default React Query) tetap jaga cache ini gak pernah "permanen".
      queryClient.setQueryData<ItemRow[]>(["items"], (old) =>
        old?.map((row) => {
          const soldBase = result.cartLines
            .filter((l) => l.item_id === row.id)
            .reduce((sum, l) => sum + l.qty_sold * l.conversion_factor, 0);
          if (soldBase === 0 || !row.inventory_balances) return row;
          return {
            ...row,
            inventory_balances: { qty_on_hand: row.inventory_balances.qty_on_hand - soldBase },
          };
        })
      );

      const today = new Date().toISOString().slice(0, 10);
      setHistoryDate(today);
      queryClient.invalidateQueries({ queryKey: ["pos_sales", today] });

      setLastReceiptMeta({ cashReceived: result.cashReceivedNum, change: result.changeNum });
      setLastCompletedRef(result.sourceRef);
      setSuccessMessage(`Transaksi berhasil (${result.sourceRef}) — total Rp${result.total.toLocaleString("id-ID")}`);
      setCart([]);
      setCustomerId("");
      setExtraLines([]);
      setCashReceived("");
      setTaxOverride(null);
      setScanError(null);
      setShowPaymentModal(false);
      scanInputRef.current?.focus();
    },
  });

  // Flow (2026-08-16): kasir GAK milih metode bayar dari awal -- pencet "Checkout"
  // dulu (keranjang harus udah ada isi), baru disuguhkan modal buat pilih pelanggan
  // + metode bayar (Tunai/Bank) + uang diterima (kalau Tunai). Konfirmasi transaksi
  // beneran (RPC create_pos_sale) baru kejadian dari tombol di DALAM modal.
  const openPaymentModal = useCallback(() => {
    if (cart.length === 0) return;
    setShowPaymentModal(true);
  }, [cart]);

  const confirmCheckout = useCallback(() => {
    if (cart.length === 0 || checkoutMutation.isPending) return;
    checkoutMutation.mutate();
  }, [cart, checkoutMutation]);

  function receiptFromSale(
    sale: SaleHistoryItem,
    meta?: { cashReceived: number | null; change: number | null }
  ): ReceiptData {
    const subtotal = sale.lines.reduce((s, l) => s + l.amount, 0);
    return {
      companyName,
      sourceRef: sale.sourceRef,
      dateTime: new Date(sale.createdAt).toLocaleString("id-ID"),
      customerName: sale.customerName,
      lines: sale.lines.map((l) => ({ name: l.name, uom: l.uom, qty: l.qty, unitPrice: l.unitPrice, amount: l.amount })),
      extraLines: sale.extraTotal > 0 ? [{ label: "Biaya Tambahan", amount: sale.extraTotal }] : [],
      taxAmount: sale.taxTotal,
      taxRate: taxSettings?.ppn_rate ?? null,
      subtotal,
      total: subtotal + sale.extraTotal + sale.taxTotal,
      paymentLabel: sale.cashAccountId === accountIds[ACCOUNT_CODES.KAS_TOKO] ? "Tunai" : "Bank",
      cashReceived: meta?.cashReceived ?? null,
      change: meta?.change ?? null,
    };
  }

  function handlePrintSale(sale: SaleHistoryItem, meta?: { cashReceived: number | null; change: number | null }) {
    const html = buildReceiptHtml(receiptFromSale(sale, meta));
    const ok = printReceipt(sale.sourceRef, html);
    if (!ok) setCheckoutError("Popup diblokir browser — izinkan popup buat halaman ini, lalu coba lagi.");
  }

  function handleWhatsappSale(sale: SaleHistoryItem, meta?: { cashReceived: number | null; change: number | null }) {
    const text = buildWhatsappReceiptText(receiptFromSale(sale, meta));
    window.open(buildWhatsappLink(sale.customerContact, text), "_blank");
  }

  function handleCameraDetect(code: string) {
    setShowCameraScanner(false);
    const unit = scannableUnits.find((u) => u.barcode === code);
    if (!unit) {
      setScanError("Kode gak ketemu — cari manual dari katalog di bawah");
      return;
    }
    addScannedUnit(unit);
  }

  // Keyboard shortcut -- keputusan (2026-08-16): angka 1-9 ikut POSISI grid saat ini
  // (filteredCatalog, bisa geser kalau search/kategori aktif) BUKAN badge statis per item,
  // biar gak butuh mekanisme pin terpisah; kasir yang pakai search dulu baru shortcut angka
  // tetap konsisten sama apa yang keliatan di layar. Shortcut digit/Enter/Esc/Backspace/+/-
  // sengaja gak aktif kalau fokus lagi di elemen input/textarea/select -- scanInputRef
  // autofocus abis checkout (perilaku existing), jadi scanner fisik yang ngetik angka+Enter
  // ke situ TETAP jalan normal tanpa kebajak shortcut ini.
  useEffect(() => {
    function isEditableTarget(el: EventTarget | null): boolean {
      if (!(el instanceof HTMLElement)) return false;
      return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
    }

    function onKeyDown(e: KeyboardEvent) {
      if (showCameraScanner || showHistory || showPaymentModal) return;

      if (e.key === "F2") {
        e.preventDefault();
        setPaymentMethod((m) => (m === "CASH" ? "BANK" : "CASH"));
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (isEditableTarget(e.target)) return;

      if (e.key === "/") {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (e.key >= "1" && e.key <= "9") {
        const item = filteredCatalog[Number(e.key) - 1];
        if (item && item.qtyOnHand > 0) addToCart(item, item.units[0]);
        return;
      }
      if (e.key === "Enter") {
        openPaymentModal();
        return;
      }
      if (e.key === "Escape") {
        setCart([]);
        return;
      }
      if (e.key === "Backspace") {
        setCart((prev) => prev.slice(0, -1));
        return;
      }
      if (e.key === "+") {
        setCart((prev) => {
          if (prev.length === 0) return prev;
          const last = prev[prev.length - 1];
          if (last.qty_sold >= last.available) return prev;
          return prev.map((l, i) => (i === prev.length - 1 ? { ...l, qty_sold: l.qty_sold + 1 } : l));
        });
        return;
      }
      if (e.key === "-") {
        setCart((prev) => {
          if (prev.length === 0) return prev;
          const last = prev[prev.length - 1];
          if (last.qty_sold <= 1) return prev.slice(0, -1);
          return prev.map((l, i) => (i === prev.length - 1 ? { ...l, qty_sold: l.qty_sold - 1 } : l));
        });
        return;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [filteredCatalog, showCameraScanner, showHistory, showPaymentModal, openPaymentModal, addToCart]);

  // Bug ketemu (kode barcode contoh "SKU-2026-00015"): klik apa pun di halaman (kartu
  // katalog, tombol qty +/-, dst) mindahin fokus browser ke elemen yang diklik itu.
  // Kalau abis itu kasir scan barcode fisik TANPA klik balik ke scanInputRef dulu,
  // keystroke scanner-nya (digit-nya kena shortcut "1"-"9" nambah barang, "-" kena
  // shortcut kurangin qty, dan Enter di ujungnya kena shortcut checkout di onKeyDown
  // atas) leak ke listener keydown global, bukan masuk ke input scan-nya sebagai teks
  // biasa -- ujung-ujungnya modal pembayaran kebuka sendiri padahal kasir belum niat
  // checkout. Fix: abis klik di mana pun, balikin fokus ke scanInputRef -- KECUALI
  // yang diklik emang input teks lain yang butuh diketik manual (search/qty/dst) atau
  // ada modal/overlay lain lagi kebuka.
  useEffect(() => {
    function refocusScanInput() {
      if (showCameraScanner || showHistory || showPaymentModal) return;
      const active = document.activeElement;
      const isTextInput =
        active instanceof HTMLElement &&
        (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT");
      if (!isTextInput) scanInputRef.current?.focus();
    }
    function onClick() {
      setTimeout(refocusScanInput, 0);
    }
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [showCameraScanner, showHistory, showPaymentModal]);

  const lastCompletedSale = recentSales.find((s) => s.sourceRef === lastCompletedRef) ?? null;

  if (checkingSession || itemsQuery.isLoading || accountsQuery.isLoading) {
    return <LoadingScreen />;
  }

  if (itemsQuery.error || accountsQuery.error) {
    const message = (itemsQuery.error ?? accountsQuery.error) as Error;
    return <div className="p-8 text-red-600">Gagal memuat katalog: {message.message}</div>;
  }

  return (
    <div className="flex h-dvh flex-col lg:flex-row">
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-xl font-semibold">Kasir</h1>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowHistory(true)}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:border-slate-400"
            >
              🕘 Riwayat Transaksi
            </button>
            <button
              type="button"
              onClick={() => setShowCameraScanner(true)}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:border-slate-400"
              title="Scan pakai kamera"
            >
              📷 Kamera
            </button>
          </div>
        </div>
        <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <form onSubmit={handleScanSubmit}>
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
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Cari nama barang... (Ctrl+F)"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-4 py-2.5 text-sm focus:border-slate-500 focus:outline-none"
          />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {filteredCatalog.map((item) => (
            <CatalogCard key={item.id} item={item} cart={cart} onAdd={addToCart} onUpdateQty={updateQty} />
          ))}
          {filteredCatalog.length === 0 && (
            <div className="col-span-full text-slate-400">
              {catalog.length === 0
                ? "Belum ada barang dengan harga jual (`item_units`) yang bisa dijual."
                : "Gak ada barang yang cocok."}
            </div>
          )}
        </div>
      </div>

      <div
        className={`fixed inset-0 z-40 transition-opacity duration-200 ${
          showHistory ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
        }`}
        aria-hidden={!showHistory}
      >
        <div className="absolute inset-0 bg-black/40" onClick={() => setShowHistory(false)} />
        <div
          className={`absolute inset-y-0 left-0 flex w-80 max-w-full flex-col bg-white shadow-xl transition-transform duration-200 ${
            showHistory ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <div className="border-b border-slate-200 p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-semibold">Transaksi Terakhir</h2>
              <button
                type="button"
                onClick={() => setShowHistory(false)}
                className="text-slate-500"
                aria-label="Tutup"
              >
                ✕
              </button>
            </div>
            <input
              type="date"
              value={historyDate}
              onChange={(e) => setHistoryDate(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
            />
          </div>
          <div className="flex-1 space-y-2 overflow-y-auto p-4">
            {recentSales.length === 0 && (
              <div className="text-sm text-slate-400">Belum ada transaksi di tanggal ini.</div>
            )}
            {recentSales.map((sale) => {
              const saleTotal = sale.lines.reduce((s, l) => s + l.amount, 0) + sale.extraTotal + sale.taxTotal;
              return (
                <div key={sale.id} className="rounded border border-slate-100 px-3 py-2 text-sm">
                  <div className="font-medium">{sale.sourceRef}</div>
                  <div className="truncate text-xs text-slate-400">
                    {new Date(sale.createdAt).toLocaleString("id-ID")}
                    {sale.customerName ? ` · ${sale.customerName}` : ""}
                  </div>
                  <div className="mt-1 flex items-center justify-between">
                    <span className="text-slate-600">Rp{saleTotal.toLocaleString("id-ID")}</span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="text-xs text-slate-500 underline"
                        onClick={() => handlePrintSale(sale)}
                      >
                        Cetak
                      </button>
                      <button
                        type="button"
                        className="text-xs text-slate-500 underline"
                        onClick={() => handleWhatsappSale(sale)}
                      >
                        WA
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="flex max-h-[55dvh] w-full min-h-0 flex-col border-t border-slate-200 p-4 sm:p-6 lg:h-full lg:max-h-none lg:w-xl lg:border-l lg:border-t-0">
        <h2 className="mb-3 shrink-0 font-semibold">Keranjang</h2>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
          {cart.length === 0 && <div className="text-sm text-slate-400">Belum ada item.</div>}
          {cart.map((line) => (
            <div
              key={`${line.item_id}-${line.unit_label}`}
              className="flex items-center justify-between gap-3 rounded-md border border-slate-100 px-2 py-2.5 text-sm"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">
                  {line.name}
                  {line.conversion_factor !== 1 && (
                    <span className="ml-1 text-xs text-slate-400">({line.unit_label})</span>
                  )}
                </div>
                <div className="text-xs text-slate-400">
                  Rp{line.unit_price.toLocaleString("id-ID")} × {line.qty_sold} = Rp
                  {(line.unit_price * line.qty_sold).toLocaleString("id-ID")}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  className="h-7 w-7 rounded border border-slate-300"
                  onClick={() => updateQty(line.item_id, line.unit_label, line.qty_sold - 1)}
                >
                  −
                </button>
                <input
                  type="number"
                  min={1}
                  max={line.available}
                  value={line.qty_sold}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isNaN(v)) return;
                    updateQty(line.item_id, line.unit_label, Math.max(0, Math.min(v, line.available)));
                  }}
                  className="w-12 rounded border border-slate-300 py-1 text-center text-sm"
                />
                <button
                  className="h-7 w-7 rounded border border-slate-300"
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

          <div className="space-y-3 border-t border-slate-200 pt-3">
            <button
              type="button"
              onClick={() => setDetailsExpanded((v) => !v)}
              className="flex w-full items-center justify-between text-xs font-medium text-slate-500"
            >
              <span>Detail Transaksi (Biaya Tambahan, PPN)</span>
              <span>{detailsExpanded ? "▲" : "▼"}</span>
            </button>

            {detailsExpanded && (
              <div className="space-y-3">
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
                    <input type="checkbox" checked={applyTax} onChange={(e) => setTaxOverride(e.target.checked)} />
                    Kena PPN ({taxSettings.ppn_rate}%)
                  </label>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="mt-3 shrink-0 space-y-2 border-t border-slate-200 bg-white pt-3">
          <div className="space-y-0.5 text-sm text-slate-500">
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

          {successMessage && (
            <div className="rounded bg-green-50 p-2 text-sm text-green-700">
              <div>{successMessage}</div>
              {lastCompletedSale && (
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    className="rounded border border-green-300 px-2 py-1 text-xs"
                    onClick={() => handlePrintSale(lastCompletedSale, lastReceiptMeta ?? undefined)}
                  >
                    Cetak Struk
                  </button>
                  <button
                    type="button"
                    className="rounded border border-green-300 px-2 py-1 text-xs"
                    onClick={() => handleWhatsappSale(lastCompletedSale, lastReceiptMeta ?? undefined)}
                  >
                    Kirim WA
                  </button>
                </div>
              )}
            </div>
          )}
          {checkoutError && !showPaymentModal && (
            <div className="rounded bg-red-50 p-2 text-sm text-red-700">{checkoutError}</div>
          )}

          <button
            className="w-full rounded bg-slate-800 py-3 font-medium text-white disabled:opacity-40"
            disabled={cart.length === 0}
            onClick={openPaymentModal}
          >
            Bayar
          </button>
        </div>
      </div>
      {showCameraScanner && (
        <CameraScanner onDetect={handleCameraDetect} onClose={() => setShowCameraScanner(false)} />
      )}
      {showPaymentModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => {
            setShowPaymentModal(false);
            setCheckoutError(null);
          }}
        >
          <div className="w-full max-w-sm rounded-lg bg-white p-5" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-semibold">Selesaikan Transaksi</h3>
              <button
                type="button"
                onClick={() => {
                  setShowPaymentModal(false);
                  setCheckoutError(null);
                }}
                className="text-slate-500"
                aria-label="Tutup"
              >
                ✕
              </button>
            </div>
            <div className="mb-4 flex justify-between text-sm font-semibold">
              <span>Total</span>
              <span>Rp{total.toLocaleString("id-ID")}</span>
            </div>
            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-xs text-slate-500">Pelanggan (opsional)</label>
                <select
                  className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
                  value={customerId}
                  onChange={(e) => setCustomerId(e.target.value)}
                >
                  <option value="">Pelanggan Umum (tanpa nama)</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-500">Metode Bayar (F2)</label>
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
                      paymentMethod === "BANK" ? "border-slate-800 bg-slate-800 text-white" : "border-slate-300"
                    }`}
                    onClick={() => setPaymentMethod("BANK")}
                  >
                    Bank
                  </button>
                </div>
              </div>
              {paymentMethod === "CASH" && (
                <div>
                  <label className="mb-1 block text-xs text-slate-500">Uang Diterima</label>
                  <input
                    type="number"
                    min="0"
                    placeholder="0"
                    autoFocus
                    className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
                    value={cashReceived}
                    onChange={(e) => setCashReceived(e.target.value)}
                  />
                  {cashReceived.trim() !== "" && (
                    <div
                      className={`mt-1 text-xs ${Number(cashReceived) < total ? "text-red-600" : "text-slate-500"}`}
                    >
                      {Number(cashReceived) < total
                        ? `Kurang Rp${(total - Number(cashReceived)).toLocaleString("id-ID")}`
                        : `Kembalian: Rp${(Number(cashReceived) - total).toLocaleString("id-ID")}`}
                    </div>
                  )}
                </div>
              )}
            </div>

            {checkoutError && (
              <div className="mt-4 rounded bg-red-50 p-2 text-sm text-red-700">{checkoutError}</div>
            )}

            <button
              type="button"
              onClick={confirmCheckout}
              disabled={
                checkoutMutation.isPending ||
                (paymentMethod === "CASH" && (cashReceived.trim() === "" || Number(cashReceived) < total))
              }
              className="mt-5 w-full rounded bg-slate-800 py-2.5 text-sm font-medium text-white disabled:opacity-40"
            >
              {checkoutMutation.isPending ? "Memproses..." : "Bayar"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
