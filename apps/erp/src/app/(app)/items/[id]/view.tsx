"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { supabase } from "@/lib/supabase/client";
import { type Item } from "@/lib/items/schema";
import type { ItemUnit } from "@/lib/item-units/schema";
import { getLeafAccounts, type Account } from "@/lib/accounts/schema";
import type { InventoryBalance } from "@/lib/inventory/schema";
import type { ItemCategory } from "@/lib/item-categories/schema";
import type { ItemBrand } from "@/lib/item-brands/schema";
import { formatStockBreakdown } from "@/lib/stock-display";
import { formatCreatedBy } from "@/lib/created-by";
import {
  DEFAULT_MOVEMENT_PAGE_SIZE,
  MOVEMENT_PAGE_SIZE_OPTIONS,
  fetchItemMovementPage,
  type ItemMovement,
  type MovementPage,
} from "@/lib/inventory/movements";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { DetailRows } from "@/components/ui/detail-rows";
import { Tabs } from "@/components/ui/tabs";
import { Pagination } from "@/components/ui/pagination";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { LoadingScreen } from "@/components/ui/loading-screen";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const itemTypeLabel: Record<string, string> = {
  RAW_MATERIAL: "Bahan Baku",
  FINISHED_GOOD: "Barang Jadi",
};

const EMPTY_MOVEMENT_PAGE: MovementPage = { rows: [], total: 0, openingBalance: 0 };

// Key khusus di state printingUnitId / settingDefaultUnitId buat aksi level barang (bukan baris satuan).
const ITEM_LABEL_KEY = "__item__";
const CLEAR_DEFAULT_KEY = "__clear_default__";

export function ItemDetailView({ id }: { id: string }) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [checkingSession, setCheckingSession] = useState(true);
  const [item, setItem] = useState<Item | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [balance, setBalance] = useState<InventoryBalance | null>(null);
  const [units, setUnits] = useState<ItemUnit[]>([]);
  const [categories, setCategories] = useState<ItemCategory[]>([]);
  const [brands, setBrands] = useState<ItemBrand[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [deleting, setDeleting] = useState(false);

  // printingUnitId juga dipakai buat label kode barang (key khusus ITEM_LABEL_KEY) -- 1 state
  // cukup karena label cuma dicetak 1 per waktu.
  const [printingUnitId, setPrintingUnitId] = useState<string | null>(null);
  const [generatingItemCode, setGeneratingItemCode] = useState(false);
  const [settingDefaultUnitId, setSettingDefaultUnitId] = useState<string | null>(null);

  const [editingUnitId, setEditingUnitId] = useState<string | null>(null);
  const [editUnitPrice, setEditUnitPrice] = useState("");
  const [savingUnitId, setSavingUnitId] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState("units");
  const [movementAsOfDate, setMovementAsOfDate] = useState(today());
  const [movementPageNum, setMovementPageNum] = useState(0);
  const [movementPageSize, setMovementPageSize] = useState(DEFAULT_MOVEMENT_PAGE_SIZE);
  const [movementPage, setMovementPage] = useState<MovementPage>(EMPTY_MOVEMENT_PAGE);
  const [movementLoading, setMovementLoading] = useState(false);
  const [movementError, setMovementError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [{ data: it, error: itErr }, { data: acc }, { data: bal }, { data: us }, { data: cats }, { data: brs }] =
      await Promise.all([
        supabase
          .from("items")
          .select(
            "id, name, item_type, uom, inventory_account_id, category_id, brand_id, archived_at, created_by, created_at, barcode"
          )
          .eq("id", id)
          .single(),
        supabase
          .from("accounts")
          .select("id, code, name, category, normal_balance, is_contra, parent_id, archived_at"),
        supabase.from("inventory_balances").select("item_id, qty_on_hand, avg_cost").eq("item_id", id).maybeSingle(),
        supabase
          .from("item_units")
          .select("id, item_id, unit_label, conversion_factor, price, is_base, barcode, is_default_sale")
          .eq("item_id", id)
          .order("is_base", { ascending: false }),
        supabase.from("item_categories").select("id, name, archived_at").order("name"),
        supabase.from("item_brands").select("id, name, archived_at").order("name"),
      ]);
    if (itErr) {
      setLoadError(itErr.message);
      return;
    }
    setLoadError(null);
    setItem(it as Item);
    setAccounts((acc ?? []) as Account[]);
    setBalance((bal as InventoryBalance) ?? null);
    setUnits((us ?? []) as ItemUnit[]);
    setCategories((cats ?? []) as ItemCategory[]);
    setBrands((brs ?? []) as ItemBrand[]);
  }, [id]);

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
      await load();
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, load]);

  const loadMovements = useCallback(
    async (asOf: string, pageArg: number, pageSizeArg: number) => {
      setMovementLoading(true);
      try {
        const result = await fetchItemMovementPage(id, asOf, pageArg, pageSizeArg);
        setMovementPage(result);
        setMovementError(null);
      } catch (err) {
        setMovementError(err instanceof Error ? err.message : "Gagal memuat Kartu Stok");
      } finally {
        setMovementLoading(false);
      }
    },
    [id]
  );

  useEffect(() => {
    if (activeTab !== "kartu-stok") return;
    Promise.resolve().then(() => {
      loadMovements(movementAsOfDate, movementPageNum, movementPageSize);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, movementPageNum, movementPageSize]);

  if (checkingSession) {
    return <LoadingScreen />;
  }

  if (!item) {
    return <FormError>{loadError ?? "Item gak ditemukan."}</FormError>;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");
  const inventoryAccount = getLeafAccounts(accounts).find((a) => a.id === item.inventory_account_id);
  const totalQty = balance?.qty_on_hand ?? 0;
  const totalValue = (balance?.qty_on_hand ?? 0) * (balance?.avg_cost ?? 0);
  const category = categories.find((c) => c.id === item.category_id);
  const brand = brands.find((b) => b.id === item.brand_id);
  // Satuan yang bakal masuk keranjang POS pas kode barang discan: default kalau ada, kalau
  // gak ada ya satuan dasar (fallback yang sama dipakai POS).
  const defaultSaleUnit = units.find((u) => u.is_default_sale);
  const scanUnit = defaultSaleUnit ?? units.find((u) => u.is_base);

  const detailGroups = [
    {
      title: "Informasi Item",
      rows: [
        { label: "Nama", value: item.name },
        {
          label: "Tipe",
          value: (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
              {itemTypeLabel[item.item_type] ?? item.item_type}
            </span>
          ),
        },
        { label: "Satuan Dasar", value: item.uom },
        { label: "Kategori", value: category ? category.name : "-" },
        { label: "Brand", value: brand ? brand.name : "-" },
        {
          label: "Akun Persediaan",
          value: inventoryAccount ? `${inventoryAccount.code} — ${inventoryAccount.name}` : "-",
        },
        { label: "Status", value: item.archived_at ? "Diarsipkan" : "Aktif" },
        { label: "Dibuat oleh", value: formatCreatedBy(item.created_by, item.created_at) },
      ],
    },
    {
      title: "Ringkasan Stok",
      rows: [
        { label: "Qty Tersisa", value: formatStockBreakdown(totalQty, item.uom, units) },
        { label: "Avg Cost / " + item.uom, value: (balance?.avg_cost ?? 0).toLocaleString("id-ID") },
        { label: "Nilai Persediaan", value: totalValue.toLocaleString("id-ID") },
      ],
    },
  ];

  async function handleDelete() {
    if (!item) return;
    const ok = await confirm({
      title: "Hapus Item",
      message: `Hapus item "${item.name}"?`,
      confirmLabel: "Hapus",
      danger: true,
    });
    if (!ok) return;
    setDeleting(true);
    const { data, error } = await supabase.rpc("delete_item", { p_item_id: item.id });
    setDeleting(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    if (data === "deleted") {
      toast.success(`Item "${item.name}" berhasil dihapus.`);
      router.push("/items");
      return;
    }
    toast.success("Item ini sudah pernah dipakai di transaksi, jadi diarsipkan (bukan dihapus permanen).");
    await load();
  }

  async function handleReactivate() {
    if (!item) return;
    setDeleting(true);
    const { error } = await supabase.from("items").update({ archived_at: null }).eq("id", item.id);
    setDeleting(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Item berhasil diaktifkan kembali.");
    await load();
  }

  async function handleDeleteUnit(unitId: string) {
    const ok = await confirm({
      title: "Hapus Satuan Jual",
      message: "Hapus satuan jual ini? Kalau cuma mau ubah harga, pakai tombol Ubah -- gak perlu hapus.",
      confirmLabel: "Hapus",
      danger: true,
    });
    if (!ok) return;
    const { error } = await supabase.from("item_units").delete().eq("id", unitId);
    if (error) {
      // 23503 = foreign key violation: satuan ini dirujuk aturan promo (syarat minimal diskon /
      // qty beli / qty hadiah bundle) atau transaksi.
      toast.error(
        error.code === "23503"
          ? "Satuan ini masih dipakai aturan promo atau transaksi, jadi gak bisa dihapus."
          : error.message
      );
      return;
    }
    toast.success("Satuan jual berhasil dihapus.");
    await load();
  }

  function startEditPrice(unit: ItemUnit) {
    setEditingUnitId(unit.id);
    setEditUnitPrice(unit.price != null ? String(unit.price) : "");
  }

  async function handleSavePrice(unitId: string) {
    const parsed = editUnitPrice.trim() === "" ? null : Number(editUnitPrice);
    if (parsed != null && (Number.isNaN(parsed) || parsed < 0)) {
      toast.error("Harga harus angka dan gak boleh negatif.");
      return;
    }
    setSavingUnitId(unitId);
    const { error } = await supabase.from("item_units").update({ price: parsed }).eq("id", unitId);
    setSavingUnitId(null);
    if (error) {
      toast.error(error.message);
      return;
    }
    setEditingUnitId(null);
    toast.success("Harga satuan berhasil diperbarui.");
    await load();
  }

  // Print lewat window baru (bukan @media print di halaman ini) -- native <dialog>
  // (Modal) gak konsisten diprint lintas browser (Firefox sering skip isi dialog
  // sama sekali pas print), dan trik "visibility:hidden semua elemen lain" gampang
  // nyisain halaman kosong karena elemen yang disembunyiin tetap makan document
  // flow. Window terpisah = gak ada chrome/dialog yang perlu disembunyiin sama sekali.
  async function printLabel(key: string, code: string, subtitle: string) {
    if (!item) return;
    setPrintingUnitId(key);
    try {
      const qrDataUrl = await QRCode.toDataURL(code, { width: 220, margin: 1 });
      const printWindow = window.open("", "_blank", "width=420,height=520");
      if (!printWindow) {
        toast.error("Popup diblokir browser — izinkan popup buat halaman ini, lalu coba lagi.");
        return;
      }
      const priceLine = escapeHtml(subtitle);
      printWindow.document.write(`<!doctype html>
<html>
<head>
<title>Label — ${escapeHtml(item.name)}</title>
<style>
  body { font-family: Arial, Helvetica, sans-serif; text-align: center; padding: 24px; }
  img { width: 220px; height: 220px; }
  .name { margin-top: 10px; font-weight: 600; font-size: 15px; }
  .meta { margin-top: 2px; color: #64748b; font-size: 13px; }
</style>
</head>
<body>
  <img src="${qrDataUrl}" alt="QR ${escapeHtml(code)}" />
  <div class="name">${escapeHtml(item.name)}</div>
  <div class="meta">${priceLine}</div>
  <script>window.onload = function () { window.print(); };</script>
</body>
</html>`);
      printWindow.document.close();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Gagal siapin label buat print");
    } finally {
      setPrintingUnitId(null);
    }
  }

  function handlePrintLabel(u: ItemUnit) {
    if (!u.barcode) return;
    const subtitle =
      u.price != null ? `Rp${u.price.toLocaleString("id-ID")}/${u.unit_label}` : u.unit_label;
    return printLabel(u.id, u.barcode, subtitle);
  }

  // Label kode barang -- subtitle nunjukin satuan jual default (atau satuan dasar kalau belum
  // ada yang ditandai), konsisten sama satuan yang bakal masuk keranjang POS pas discan.
  function handlePrintItemLabel() {
    if (!item?.barcode) return;
    const target = units.find((u) => u.is_default_sale) ?? units.find((u) => u.is_base);
    const subtitle = target
      ? target.price != null
        ? `Rp${target.price.toLocaleString("id-ID")}/${target.unit_label}`
        : target.unit_label
      : item.uom;
    return printLabel(ITEM_LABEL_KEY, item.barcode, subtitle);
  }

  async function handleGenerateItemBarcode() {
    if (!item) return;
    setGeneratingItemCode(true);
    const { error } = await supabase.rpc("generate_item_barcode", { p_item_id: item.id });
    setGeneratingItemCode(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Kode scan barang berhasil dibuat.");
    await load();
  }

  async function handleSetDefaultUnit(unitId: string) {
    setSettingDefaultUnitId(unitId);
    const { error } = await supabase.rpc("set_item_default_sale_unit", { p_unit_id: unitId });
    setSettingDefaultUnitId(null);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Satuan jual default berhasil diatur.");
    await load();
  }

  async function handleClearDefaultUnit() {
    if (!item) return;
    setSettingDefaultUnitId(CLEAR_DEFAULT_KEY);
    const { error } = await supabase.rpc("clear_item_default_sale_unit", { p_item_id: item.id });
    setSettingDefaultUnitId(null);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Satuan jual default dicabut — scan kode barang pakai satuan dasar.");
    await load();
  }

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/items" label="Kembali ke Item" />
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-black">Detail Item</h1>
        {canWrite && (
          <div className="flex gap-2">
            <Button variant="toolbar" onClick={() => router.push(`/items/${item.id}/edit`)}>
              Edit
            </Button>
            {item.archived_at ? (
              <Button variant="toolbar" onClick={handleReactivate} disabled={deleting}>
                {deleting ? "Memproses..." : "Aktifkan"}
              </Button>
            ) : (
              <Button variant="toolbar" onClick={handleDelete} disabled={deleting}>
                {deleting ? "Memproses..." : "Hapus"}
              </Button>
            )}
          </div>
        )}
      </div>

      {loadError && <FormError>{loadError}</FormError>}

      <p className="text-sm text-slate-500">
        Weighted Average gak nyimpen riwayat per-batch — cuma 1 angka rata-rata berjalan,
        dihitung ulang tiap ada penerimaan baru (ref <code>docs/domain/inventory.md</code>).
      </p>

      <DetailRows groups={detailGroups} />

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
        <div className="max-w-xl">
          <p className="text-sm font-medium text-black">Kode Scan Barang</p>
          <p className="text-xs text-slate-500">
            Cukup 1 label per barang. Scan di kasir (POS) masuk keranjang dalam satuan{" "}
            <span className="font-medium text-slate-700">{scanUnit?.unit_label ?? item.uom}</span>
            {defaultSaleUnit ? " (default jual)" : " (satuan dasar — belum ada default jual)"}; kasir bisa
            ganti satuannya di keranjang.
          </p>
          {scanUnit && scanUnit.price == null && (
            <p className="mt-1 text-xs text-amber-600">
              Satuan {scanUnit.unit_label} belum punya harga — kode barang ini belum bisa dijual di kasir.
            </p>
          )}
        </div>
        {item.barcode ? (
          <div className="flex items-center gap-3">
            <span className="font-mono text-sm text-slate-700">{item.barcode}</span>
            <button
              type="button"
              onClick={handlePrintItemLabel}
              disabled={printingUnitId === ITEM_LABEL_KEY}
              className="text-xs font-medium text-blue-600 underline hover:text-blue-700 disabled:opacity-50"
            >
              {printingUnitId === ITEM_LABEL_KEY ? "Menyiapkan..." : "Cetak Label"}
            </button>
          </div>
        ) : canWrite ? (
          <Button type="button" variant="toolbar" onClick={handleGenerateItemBarcode} disabled={generatingItemCode}>
            {generatingItemCode ? "Membuat..." : "Buat Kode Barang"}
          </Button>
        ) : (
          <span className="text-xs text-slate-400">Belum ada kode</span>
        )}
      </div>

      <Tabs
        tabs={[
          { key: "units", label: "Satuan Jual & Harga", badge: units.length },
          { key: "kartu-stok", label: "Kartu Stok" },
        ]}
        active={activeTab}
        onChange={setActiveTab}
      />

      {activeTab === "units" && (
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-black">Satuan Jual & Harga</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
              {units.length}
            </span>
          </div>
          {canWrite && (
            <Button variant="toolbar" onClick={() => router.push(`/items/${id}/units/new`)}>
              + Tambah Satuan
            </Button>
          )}
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Satuan</th>
              <th className="px-4 py-2 text-right">Faktor Konversi</th>
              <th className="px-4 py-2 text-right">Harga</th>
              <th className="px-4 py-2">Default Jual</th>
              <th className="px-4 py-2">Kode Scan</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {units.map((u) => (
              <tr key={u.id} className="border-b border-slate-100">
                <td className="px-4 py-2">
                  {u.unit_label}
                  {u.is_base && (
                    <span className="ml-1.5 rounded-full bg-blue-50 px-1.5 py-0.5 text-xs text-blue-700">
                      dasar
                    </span>
                  )}
                </td>
                <td className="px-4 py-2 text-right font-mono">{u.conversion_factor}</td>
                <td className="px-4 py-2 text-right font-mono">
                  {editingUnitId === u.id ? (
                    <div className="ml-auto w-28">
                      <Input
                        type="number"
                        min="0"
                        autoFocus
                        value={editUnitPrice}
                        onChange={(e) => setEditUnitPrice(e.target.value)}
                        className="text-right"
                      />
                    </div>
                  ) : (
                    (u.price != null ? u.price.toLocaleString("id-ID") : "-")
                  )}
                </td>
                <td className="px-4 py-2">
                  {u.is_default_sale ? (
                    <div className="flex items-center gap-2">
                      <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-700">
                        default
                      </span>
                      {canWrite && (
                        <button
                          type="button"
                          onClick={handleClearDefaultUnit}
                          disabled={settingDefaultUnitId === CLEAR_DEFAULT_KEY}
                          className="text-xs text-slate-400 underline hover:text-slate-600 disabled:opacity-50"
                        >
                          Cabut
                        </button>
                      )}
                    </div>
                  ) : canWrite && u.price != null ? (
                    <button
                      type="button"
                      onClick={() => handleSetDefaultUnit(u.id)}
                      disabled={settingDefaultUnitId === u.id}
                      className="text-xs font-medium text-blue-600 underline hover:text-blue-700 disabled:opacity-50"
                    >
                      {settingDefaultUnitId === u.id ? "Menyimpan..." : "Jadikan default"}
                    </button>
                  ) : (
                    <span className="text-xs text-slate-400">—</span>
                  )}
                </td>
                <td className="px-4 py-2">
                  {u.barcode ? (
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-slate-600">{u.barcode}</span>
                      <button
                        type="button"
                        onClick={() => handlePrintLabel(u)}
                        disabled={printingUnitId === u.id}
                        className="text-xs font-medium text-blue-600 underline hover:text-blue-700 disabled:opacity-50"
                      >
                        {printingUnitId === u.id ? "Menyiapkan..." : "Cetak Label"}
                      </button>
                    </div>
                  ) : u.price == null ? (
                    <span className="text-xs text-slate-400" title="Isi harga dulu — QR code cuma buat barang yang dijual">
                      Belum ada harga
                    </span>
                  ) : (
                    <span className="text-xs text-slate-400">—</span>
                  )}
                </td>
                <td className="px-4 py-2 text-right">
                  {canWrite && (
                    <div className="flex items-center justify-end gap-2">
                      {editingUnitId === u.id ? (
                        <>
                          <Button
                            type="button"
                            variant="toolbar"
                            onClick={() => setEditingUnitId(null)}
                            disabled={savingUnitId === u.id}
                          >
                            Batal
                          </Button>
                          <Button
                            type="button"
                            variant="toolbar-primary"
                            onClick={() => handleSavePrice(u.id)}
                            disabled={savingUnitId === u.id}
                          >
                            {savingUnitId === u.id ? "..." : "Simpan"}
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button type="button" variant="toolbar" onClick={() => startEditPrice(u)}>
                            Ubah
                          </Button>
                          <button
                            type="button"
                            onClick={() => handleDeleteUnit(u.id)}
                            className="text-slate-400 hover:text-red-600"
                            aria-label="Hapus satuan"
                          >
                            ✕
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {units.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                  Belum ada satuan jual — item ini belum bisa dipakai di Barang Keluar.
                </td>
              </tr>
            )}
          </tbody>
        </table>

      </div>
      )}

      {activeTab === "kartu-stok" && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="movement_as_of_date">Sampai Tanggal</Label>
              <Input
                id="movement_as_of_date"
                type="date"
                value={movementAsOfDate}
                onChange={(e) => {
                  setMovementAsOfDate(e.target.value);
                  setMovementPageNum(0);
                  loadMovements(e.target.value, 0, movementPageSize);
                }}
              />
            </div>
          </div>

          {movementError && <FormError>{movementError}</FormError>}

          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
                  <th className="px-4 py-2">Tanggal</th>
                  <th className="px-4 py-2">Sumber</th>
                  <th className="px-4 py-2">Referensi</th>
                  <th className="px-4 py-2 text-right">Qty Masuk</th>
                  <th className="px-4 py-2 text-right">Qty Keluar</th>
                  <th className="px-4 py-2 text-right">Saldo Berjalan</th>
                </tr>
              </thead>
              <tbody>
                {movementLoading && (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                      Memuat...
                    </td>
                  </tr>
                )}
                {!movementLoading && movementPage.rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                      Belum ada mutasi buat item ini.
                    </td>
                  </tr>
                )}
                {!movementLoading &&
                  [...movementPage.rows]
                    .reverse()
                    .reduce<(ItemMovement & { running: number })[]>((acc, m) => {
                      const prevRunning = acc.length > 0 ? acc[acc.length - 1].running : movementPage.openingBalance;
                      return [...acc, { ...m, running: prevRunning + m.qty }];
                    }, [])
                    .reverse()
                    .map((m) => (
                    <tr key={m.id} className="border-b border-slate-100 hover:bg-slate-50">
                      <td className="whitespace-nowrap px-4 py-2">{m.movement_date}</td>
                      <td className="px-4 py-2">{m.source_label}</td>
                      <td className="px-4 py-2">
                        {m.source_ref ? (
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-600">
                            {m.source_ref}
                          </span>
                        ) : (
                          "-"
                        )}
                      </td>
                      <td className="px-4 py-2 text-right font-mono">
                        {m.qty > 0 ? formatStockBreakdown(m.qty, item.uom, units) : ""}
                      </td>
                      <td className="px-4 py-2 text-right font-mono">
                        {m.qty < 0 ? formatStockBreakdown(-m.qty, item.uom, units) : ""}
                      </td>
                      <td className="px-4 py-2 text-right font-mono font-medium">
                        {formatStockBreakdown(m.running, item.uom, units)}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            <Pagination
              page={movementPageNum}
              pageSize={movementPageSize}
              total={movementPage.total}
              onPageChange={(newPage) => {
                setMovementPageNum(newPage);
              }}
              pageSizeOptions={MOVEMENT_PAGE_SIZE_OPTIONS}
              onPageSizeChange={(newSize) => {
                setMovementPageSize(newSize);
                setMovementPageNum(0);
              }}
            />
          </div>
        </div>
      )}

    </div>
  );
}

// Interpolasi ke document.write() di handlePrintLabel butuh escape manual (bukan
// JSX yang otomatis escape) -- item.name/unit_label itu master data yang admin
// ketik bebas, jangan sampai jadi HTML/script injection ke window print.
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
