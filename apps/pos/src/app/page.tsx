"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { formatStockBreakdown } from "@/lib/stock-display";
import { LoadingScreen } from "@/components/loading-screen";
import { buildReceiptHtml, printReceipt, type ReceiptData } from "@/lib/print-window";
import { listSerialPorts, printEscPos } from "@/lib/thermal-printer";
import { getPrinterPort, isTauri, setPrinterPort } from "@/lib/printer-settings";
import type { CartLine, ChargeType, Customer, ItemRow, SaleHistoryItem, TaxSettings } from "@/lib/pos-types";
import { getKeyValue, localDb, setKeyValue, type OutboxReceiptSnapshot, type OutboxSalePayload } from "@/lib/local-db";
import { nextOfflineSourceRef } from "@/lib/device-id";
import { isLikelyNetworkError, probeSupabase, useOnlineStatus } from "@/lib/online-status";
import { syncOutbox } from "@/lib/offline-sync";
import { useLiveQuery } from "dexie-react-hooks";
import { fetchActiveItemDiscountRules, resolveItemDiscount } from "@/lib/item-discount-rules";
import { fetchActiveBundlePromoRules, resolveBundlePromoDiscounts } from "@/lib/bundle-promo-rules";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CloudUpload,
  History,
  Minus,
  Plus,
  Printer,
  Receipt,
  RefreshCw,
  ScanLine,
  Search,
  Trash2,
  X,
} from "lucide-react";

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

// unit_price & qty_sold di sini SELALU dalam satuan jual baris ini (bisa base
// unit ATAU satuan lain kayak lusin/pack kalau ditambah lewat scan) -- konversi
// ke satuan dasar (dipakai RPC create_pos_sale) baru terjadi pas checkout().

type ExtraLine = { category_id: string; amount: string };

type CheckoutResult = {
  mode: "online" | "offline";
  sourceRef: string;
  total: number;
  cartLines: CartLine[];
  cashReceivedNum: number | null;
  changeNum: number | null;
  receiptSnapshot: OutboxReceiptSnapshot;
};

const ACCOUNT_CODES = {
  KAS_TOKO: "1100",
  KAS_BANK: "1200",
  PENDAPATAN_TOKO: "4100",
  HPP: "5100",
  PERSEDIAAN_BARANG_JADI: "1420",
} as const;

// Tiap fetcher: coba Supabase seperti biasa -> sukses -> tulis-tembus ke Dexie
// (cache buat dibaca offline nanti) -> gagal (offline) -> baca balik dari Dexie;
// cache kosong (belum pernah online sekalipun) -> lempar error apa adanya, gak
// ada yang bisa ditampilkan. Lihat plan: offline sync POS (IndexedDB + outbox).
async function fetchItemRows(): Promise<ItemRow[]> {
  try {
    const { data, error } = await supabase
      .from("items")
      .select(
        "id, name, uom, category_id, item_units(unit_label, conversion_factor, price, is_base, barcode), inventory_balances(qty_on_hand)"
      )
      .is("archived_at", null)
      .order("name");
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as unknown as ItemRow[];
    await localDb.transaction("rw", localDb.items, async () => {
      await localDb.items.clear();
      await localDb.items.bulkPut(rows);
    });
    return rows;
  } catch (err) {
    const cached = await localDb.items.toArray();
    if (cached.length > 0) return cached;
    throw err;
  }
}

async function fetchAccountIds(): Promise<Record<string, string>> {
  try {
    const { data, error } = await supabase
      .from("accounts")
      .select("id, code")
      .in("code", Object.values(ACCOUNT_CODES));
    if (error) throw new Error(error.message);
    const codeToId: Record<string, string> = {};
    for (const acc of data ?? []) codeToId[acc.code as string] = acc.id as string;
    await setKeyValue("accounts", codeToId);
    return codeToId;
  } catch (err) {
    const cached = await getKeyValue<Record<string, string>>("accounts");
    if (cached) return cached;
    throw err;
  }
}

async function fetchCustomers(): Promise<Customer[]> {
  try {
    const { data, error } = await supabase
      .from("counterparties")
      .select("id, name, contact, counterparty_type_mapping!inner(role)")
      .eq("counterparty_type_mapping.role", "customer")
      .is("archived_at", null)
      .order("name");
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Customer[];
    await localDb.transaction("rw", localDb.customers, async () => {
      await localDb.customers.clear();
      await localDb.customers.bulkPut(rows);
    });
    return rows;
  } catch (err) {
    const cached = await localDb.customers.toArray();
    if (cached.length > 0) return cached;
    throw err;
  }
}

async function fetchChargeTypes(): Promise<ChargeType[]> {
  try {
    const { data, error } = await supabase
      .from("charge_categories")
      .select("id, name, account_id")
      .eq("module", "pos")
      .is("archived_at", null)
      .order("name");
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as ChargeType[];
    await localDb.transaction("rw", localDb.chargeTypes, async () => {
      await localDb.chargeTypes.clear();
      await localDb.chargeTypes.bulkPut(rows);
    });
    return rows;
  } catch (err) {
    const cached = await localDb.chargeTypes.toArray();
    if (cached.length > 0) return cached;
    throw err;
  }
}

// tax_settings/company_settings digabung jadi app_settings (migration 0028)
async function fetchTaxSettings(): Promise<TaxSettings | null> {
  try {
    const { data, error } = await supabase.from("app_settings").select("is_active, ppn_rate").maybeSingle();
    if (error) throw new Error(error.message);
    const row = (data ?? null) as TaxSettings | null;
    await setKeyValue("tax_settings", row);
    return row;
  } catch (err) {
    const cached = await getKeyValue<TaxSettings | null>("tax_settings");
    if (cached !== undefined) return cached;
    throw err;
  }
}

async function fetchCompanyName(): Promise<string | null> {
  try {
    const { data, error } = await supabase.from("app_settings").select("name").maybeSingle();
    if (error) throw new Error(error.message);
    const name = ((data as { name: string } | null) ?? null)?.name ?? null;
    await setKeyValue("company_settings", name);
    return name;
  } catch (err) {
    const cached = await getKeyValue<string | null>("company_settings");
    if (cached !== undefined) return cached;
    throw err;
  }
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
      "id, source_ref, date, created_at, counterparties(name, contact), goods_notes!inner(goods_note_lines(qty, unit_price, discount_amount, items(name, uom))), payments!inner(id, journal_entry_id), transaction_lines(account_id, amount, is_tax)"
    )
    .eq("type", "OUTBOUND")
    .eq("date", date)
    .order("id", { ascending: false });
  if (error) throw new Error(error.message);

  type Row = {
    id: string;
    source_ref: string;
    date: string;
    created_at: string;
    counterparties: { name: string; contact: string | null } | null;
    goods_notes: {
      goods_note_lines: {
        qty: number;
        unit_price: number | null;
        discount_amount: number;
        items: { name: string; uom: string } | null;
      }[];
    }[];
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
      createdAt: row.created_at,
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
      discountTotal: goodsIssueLines.reduce((s, l) => s + (l.discount_amount ?? 0), 0),
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
          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-slate-400" />
        </div>
      )}
      {available && (
        <div className="mt-2 flex items-center gap-1">
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center rounded border border-slate-300 disabled:opacity-30"
            onClick={() => onUpdateQty(item.id, unit.unit_label, cartQty - 1)}
            disabled={cartQty === 0}
          >
            <Minus className="h-3 w-3" />
          </button>
          <span className="w-6 text-center text-xs">{cartQty}</span>
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center rounded border border-slate-300 disabled:opacity-30"
            onClick={() => onAdd(item, unit)}
            disabled={cartQty >= item.qtyOnHand}
          >
            <Plus className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
}

// Preview struk WYSIWYG -- niru tampilan hasil print (lebar sempit, monospace),
// dipakai baik buat modal "Transaksi Berhasil" (auto muncul abis checkout) maupun
// "Tinjau Struk" (manual, dari riwayat transaksi).
function ReceiptPreview({ data }: { data: ReceiptData }) {
  const rp = (n: number) => `Rp${Math.round(n).toLocaleString("id-ID")}`;
  return (
    <div className="mx-auto w-70 rounded border border-slate-200 bg-white p-3 font-mono text-xs text-slate-800">
      <div className="text-center">
        {data.companyName && <div className="font-bold">{data.companyName}</div>}
        <div>{data.dateTime}</div>
        <div>{data.sourceRef}</div>
      </div>
      <hr className="my-2 border-dashed border-slate-300" />
      {data.lines.map((l, i) => (
        <div key={i} className="mb-1">
          <div>{l.name}</div>
          <div className="flex justify-between">
            <span>
              {l.qty} {l.uom} x {rp(l.unitPrice)}
            </span>
            <span>{rp(l.amount)}</span>
          </div>
        </div>
      ))}
      <hr className="my-2 border-dashed border-slate-300" />
      <div className="flex justify-between">
        <span>Subtotal</span>
        <span>{rp(data.subtotal)}</span>
      </div>
      {data.extraLines.map((l, i) => (
        <div key={i} className="flex justify-between">
          <span>{l.label}</span>
          <span>{rp(l.amount)}</span>
        </div>
      ))}
      {data.taxAmount > 0 && (
        <div className="flex justify-between">
          <span>PPN{data.taxRate != null ? ` (${data.taxRate}%)` : ""}</span>
          <span>{rp(data.taxAmount)}</span>
        </div>
      )}
      <hr className="my-2 border-dashed border-slate-300" />
      <div className="flex justify-between text-sm font-bold">
        <span>Total</span>
        <span>{rp(data.total)}</span>
      </div>
      <div className="flex justify-between">
        <span>Bayar ({data.paymentLabel})</span>
        <span>{data.cashReceived != null ? rp(data.cashReceived) : "-"}</span>
      </div>
      {data.change != null && (
        <div className="flex justify-between">
          <span>Kembalian</span>
          <span>{rp(data.change)}</span>
        </div>
      )}
      {data.customerName && <div className="mt-1">Pelanggan: {data.customerName}</div>}
      <div className="mt-2 text-center">Terima kasih!</div>
    </div>
  );
}

export default function CheckoutPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { isOnline } = useOnlineStatus();
  const pendingSyncCount = useLiveQuery(() => localDb.outboxSales.where("status").equals("pending").count(), [], 0);
  const reviewRows =
    useLiveQuery(
      () =>
        localDb.outboxSales
          .where("status")
          .anyOf("failed_stock", "failed_other")
          .sortBy("updatedAt")
          .then((rows) => rows.reverse()),
      [],
      []
    ) ?? [];
  const [checkingSession, setCheckingSession] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [showSyncDrawer, setShowSyncDrawer] = useState(false);
  const [showPrinterSettings, setShowPrinterSettings] = useState(false);
  const [printerPort, setPrinterPortState] = useState<string | null>(() => getPrinterPort());
  const [availablePorts, setAvailablePorts] = useState<string[]>([]);
  const [printerError, setPrinterError] = useState<string | null>(null);
  const [isPrinting, setIsPrinting] = useState(false);

  const [cart, setCart] = useState<CartLine[]>([]);
  const [scanInput, setScanInput] = useState("");
  const [scanError, setScanError] = useState<string | null>(null);
  const scanInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [extraLines, setExtraLines] = useState<ExtraLine[]>([]);
  // null = ikut default tax_settings.is_active; true/false = kasir override manual
  // buat transaksi ini doang (reset ke null lagi abis checkout sukses).
  const [taxOverride, setTaxOverride] = useState<boolean | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<"CASH" | "BANK">("CASH");
  const [cashReceived, setCashReceived] = useState("");
  const [customerId, setCustomerId] = useState<string>("");
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [historyDate, setHistoryDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [receiptModal, setReceiptModal] = useState<{ data: ReceiptData; mode: "success" | "review" } | null>(null);

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
  // Diskon otomatis (Diskon Penjualan + Beli N Gratis X) -- query ini PREVIEW doang buat
  // tampilan kembalian sebelum checkout; nilai otoritatif yang beneran dijurnal dihitung
  // ULANG server-side di dalam create_pos_sale (lihat item-discount-rules.ts/bundle-promo-rules.ts).
  const discountRulesQuery = useQuery({
    queryKey: ["item_discount_rules"],
    queryFn: fetchActiveItemDiscountRules,
    enabled: !checkingSession,
    staleTime: 10 * 60_000,
  });
  const bundleRulesQuery = useQuery({
    queryKey: ["bundle_promo_rules"],
    queryFn: fetchActiveBundlePromoRules,
    enabled: !checkingSession,
    staleTime: 10 * 60_000,
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

  const grossItemTotal = useMemo(
    () => cart.reduce((sum, line) => sum + line.qty_sold * line.unit_price, 0),
    [cart]
  );

  // Preview diskon (Diskon Penjualan + Beli N Gratis X) -- cart-wide, sama pola sisi admin
  // (apps/erp). item.category_id diambil dari katalog yang udah di-fetch, bukan query baru.
  const cartWithDiscount = useMemo(() => {
    const discountRules = discountRulesQuery.data ?? [];
    const bundleRules = bundleRulesQuery.data ?? [];
    const itemLookup = new Map((itemsQuery.data ?? []).map((it) => [it.id, it]));

    const itemResolved = cart.map((line) => {
      const item = itemLookup.get(line.item_id);
      const amount = line.qty_sold * line.unit_price;
      const resolved = resolveItemDiscount(line.item_id, item?.category_id ?? null, line.qty_sold, amount, discountRules);
      return { discountRuleId: resolved?.discount_rule_id ?? null, discountAmount: resolved?.discount_amount ?? 0 };
    });

    const bundleResolved = resolveBundlePromoDiscounts(
      cart.map((line) => ({ item_id: line.item_id, qty: line.qty_sold, unit_price: line.unit_price })),
      bundleRules
    );

    return cart.map((line, i) => {
      const bundle = bundleResolved.get(i);
      const gross = line.qty_sold * line.unit_price;
      const combinedDiscount = Math.min(itemResolved[i].discountAmount + (bundle?.discount_amount ?? 0), gross);
      return {
        ...line,
        discountRuleId: itemResolved[i].discountRuleId,
        bundlePromoRuleId: bundle?.bundle_promo_rule_id ?? null,
        combinedDiscount,
      };
    });
  }, [cart, discountRulesQuery.data, bundleRulesQuery.data, itemsQuery.data]);

  const totalDiscountPreview = useMemo(
    () => cartWithDiscount.reduce((sum, l) => sum + l.combinedDiscount, 0),
    [cartWithDiscount]
  );

  const itemTotal = grossItemTotal - totalDiscountPreview;

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
    mutationFn: async (): Promise<CheckoutResult> => {
      const cashAccountId =
        paymentMethod === "CASH" ? accountIds[ACCOUNT_CODES.KAS_TOKO] : accountIds[ACCOUNT_CODES.KAS_BANK];

      const resolvedExtraLines = extraLines
        .filter((l) => l.category_id && l.amount.trim() !== "")
        .map((l) => {
          const type = chargeTypes.find((c) => c.id === l.category_id);
          return { account_id: type?.account_id ?? "", amount: Number(l.amount) };
        });

      const cashReceivedNum = paymentMethod === "CASH" && cashReceived.trim() !== "" ? Number(cashReceived) : null;
      const changeNum = cashReceivedNum != null ? cashReceivedNum - total : null;

      const payload: OutboxSalePayload = {
        p_sale_date: new Date().toISOString().slice(0, 10),
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
      };

      // Snapshot struk/riwayat -- dihitung SEKALI di sini, gak tergantung online/offline
      // (sumbernya cuma cart/customer/extra/tax yang udah ada di client). Dipakai baik
      // buat modal "Transaksi Berhasil" (langsung, gak nunggu refetch server -- efek
      // sampingnya struk transaksi baru sekarang selalu tampilin JAM beneran, bukan
      // kolom `date` yang cuma tanggal) maupun outbox kalau ternyata offline.
      const customer = customers.find((c) => c.id === customerId) ?? null;
      const receiptSnapshot: OutboxReceiptSnapshot = {
        customerName: customer?.name ?? null,
        customerContact: customer?.contact ?? null,
        cashAccountId,
        lines: cart.map((l) => {
          const baseUom = catalog.find((c) => c.id === l.item_id)?.uom ?? l.unit_label;
          const qty = l.qty_sold * l.conversion_factor;
          const unitPrice = l.unit_price / l.conversion_factor;
          return { name: l.name, uom: baseUom, qty, unitPrice, amount: qty * unitPrice };
        }),
        extraTotal,
        taxTotal: taxAmount,
        discountTotal: totalDiscountPreview,
      };

      // Probe dulu SEBELUM nyoba RPC beneran -- bedain "gak bisa dijangkau" (offline,
      // masuk outbox) dari "server nolak" (error bisnis kayak stok gak cukup, harus
      // tetap nge-throw ke onError, JANGAN pernah masuk outbox). Lihat plan: offline
      // sync POS.
      if (await probeSupabase()) {
        try {
          const sourceRef = await generateDocumentNumber("pos_sales");
          const { error } = await supabase.rpc("create_pos_sale", { ...payload, p_source_ref: sourceRef });
          if (error) throw new Error(error.message);
          return { mode: "online", sourceRef, total, cartLines: cart, cashReceivedNum, changeNum, receiptSnapshot };
        } catch (err) {
          if (!isLikelyNetworkError(err)) throw err; // error bisnis asli -- bubble ke onError
          // else: probe sukses tapi koneksi putus tepat pas request -- lanjut ke jalur offline
        }
      }

      // JALUR OFFLINE -- simpan ke outbox lokal, sourceRef resmi baru didapat pas sync
      // (generate_document_number butuh online). Validasi oversell TIDAK terjadi di
      // sini (gak ada cara validasi ke server pas offline) -- ditangkep belakangan pas
      // sync-replay (offline-sync.ts), transaksi yang nolak masuk drawer sinkronisasi.
      const tempSourceRef = nextOfflineSourceRef();
      const now = new Date().toISOString();
      await localDb.outboxSales.add({
        id: crypto.randomUUID(),
        tempSourceRef,
        status: "pending",
        createdAt: now,
        updatedAt: now,
        retryCount: 0,
        lastError: null,
        payload,
        receiptSnapshot,
      });

      return { mode: "offline", sourceRef: tempSourceRef, total, cartLines: cart, cashReceivedNum, changeNum, receiptSnapshot };
    },
    onMutate: () => {
      setCheckoutError(null);
    },
    onError: (err) => {
      setCheckoutError(err instanceof Error ? err.message : "Gagal memproses transaksi");
    },
    onSuccess: (result) => {
      // Patch stok item yang baru terjual LANGSUNG di cache -- BUKAN refetch seluruh
      // katalog kayak sebelumnya (lihat diskusi performa: refetch abis tiap checkout
      // gak scale kalau katalog gede). Validasi oversell TETAP 100% di server lewat
      // create_pos_sale (RPC udah nolak kalau stok gak cukup sebelum baris ini
      // kejalan, KECUALI jalur offline yang validasinya baru kejadian pas sync) --
      // cache ini murni angka yang ditampilin ke kasir, bukan sumber kebenaran.
      // memory/architecture/app/tech-stack-decisions.md: POS gak boleh punya cache
      // stok PERMANEN -- staleTime pendek (15s) + refetch-on-focus (default React
      // Query) tetap jaga cache ini gak pernah "permanen".
      const patchedItems = (queryClient.getQueryData<ItemRow[]>(["items"]) ?? []).map((row) => {
        const soldBase = result.cartLines
          .filter((l) => l.item_id === row.id)
          .reduce((sum, l) => sum + l.qty_sold * l.conversion_factor, 0);
        if (soldBase === 0 || !row.inventory_balances) return row;
        return {
          ...row,
          inventory_balances: { qty_on_hand: row.inventory_balances.qty_on_hand - soldBase },
        };
      });
      queryClient.setQueryData<ItemRow[]>(["items"], patchedItems);
      void localDb.items.bulkPut(patchedItems); // biar fallback cache offline ikut konsisten

      const now = new Date().toISOString();
      const today = now.slice(0, 10);
      setHistoryDate(today);

      // Suntik langsung ke cache riwayat (bukan nunggu invalidate) buat KEDUA mode --
      // biar modal struk di bawah bisa dibangun instan tanpa race sama refetch, dan
      // riwayat/cetak-ulang jalan sama persis baik transaksi online maupun offline.
      const historyItem: SaleHistoryItem = {
        id: result.sourceRef,
        sourceRef: result.sourceRef,
        createdAt: now,
        ...result.receiptSnapshot,
      };
      queryClient.setQueryData<SaleHistoryItem[]>(["pos_sales", today, chargeTypesQuery.data], (old) => [
        historyItem,
        ...(old ?? []),
      ]);
      if (result.mode === "online") {
        queryClient.invalidateQueries({ queryKey: ["pos_sales", today] }); // rekonsiliasi latar belakang
      }

      setReceiptModal({
        data: receiptFromSale(historyItem, { cashReceived: result.cashReceivedNum, change: result.changeNum }),
        mode: "success",
      });

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

  // Window desktop (Tauri) gak punya tombol reload browser & bisa dibiarkan fokus
  // terus seharian di kios kasir -- refetchOnWindowFocus react-query jadi gak cukup
  // buat narik data terbaru (stok, pelanggan, dll), jadi kasir perlu tombol manual ini.
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await queryClient.invalidateQueries();
    } finally {
      setIsRefreshing(false);
    }
  }, [queryClient]);

  const handleSyncNow = useCallback(async () => {
    setIsSyncing(true);
    try {
      await syncOutbox();
      await queryClient.invalidateQueries({ queryKey: ["pos_sales"] });
    } finally {
      setIsSyncing(false);
    }
  }, [queryClient]);

  async function retryOutboxRow(id: string) {
    await localDb.outboxSales.update(id, { status: "pending" });
    await syncOutbox();
  }

  async function discardOutboxRow(id: string) {
    if (!window.confirm("Transaksi ini TIDAK akan pernah tercatat di sistem. Yakin buang?")) return;
    await localDb.outboxSales.delete(id);
  }

  // Trigger otomatis: event "online" (WebView2 gak selalu reliable soal ini --
  // tombol ☁️ Sync Sekarang di header jadi fallback manual) + 1x percobaan pas
  // app startup (nutup celah: app di-kill pas masih ada baris pending, dibuka
  // lagi udah online).
  useEffect(() => {
    void syncOutbox();
    const onOnline = () => void syncOutbox();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, []);

  const openPrinterSettings = useCallback(async () => {
    setShowPrinterSettings(true);
    setPrinterError(null);
    if (!isTauri()) return;
    try {
      const ports = await listSerialPorts();
      setAvailablePorts(ports);
    } catch (err) {
      setPrinterError(err instanceof Error ? err.message : "Gagal ambil daftar port.");
    }
  }, []);

  const saveSelectedPort = useCallback((port: string) => {
    setPrinterPort(port || null);
    setPrinterPortState(port || null);
  }, []);

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
      discountTotal: sale.discountTotal,
      total: subtotal - sale.discountTotal + sale.extraTotal + sale.taxTotal,
      paymentLabel: sale.cashAccountId === accountIds[ACCOUNT_CODES.KAS_TOKO] ? "Tunai" : "Bank",
      cashReceived: meta?.cashReceived ?? null,
      change: meta?.change ?? null,
    };
  }

  const printReceiptData = useCallback(
    async (receipt: ReceiptData) => {
      if (isTauri() && printerPort) {
        setIsPrinting(true);
        try {
          await printEscPos(printerPort, receipt);
        } catch (err) {
          setCheckoutError(
            `Gagal cetak ke printer (${printerPort}): ${err instanceof Error ? err.message : String(err)}`
          );
        } finally {
          setIsPrinting(false);
        }
        return;
      }

      const html = buildReceiptHtml(receipt);
      const ok = printReceipt(receipt.sourceRef, html);
      if (!ok) setCheckoutError("Popup diblokir browser — izinkan popup buat halaman ini, lalu coba lagi.");
    },
    [printerPort]
  );

  async function handlePrintSale(
    sale: SaleHistoryItem,
    meta?: { cashReceived: number | null; change: number | null }
  ) {
    await printReceiptData(receiptFromSale(sale, meta));
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
      if (showHistory || showPaymentModal || receiptModal) return;

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
  }, [filteredCatalog, showHistory, showPaymentModal, receiptModal, openPaymentModal, addToCart]);

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
      if (showHistory || showPaymentModal || receiptModal) return;
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
  }, [showHistory, showPaymentModal, receiptModal]);

  // Modal struk (sukses ATAU tinjau): Enter atau tombol Cetak sama-sama langsung
  // ngeprint lalu nutup modal -- kasir gak perlu klik dua kali (klik Cetak, klik
  // Tutup) pas alur transaksi cepat.
  useEffect(() => {
    if (!receiptModal) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Enter") {
        e.preventDefault();
        printReceiptData(receiptModal!.data).then(() => setReceiptModal(null));
      } else if (e.key === "Escape") {
        setReceiptModal(null);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [receiptModal, printReceiptData]);

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
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">Kasir</h1>
            <span
              className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${
                isOnline ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"
              }`}
            >
              <span className={`h-2 w-2 rounded-full ${isOnline ? "bg-emerald-500" : "bg-red-500"}`} />
              {isOnline ? "Online" : "Offline"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowHistory(true)}
              className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:border-slate-400"
            >
              <History className="h-4 w-4" /> Riwayat Transaksi
            </button>
            <button
              type="button"
              onClick={handleRefresh}
              disabled={isRefreshing}
              className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:border-slate-400 disabled:opacity-50"
              title="Muat ulang stok, pelanggan, dan data lain dari server"
            >
              <RefreshCw className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
              {isRefreshing ? "Memuat..." : "Refresh"}
            </button>
            <button
              type="button"
              onClick={() => setShowSyncDrawer(true)}
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm hover:opacity-90 ${
                reviewRows.length > 0
                  ? "border-red-300 bg-red-50 text-red-700"
                  : pendingSyncCount
                    ? "border-amber-300 bg-amber-50 text-amber-700"
                    : "border-slate-300 text-slate-600 hover:border-slate-400"
              }`}
              title="Sinkronisasi transaksi offline"
            >
              <CloudUpload className="h-4 w-4" /> Sinkronisasi
              {(pendingSyncCount || reviewRows.length) > 0 && (
                <span className="rounded-full bg-white/70 px-1.5 py-0.5 text-xs font-semibold">
                  {pendingSyncCount + reviewRows.length}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={openPrinterSettings}
              className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:border-slate-400"
              title="Atur printer thermal"
            >
              <Printer className="h-4 w-4" /> Printer{printerPort ? ` (${printerPort})` : ""}
            </button>
          </div>
        </div>
        <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <form onSubmit={handleScanSubmit}>
            <div className="flex items-center rounded-lg border border-slate-300 bg-white focus-within:border-blue-600 focus-within:ring-2 focus-within:ring-blue-600/40">
              <ScanLine className="ml-3 h-4 w-4 shrink-0 text-slate-400" />
              <input
                ref={scanInputRef}
                type="text"
                autoFocus
                placeholder="Scan / ketik kode..."
                value={scanInput}
                onChange={(e) => setScanInput(e.target.value)}
                className="w-full border-0 bg-transparent px-2.5 py-2.5 text-sm focus:outline-none"
              />
            </div>
            {scanError && <p className="mt-1 text-xs text-amber-600">{scanError}</p>}
          </form>
          <div className="flex items-center rounded-lg border border-slate-300 bg-white focus-within:border-blue-600 focus-within:ring-2 focus-within:ring-blue-600/40">
            <Search className="ml-3 h-4 w-4 shrink-0 text-slate-400" />
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Cari nama barang... (Ctrl+F)"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full border-0 bg-transparent px-2.5 py-2.5 text-sm focus:outline-none"
            />
          </div>
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
                <X className="h-5 w-5" />
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
                        className="text-xs text-slate-500 underline disabled:opacity-40"
                        disabled={isPrinting}
                        onClick={() => handlePrintSale(sale)}
                      >
                        Cetak
                      </button>
                      <button
                        type="button"
                        className="flex items-center gap-1 text-xs text-slate-500 underline"
                        onClick={() => setReceiptModal({ data: receiptFromSale(sale), mode: "review" })}
                      >
                        <Receipt className="h-3.5 w-3.5" /> Tinjau Struk
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
          {cartWithDiscount.map((line) => (
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
                {line.combinedDiscount > 0 && (
                  <div className="text-xs text-emerald-600">
                    {line.bundlePromoRuleId ? "Beli N Gratis X" : "Diskon otomatis"}: -Rp
                    {line.combinedDiscount.toLocaleString("id-ID")}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  className="flex h-7 w-7 items-center justify-center rounded border border-slate-300"
                  onClick={() => updateQty(line.item_id, line.unit_label, line.qty_sold - 1)}
                >
                  <Minus className="h-3.5 w-3.5" />
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
                  className="flex h-7 w-7 items-center justify-center rounded border border-slate-300"
                  onClick={() => updateQty(line.item_id, line.unit_label, line.qty_sold + 1)}
                  disabled={line.qty_sold >= line.available}
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
                <button
                  className="ml-1 text-red-500"
                  onClick={() => removeLine(line.item_id, line.unit_label)}
                  aria-label="Hapus baris"
                >
                  <X className="h-4 w-4" />
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
              {detailsExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
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
                        <X className="h-4 w-4" />
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
              <span>Rp{grossItemTotal.toLocaleString("id-ID")}</span>
            </div>
            {totalDiscountPreview > 0 && (
              <div className="flex justify-between text-emerald-600">
                <span>Diskon</span>
                <span>-Rp{totalDiscountPreview.toLocaleString("id-ID")}</span>
              </div>
            )}
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

          {checkoutError && !showPaymentModal && (
            <div className="rounded bg-red-50 p-2 text-sm text-red-700">{checkoutError}</div>
          )}

          <button
            className="w-full rounded bg-blue-600 py-3 font-medium text-white hover:bg-blue-700 disabled:opacity-40"
            disabled={cart.length === 0}
            onClick={openPaymentModal}
          >
            Bayar
          </button>
        </div>
      </div>
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
                <X className="h-5 w-5" />
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
                      paymentMethod === "CASH" ? "border-blue-600 bg-blue-600 text-white" : "border-slate-300"
                    }`}
                    onClick={() => setPaymentMethod("CASH")}
                  >
                    Tunai
                  </button>
                  <button
                    className={`flex-1 rounded border px-3 py-2 text-sm ${
                      paymentMethod === "BANK" ? "border-blue-600 bg-blue-600 text-white" : "border-slate-300"
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
              className="mt-5 w-full rounded bg-blue-600 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
            >
              {checkoutMutation.isPending ? "Memproses..." : "Bayar"}
            </button>
          </div>
        </div>
      )}
      {showPrinterSettings && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setShowPrinterSettings(false)}
        >
          <div className="w-full max-w-sm rounded-lg bg-white p-5" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-semibold">Pengaturan Printer Thermal</h3>
              <button
                type="button"
                onClick={() => setShowPrinterSettings(false)}
                className="text-slate-500"
                aria-label="Tutup"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {!isTauri() && (
              <p className="text-sm text-amber-600">
                Print langsung ke printer cuma jalan di aplikasi desktop, bukan di browser.
              </p>
            )}

            {isTauri() && (
              <div className="space-y-3">
                <p className="text-sm text-slate-500">
                  Pairing printer lewat Bluetooth Windows dulu (Settings → Bluetooth & devices), baru pilih COM
                  port-nya di sini.
                </p>
                <div>
                  <label className="mb-1 block text-xs text-slate-500">COM Port</label>
                  <select
                    className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
                    value={printerPort ?? ""}
                    onChange={(e) => saveSelectedPort(e.target.value)}
                  >
                    <option value="">— Belum dipilih —</option>
                    {availablePorts.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  onClick={openPrinterSettings}
                  className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:border-slate-400"
                >
                  <RefreshCw className="h-4 w-4" /> Cari Ulang Port
                </button>
                {printerError && <p className="text-sm text-red-600">{printerError}</p>}
                {printerPort && (
                  <p className="text-sm text-emerald-600">
                    Aktif: struk bakal langsung cetak ke {printerPort} (tanpa dialog print).
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      <div
        className={`fixed inset-0 z-40 transition-opacity duration-200 ${
          showSyncDrawer ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
        }`}
        aria-hidden={!showSyncDrawer}
      >
        <div className="absolute inset-0 bg-black/40" onClick={() => setShowSyncDrawer(false)} />
        <div
          className={`absolute inset-y-0 left-0 flex w-96 max-w-full flex-col bg-white shadow-xl transition-transform duration-200 ${
            showSyncDrawer ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <div className="border-b border-slate-200 p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-1.5 font-semibold">
                <CloudUpload className="h-4 w-4" /> Sinkronisasi
              </h2>
              <button
                type="button"
                onClick={() => setShowSyncDrawer(false)}
                className="text-slate-500"
                aria-label="Tutup"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <button
              type="button"
              onClick={handleSyncNow}
              disabled={isSyncing || !pendingSyncCount}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
            >
              {isSyncing ? (
                <>
                  <RefreshCw className="h-4 w-4 animate-spin" /> Sinkron...
                </>
              ) : pendingSyncCount ? (
                <>
                  <CloudUpload className="h-4 w-4" /> Sync Sekarang ({pendingSyncCount})
                </>
              ) : (
                "Semua transaksi sudah tersinkron"
              )}
            </button>
          </div>
          <div className="flex-1 space-y-3 overflow-y-auto p-4">
            {!pendingSyncCount && reviewRows.length === 0 && (
              <div className="text-sm text-slate-400">Gak ada transaksi menunggu sinkronisasi.</div>
            )}
            {reviewRows.length > 0 && (
              <div>
                <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-red-600">
                  <AlertTriangle className="h-3.5 w-3.5" /> Perlu Ditinjau
                </div>
                <p className="mb-3 text-xs text-slate-500">
                  Transaksi ini gagal disinkronkan (biasanya stok gak cukup pas dicek ulang). Struk sudah tercetak
                  ke pelanggan, tapi belum tercatat resmi. Input stok opname dulu kalau perlu, baru retry — atau
                  buang kalau memang gak bisa dilanjutkan.
                </p>
                <div className="space-y-3">
                  {reviewRows.map((row) => {
                    const rowTotal =
                      row.receiptSnapshot.lines.reduce((s, l) => s + l.amount, 0) +
                      row.receiptSnapshot.extraTotal +
                      row.receiptSnapshot.taxTotal;
                    return (
                      <div key={row.id} className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-medium">{row.tempSourceRef}</span>
                          <span className="text-xs text-slate-500">
                            {new Date(row.updatedAt).toLocaleString("id-ID")}
                          </span>
                        </div>
                        <div className="mt-1 space-y-0.5 text-xs text-slate-600">
                          {row.receiptSnapshot.lines.map((l, i) => (
                            <div key={i} className="flex justify-between">
                              <span>
                                {l.name} — {l.qty} {l.uom} x Rp{l.unitPrice.toLocaleString("id-ID")}
                              </span>
                              <span>Rp{l.amount.toLocaleString("id-ID")}</span>
                            </div>
                          ))}
                        </div>
                        <div className="mt-1 flex justify-between text-sm font-semibold">
                          <span>Total</span>
                          <span>Rp{rowTotal.toLocaleString("id-ID")}</span>
                        </div>
                        <p className="mt-1 text-xs text-red-700">
                          {row.lastError ?? "Gagal sync (sebab tidak diketahui)"}
                        </p>
                        <div className="mt-2 flex gap-2">
                          <button
                            type="button"
                            onClick={() => retryOutboxRow(row.id)}
                            className="flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs hover:border-slate-400"
                          >
                            <RefreshCw className="h-3 w-3" /> Retry
                          </button>
                          <button
                            type="button"
                            onClick={() => discardOutboxRow(row.id)}
                            className="flex items-center gap-1 rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:border-red-400"
                          >
                            <Trash2 className="h-3 w-3" /> Buang
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {pendingSyncCount > 0 && (
              <div className="rounded border border-slate-200 bg-slate-50 p-2 text-xs text-slate-500">
                {pendingSyncCount} transaksi menunggu koneksi buat disinkronkan otomatis.
              </div>
            )}
          </div>
        </div>
      </div>
      {receiptModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setReceiptModal(null)}
        >
          <div className="w-full max-w-sm rounded-lg bg-white p-5" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="flex items-center gap-1.5 font-semibold">
                {receiptModal.mode === "success" ? (
                  <>
                    <CheckCircle2 className="h-5 w-5 text-emerald-600" /> Transaksi Berhasil!
                  </>
                ) : (
                  <>
                    <Receipt className="h-5 w-5 text-slate-500" /> Tinjau Struk
                  </>
                )}
              </h3>
              <button
                type="button"
                onClick={() => setReceiptModal(null)}
                className="text-slate-500"
                aria-label="Tutup"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <ReceiptPreview data={receiptModal.data} />
            {checkoutError && <div className="mt-3 rounded bg-red-50 p-2 text-xs text-red-700">{checkoutError}</div>}
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                autoFocus
                disabled={isPrinting}
                onClick={() => printReceiptData(receiptModal.data).then(() => setReceiptModal(null))}
                className="flex flex-1 items-center justify-center gap-1.5 rounded bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
              >
                {isPrinting ? (
                  <>
                    <RefreshCw className="h-4 w-4 animate-spin" /> Mencetak...
                  </>
                ) : (
                  <>
                    <Printer className="h-4 w-4" /> Cetak (Enter)
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={() => setReceiptModal(null)}
                className="rounded border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:border-slate-400"
              >
                Tutup
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
