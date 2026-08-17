"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { supabase } from "@/lib/supabase/client";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { itemTypes, updateItemSchema, type Item } from "@/lib/items/schema";
import { createItemUnitSchema, type ItemUnit } from "@/lib/item-units/schema";
import { getLeafAccounts, type Account } from "@/lib/accounts/schema";
import type { InventoryBalance } from "@/lib/inventory/schema";
import type { ItemCategory } from "@/lib/item-categories/schema";
import type { ItemBrand } from "@/lib/item-brands/schema";
import { fetchDefaultAccounts, type ResolvedAccount } from "@/lib/default-accounts/schema";
import { formatStockBreakdown } from "@/lib/stock-display";
import {
  DEFAULT_MOVEMENT_PAGE_SIZE,
  MOVEMENT_PAGE_SIZE_OPTIONS,
  fetchItemMovementPage,
  type ItemMovement,
  type MovementPage,
} from "@/lib/inventory/movements";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { Modal } from "@/components/ui/modal";
import { DetailRows } from "@/components/ui/detail-rows";
import { LockedAccountField } from "@/components/ui/locked-account-field";
import { Tabs } from "@/components/ui/tabs";
import { Pagination } from "@/components/ui/pagination";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const EMPTY_MOVEMENT_PAGE: MovementPage = { rows: [], total: 0, openingBalance: 0 };

export function ItemDetailView({ id }: { id: string }) {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [item, setItem] = useState<Item | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [balance, setBalance] = useState<InventoryBalance | null>(null);
  const [units, setUnits] = useState<ItemUnit[]>([]);
  const [categories, setCategories] = useState<ItemCategory[]>([]);
  const [brands, setBrands] = useState<ItemBrand[]>([]);
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [showEditForm, setShowEditForm] = useState(false);
  const [editName, setEditName] = useState("");
  const [editItemType, setEditItemType] = useState<(typeof itemTypes)[number]>("RAW_MATERIAL");
  const [editUom, setEditUom] = useState("");
  const [editCategoryId, setEditCategoryId] = useState("");
  const [editBrandId, setEditBrandId] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [editSubmitting, setEditSubmitting] = useState(false);

  const [showUnitForm, setShowUnitForm] = useState(false);
  const [unitIsBase, setUnitIsBase] = useState(false);
  const [unitLabel, setUnitLabel] = useState("");
  const [conversionFactor, setConversionFactor] = useState("1");
  const [unitPrice, setUnitPrice] = useState("");
  const [unitError, setUnitError] = useState<string | null>(null);
  const [unitSubmitting, setUnitSubmitting] = useState(false);

  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [barcodeError, setBarcodeError] = useState<string | null>(null);
  const [generatingUnitId, setGeneratingUnitId] = useState<string | null>(null);
  const [printingUnitId, setPrintingUnitId] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState("units");
  const [movementAsOfDate, setMovementAsOfDate] = useState(today());
  const [movementPageNum, setMovementPageNum] = useState(0);
  const [movementPageSize, setMovementPageSize] = useState(DEFAULT_MOVEMENT_PAGE_SIZE);
  const [movementPage, setMovementPage] = useState<MovementPage>(EMPTY_MOVEMENT_PAGE);
  const [movementLoading, setMovementLoading] = useState(false);
  const [movementError, setMovementError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [{ data: it, error: itErr }, { data: acc }, { data: bal }, { data: us }, { data: cats }, { data: brs }, resolvedDefaultAccounts] =
      await Promise.all([
        supabase
          .from("items")
          .select("id, name, item_type, uom, inventory_account_id, category_id, brand_id, archived_at")
          .eq("id", id)
          .single(),
        supabase
          .from("accounts")
          .select("id, code, name, category, normal_balance, is_contra, parent_id, archived_at"),
        supabase.from("inventory_balances").select("item_id, qty_on_hand, avg_cost").eq("item_id", id).maybeSingle(),
        supabase
          .from("item_units")
          .select("id, item_id, unit_label, conversion_factor, price, is_base, barcode")
          .eq("item_id", id)
          .order("is_base", { ascending: false }),
        supabase.from("item_categories").select("id, name, archived_at").order("name"),
        supabase.from("item_brands").select("id, name, archived_at").order("name"),
        fetchDefaultAccounts(),
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
    setDefaultAccounts(resolvedDefaultAccounts);
  }, [id]);

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
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  if (!item) {
    return <FormError>{loadError ?? "Item gak ditemukan."}</FormError>;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");
  const inventoryAccount = getLeafAccounts(accounts).find((a) => a.id === item.inventory_account_id);
  const totalQty = balance?.qty_on_hand ?? 0;
  const totalValue = (balance?.qty_on_hand ?? 0) * (balance?.avg_cost ?? 0);
  const hasBaseUnit = units.some((u) => u.is_base);
  const category = categories.find((c) => c.id === item.category_id);
  const brand = brands.find((b) => b.id === item.brand_id);
  const activeCategories = categories.filter((c) => !c.archived_at);
  const activeBrands = brands.filter((b) => !b.archived_at);
  const editInventoryRoleKey = editItemType === "RAW_MATERIAL" ? "inventory.raw_material" : "inventory.finished_good";

  const detailGroups = [
    {
      title: "Informasi Item",
      rows: [
        { label: "Nama", value: item.name },
        {
          label: "Tipe",
          value: <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{item.item_type}</span>,
        },
        { label: "Satuan Dasar", value: item.uom },
        { label: "Kategori", value: category ? category.name : "-" },
        { label: "Brand", value: brand ? brand.name : "-" },
        {
          label: "Akun Persediaan",
          value: inventoryAccount ? `${inventoryAccount.code} — ${inventoryAccount.name}` : "-",
        },
        { label: "Status", value: item.archived_at ? "Diarsipkan" : "Aktif" },
      ],
    },
    {
      title: "Ringkasan Stok",
      rows: [
        { label: "Qty On Hand", value: formatStockBreakdown(totalQty, item.uom, units) },
        { label: "Avg Cost / " + item.uom, value: (balance?.avg_cost ?? 0).toLocaleString("id-ID") },
        { label: "Nilai Persediaan", value: totalValue.toLocaleString("id-ID") },
      ],
    },
  ];

  function openEditForm() {
    if (!item) return;
    setEditError(null);
    setEditName(item.name);
    setEditItemType(item.item_type);
    setEditUom(item.uom);
    setEditCategoryId(item.category_id ?? "");
    setEditBrandId(item.brand_id ?? "");
    setShowEditForm(true);
  }

  async function handleUpdate(e: FormEvent) {
    e.preventDefault();
    if (!item) return;
    setEditError(null);
    const parsed = updateItemSchema.safeParse({
      name: editName,
      item_type: editItemType,
      uom: editUom,
      inventory_account_id: defaultAccounts[editInventoryRoleKey]?.id ?? "",
      category_id: editCategoryId || null,
      brand_id: editBrandId || null,
    });
    if (!parsed.success) {
      setEditError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }
    setEditSubmitting(true);
    const { error } = await supabase.from("items").update(parsed.data).eq("id", item.id);
    setEditSubmitting(false);
    if (error) {
      setEditError(error.message);
      return;
    }
    setShowEditForm(false);
    await load();
  }

  function openUnitForm() {
    setUnitError(null);
    if (!item) return;
    if (!hasBaseUnit) {
      // Belum ada satuan dasar -- paksa baris pertama jadi satuan dasar, unit_label
      // dikunci sama items.uom (konvensi, ref memory/domain/inventory.md).
      setUnitIsBase(true);
      setUnitLabel(item.uom);
      setConversionFactor("1");
    } else {
      setUnitIsBase(false);
      setUnitLabel("");
      setConversionFactor("");
    }
    setUnitPrice("");
    setShowUnitForm(true);
  }

  async function handleAddUnit(e: FormEvent) {
    e.preventDefault();
    setUnitError(null);
    const parsed = createItemUnitSchema.safeParse({
      item_id: id,
      unit_label: unitLabel,
      conversion_factor: conversionFactor,
      price: unitPrice || undefined,
      is_base: unitIsBase,
    });
    if (!parsed.success) {
      setUnitError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }
    if (parsed.data.is_base && parsed.data.conversion_factor !== 1) {
      setUnitError("Satuan dasar wajib faktor konversi 1");
      return;
    }
    setUnitSubmitting(true);
    const { error } = await supabase.from("item_units").insert({
      item_id: parsed.data.item_id,
      unit_label: parsed.data.unit_label,
      conversion_factor: parsed.data.conversion_factor,
      price: parsed.data.price ?? null,
      is_base: parsed.data.is_base,
    });
    setUnitSubmitting(false);
    if (error) {
      setUnitError(error.message);
      return;
    }
    setShowUnitForm(false);
    await load();
  }

  async function handleDelete() {
    if (!item) return;
    if (!window.confirm(`Hapus item "${item.name}"?`)) return;
    setDeleteError(null);
    setDeleting(true);
    const { data, error } = await supabase.rpc("delete_item", { p_item_id: item.id });
    setDeleting(false);
    if (error) {
      setDeleteError(error.message);
      return;
    }
    if (data === "deleted") {
      router.push("/items");
      return;
    }
    window.alert('Item ini sudah pernah dipakai di transaksi, jadi diarsipkan (bukan dihapus permanen).');
    await load();
  }

  async function handleReactivate() {
    if (!item) return;
    setDeleteError(null);
    setDeleting(true);
    const { error } = await supabase.from("items").update({ archived_at: null }).eq("id", item.id);
    setDeleting(false);
    if (error) {
      setDeleteError(error.message);
      return;
    }
    await load();
  }

  async function handleDeleteUnit(unitId: string) {
    if (!window.confirm("Hapus satuan jual ini?")) return;
    const { error } = await supabase.from("item_units").delete().eq("id", unitId);
    if (error) {
      setLoadError(error.message);
      return;
    }
    await load();
  }

  async function handleGenerateBarcode(unitId: string) {
    const unit = units.find((u) => u.id === unitId);
    if (unit && unit.price == null) {
      setBarcodeError("Satuan ini belum punya harga — QR code cuma buat barang yang dijual.");
      return;
    }
    setBarcodeError(null);
    setGeneratingUnitId(unitId);
    let code: string;
    try {
      code = await generateDocumentNumber("item_unit_barcodes");
    } catch (err) {
      setGeneratingUnitId(null);
      setBarcodeError(err instanceof Error ? err.message : "Gagal generate kode");
      return;
    }
    const { error: updErr } = await supabase.from("item_units").update({ barcode: code }).eq("id", unitId);
    setGeneratingUnitId(null);
    if (updErr) {
      setBarcodeError(updErr.message);
      return;
    }
    await load();
  }

  // Print lewat window baru (bukan @media print di halaman ini) -- native <dialog>
  // (Modal) gak konsisten diprint lintas browser (Firefox sering skip isi dialog
  // sama sekali pas print), dan trik "visibility:hidden semua elemen lain" gampang
  // nyisain halaman kosong karena elemen yang disembunyiin tetap makan document
  // flow. Window terpisah = gak ada chrome/dialog yang perlu disembunyiin sama sekali.
  async function handlePrintLabel(u: ItemUnit) {
    if (!u.barcode || !item) return;
    setBarcodeError(null);
    setPrintingUnitId(u.id);
    try {
      const qrDataUrl = await QRCode.toDataURL(u.barcode, { width: 220, margin: 1 });
      const printWindow = window.open("", "_blank", "width=420,height=520");
      if (!printWindow) {
        setBarcodeError("Popup diblokir browser — izinkan popup buat halaman ini, lalu coba lagi.");
        return;
      }
      const priceLine =
        u.price != null
          ? `Rp${u.price.toLocaleString("id-ID")}/${escapeHtml(u.unit_label)}`
          : escapeHtml(u.unit_label);
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
  <img src="${qrDataUrl}" alt="QR ${escapeHtml(u.barcode)}" />
  <div class="name">${escapeHtml(item.name)}</div>
  <div class="meta">${priceLine}</div>
  <script>window.onload = function () { window.print(); };</script>
</body>
</html>`);
      printWindow.document.close();
    } catch (err) {
      setBarcodeError(err instanceof Error ? err.message : "Gagal siapin label buat print");
    } finally {
      setPrintingUnitId(null);
    }
  }

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/items" label="Kembali ke Items" />
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-black">Item Details</h1>
        {canWrite && (
          <div className="flex gap-2">
            <Button variant="toolbar" onClick={openEditForm}>
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
      {deleteError && <FormError>{deleteError}</FormError>}

      <p className="text-sm text-slate-500">
        Weighted Average gak nyimpen riwayat per-batch — cuma 1 angka rata-rata berjalan,
        dihitung ulang tiap ada penerimaan baru (ref <code>docs/domain/inventory.md</code>).
      </p>

      <DetailRows groups={detailGroups} />

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
            <Button variant="toolbar" onClick={openUnitForm}>
              + Tambah Satuan
            </Button>
          )}
        </div>
        {barcodeError && (
          <div className="px-4 pt-3">
            <FormError>{barcodeError}</FormError>
          </div>
        )}
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Satuan</th>
              <th className="px-4 py-2 text-right">Faktor Konversi</th>
              <th className="px-4 py-2 text-right">Harga</th>
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
                  {u.price != null ? u.price.toLocaleString("id-ID") : "-"}
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
                  ) : canWrite ? (
                    <button
                      type="button"
                      onClick={() => handleGenerateBarcode(u.id)}
                      disabled={generatingUnitId === u.id}
                      className="text-xs font-medium text-blue-600 underline hover:text-blue-700 disabled:opacity-50"
                    >
                      {generatingUnitId === u.id ? "Membuat..." : "Buat Kode"}
                    </button>
                  ) : (
                    <span className="text-xs text-slate-400">—</span>
                  )}
                </td>
                <td className="px-4 py-2 text-right">
                  {canWrite && (
                    <button
                      type="button"
                      onClick={() => handleDeleteUnit(u.id)}
                      className="text-slate-400 hover:text-red-600"
                      aria-label="Hapus satuan"
                    >
                      ✕
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {units.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-400">
                  Belum ada satuan jual — item ini belum bisa dipakai di Goods Issue.
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
                  movementPage.rows.reduce<(ItemMovement & { running: number })[]>((acc, m) => {
                    const prevRunning = acc.length > 0 ? acc[acc.length - 1].running : movementPage.openingBalance;
                    return [...acc, { ...m, running: prevRunning + m.qty }];
                  }, []).map((m) => (
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

      <Modal open={showUnitForm} onClose={() => setShowUnitForm(false)} title="Tambah Satuan Jual">
        <form onSubmit={handleAddUnit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="unit_label">Nama Satuan</Label>
            <Input
              id="unit_label"
              placeholder="mis. lusin"
              value={unitLabel}
              onChange={(e) => setUnitLabel(e.target.value)}
              disabled={unitIsBase}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="conversion_factor">
                Faktor Konversi (ke {item.uom})
              </Label>
              <Input
                id="conversion_factor"
                type="number"
                min="0"
                placeholder="mis. 12"
                value={conversionFactor}
                onChange={(e) => setConversionFactor(e.target.value)}
                disabled={unitIsBase}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="unit_price">Harga (opsional)</Label>
              <Input
                id="unit_price"
                type="number"
                min="0"
                placeholder="mis. 22000"
                value={unitPrice}
                onChange={(e) => setUnitPrice(e.target.value)}
              />
            </div>
          </div>
          <p className="text-xs text-slate-500">
            {unitIsBase
              ? "Ini jadi satuan dasar item — nama & faktor konversi dikunci (harus sama dengan satuan dasar di master data, faktor 1)."
              : "Faktor konversi = berapa satuan dasar sama dengan 1 satuan ini (mis. 1 lusin = 12 buah)."}
          </p>
          {unitError && <FormError>{unitError}</FormError>}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setShowUnitForm(false)}>
              Batal
            </Button>
            <Button type="submit" disabled={unitSubmitting}>
              {unitSubmitting ? "Menyimpan..." : "Simpan Satuan"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal open={showEditForm} onClose={() => setShowEditForm(false)} title="Edit Item">
        <form onSubmit={handleUpdate} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit_name">Nama</Label>
            <Input id="edit_name" value={editName} onChange={(e) => setEditName(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit_item_type">Tipe</Label>
              <Select
                id="edit_item_type"
                value={editItemType}
                onChange={(e) => setEditItemType(e.target.value as (typeof itemTypes)[number])}
              >
                {itemTypes.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit_uom">Satuan Dasar (UOM)</Label>
              <Input id="edit_uom" value={editUom} onChange={(e) => setEditUom(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit_category">Kategori (opsional)</Label>
              <Select id="edit_category" value={editCategoryId} onChange={(e) => setEditCategoryId(e.target.value)}>
                <option value="">Tanpa kategori</option>
                {activeCategories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit_brand">Brand (opsional)</Label>
              <Select id="edit_brand" value={editBrandId} onChange={(e) => setEditBrandId(e.target.value)}>
                <option value="">Tanpa brand</option>
                {activeBrands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <LockedAccountField
            label="Akun Persediaan"
            htmlFor="edit_inventory_account"
            resolved={defaultAccounts[editInventoryRoleKey]}
          />
          {editItemType !== item.item_type && (
            <p className="text-xs text-amber-600">
              ⚠ Ganti Tipe ngubah akun Persediaan yang kepakai (`inventory_account_id`) — transaksi lama yang
              udah kepakai akun sebelumnya gak berubah, cuma barang ini yang mulai pakai akun baru buat
              transaksi berikutnya.
            </p>
          )}
          {editUom !== item.uom && (
            <p className="text-xs text-amber-600">
              ⚠ Satuan dasar dipakai buat semua pelacakan stok (PO/GRN/BOM/Production/Goods Issue) — ganti
              ini gak mengonversi ulang riwayat transaksi, cuma label tampilan ke depannya.
            </p>
          )}
          {editError && <FormError>{editError}</FormError>}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setShowEditForm(false)}>
              Batal
            </Button>
            <Button type="submit" disabled={editSubmitting}>
              {editSubmitting ? "Menyimpan..." : "Simpan Perubahan"}
            </Button>
          </div>
        </form>
      </Modal>
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
