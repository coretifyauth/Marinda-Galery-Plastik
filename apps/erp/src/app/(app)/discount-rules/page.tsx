"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { itemDiscountRuleSchema, type ItemDiscountRule } from "@/lib/promotion-item-discount-rules/schema";
import type { Item } from "@/lib/items/schema";
import type { ItemCategory } from "@/lib/item-categories/schema";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { Modal } from "@/components/ui/modal";
import { LoadingScreen } from "@/components/ui/loading-screen";

type UnitOption = { id: string; unit_label: string; conversion_factor: number };

function ItemDiscountRulesManager({
  items,
  categories,
  canWrite,
}: {
  items: Item[];
  categories: ItemCategory[];
  canWrite: boolean;
}) {
  const [rows, setRows] = useState<
    (ItemDiscountRule & {
      created_at: string;
      created_by: string | null;
      items: { name: string } | null;
      item_categories: { name: string } | null;
      min_unit: { unit_label: string } | null;
    })[]
  >([]);
  // Syarat minimal qty (opsional, cuma aturan barang): satuan yang boleh dipilih = satuan jual
  // milik barang target.
  const [minQty, setMinQty] = useState("");
  const [minQtyUnitId, setMinQtyUnitId] = useState("");
  const [targetUnits, setTargetUnits] = useState<UnitOption[]>([]);
  const [name, setName] = useState("");
  const [targetType, setTargetType] = useState<"item" | "category">("item");
  const [targetId, setTargetId] = useState("");
  const [discountType, setDiscountType] = useState<"PERCENT" | "NOMINAL">("PERCENT");
  const [discountValue, setDiscountValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"active" | "archived" | "all">("active");

  const activeItems = items.filter((i) => !i.archived_at);
  const activeCategories = categories.filter((c) => !c.archived_at);
  const visibleRows = rows.filter((row) => {
    if (statusFilter === "active") return !row.archived_at;
    if (statusFilter === "archived") return !!row.archived_at;
    return true;
  });

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("promotion_item_discount_rules")
      .select(
        "id, name, item_id, category_id, discount_type, discount_value, archived_at, created_at, created_by, min_qty, min_qty_unit_id, min_qty_base, items(name), item_categories(name), min_unit:item_units!promotion_item_discount_rules_min_qty_unit_id_fkey(unit_label)"
      )
      .order("name");
    setRows((data ?? []) as unknown as typeof rows);
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      if (active) await load();
    })();
    return () => {
      active = false;
    };
  }, [load]);

  // Pilih barang target -> muat satuan jualnya (buat pilihan satuan syarat minimal) dan reset syarat.
  async function handleTargetChange(id: string) {
    setTargetId(id);
    setMinQty("");
    setMinQtyUnitId("");
    setTargetUnits([]);
    if (targetType !== "item" || !id) return;
    const { data } = await supabase
      .from("item_units")
      .select("id, unit_label, conversion_factor")
      .eq("item_id", id)
      .order("conversion_factor");
    setTargetUnits((data ?? []) as UnitOption[]);
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const hasMinQty = targetType === "item" && minQty.trim() !== "";
    const parsed = itemDiscountRuleSchema.safeParse({
      name,
      item_id: targetType === "item" ? targetId : null,
      category_id: targetType === "category" ? targetId : null,
      discount_type: discountType,
      discount_value: discountValue,
      min_qty: hasMinQty ? minQty : null,
      min_qty_unit_id: hasMinQty ? minQtyUnitId || null : null,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }
    if (!targetId) {
      setError(targetType === "item" ? "Pilih barang" : "Pilih kategori");
      return;
    }
    setSubmitting(true);
    const { error: err } = await supabase.from("promotion_item_discount_rules").insert(parsed.data);
    setSubmitting(false);
    if (err) {
      // 23505 = unique violation: sudah ada aturan aktif dengan target & syarat minimal yang sama.
      setError(
        err.code === "23505"
          ? "Sudah ada aturan aktif untuk barang/kategori ini dengan syarat minimal yang sama — nonaktifkan yang lama dulu, atau pakai syarat minimal yang beda (bertingkat)."
          : err.message
      );
      return;
    }
    setName("");
    setTargetId("");
    setDiscountValue("");
    setMinQty("");
    setMinQtyUnitId("");
    setTargetUnits([]);
    setShowForm(false);
    await load();
  }

  async function toggleArchive(row: ItemDiscountRule) {
    await supabase
      .from("promotion_item_discount_rules")
      .update({ archived_at: row.archived_at ? null : new Date().toISOString() })
      .eq("id", row.id);
    await load();
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="font-semibold text-black">Aturan Diskon Barang</h2>
        {canWrite && (
          <Button variant="toolbar-primary" onClick={() => setShowForm(true)}>
            + Tambah
          </Button>
        )}
      </div>
      <p className="mb-3 text-sm text-slate-500">
        Trade discount sisi penjualan — otomatis dicocokkan sistem saat Sales Order/Jual Barang
        Langsung/kasir (staf gak pilih manual). Aturan barang boleh punya syarat minimal qty
        (mis. ≥10 dos) dan bertingkat: beberapa aturan aktif dengan syarat berbeda, yang dipakai
        cuma satu tingkat tertinggi yang terpenuhi, berlaku ke seluruh qty. Qty dijumlah lintas
        baris/satuan. Maksimal 1 aturan aktif per kategori (tanpa syarat). Kalau aturan barang
        belum terpenuhi, sistem jatuh ke aturan kategorinya.
      </p>
      <div className="mb-3 flex items-center gap-2">
        <Label htmlFor="discount-status-filter" className="text-xs">
          Status
        </Label>
        <div className="w-40">
          <Select
            id="discount-status-filter"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as "active" | "archived" | "all")}
          >
            <option value="active">Aktif</option>
            <option value="archived">Nonaktif</option>
            <option value="all">Semua</option>
          </Select>
        </div>
      </div>
      <table className="mb-3 w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs font-medium uppercase text-slate-500">
            <th className="py-1.5">Nama</th>
            <th className="py-1.5">Target</th>
            <th className="py-1.5">Syarat Minimal</th>
            <th className="py-1.5">Diskon</th>
            <th className="py-1.5">Status</th>
            <th className="py-1.5">Dibuat</th>
            <th className="py-1.5">Dibuat Oleh</th>
            {canWrite && <th className="py-1.5" />}
          </tr>
        </thead>
        <tbody>
          {visibleRows.map((row) => (
            <tr key={row.id} className="border-b border-slate-100">
              <td className="py-1.5">{row.name}</td>
              <td className="py-1.5">
                {row.items ? `Barang: ${row.items.name}` : `Kategori: ${row.item_categories?.name ?? "-"}`}
              </td>
              <td className="py-1.5 text-slate-600">
                {row.min_qty != null && row.min_unit
                  ? `≥ ${row.min_qty.toLocaleString("id-ID")} ${row.min_unit.unit_label}`
                  : "—"}
              </td>
              <td className="py-1.5">
                {row.discount_type === "PERCENT" ? `${row.discount_value}%` : `Rp${row.discount_value.toLocaleString("id-ID")}/unit`}
              </td>
              <td className="py-1.5">
                <span
                  className={`rounded-full px-2 py-0.5 text-xs ${
                    row.archived_at ? "bg-slate-100 text-slate-400" : "bg-emerald-50 text-emerald-700"
                  }`}
                >
                  {row.archived_at ? "Nonaktif" : "Aktif"}
                </span>
              </td>
              <td className="py-1.5 text-slate-500">{new Date(row.created_at).toLocaleDateString("id-ID")}</td>
              <td className="py-1.5 text-slate-500">{row.created_by ?? "-"}</td>
              {canWrite && (
                <td className="py-1.5 text-right">
                  <Button type="button" variant="toolbar" onClick={() => toggleArchive(row)}>
                    {row.archived_at ? "Aktifkan" : "Nonaktifkan"}
                  </Button>
                </td>
              )}
            </tr>
          ))}
          {visibleRows.length === 0 && (
            <tr>
              <td colSpan={8} className="py-3 text-center text-slate-400">
                Belum ada aturan diskon.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {canWrite && (
        <Modal open={showForm} onClose={() => setShowForm(false)} title="Aturan Diskon Barang">
          <form onSubmit={handleCreate} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="discount-name">Nama Aturan</Label>
              <Input
                id="discount-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="mis. Promo Kopi Robusta 10%"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="discount-target-type">Berlaku Untuk</Label>
              <Select
                id="discount-target-type"
                value={targetType}
                onChange={(e) => {
                  setTargetType(e.target.value as "item" | "category");
                  setTargetId("");
                  setMinQty("");
                  setMinQtyUnitId("");
                  setTargetUnits([]);
                }}
              >
                <option value="item">Barang tertentu</option>
                <option value="category">Kategori barang</option>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="discount-target">{targetType === "item" ? "Barang" : "Kategori"}</Label>
              <Select id="discount-target" value={targetId} onChange={(e) => handleTargetChange(e.target.value)}>
                <option value="">Pilih...</option>
                {(targetType === "item" ? activeItems : activeCategories).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="discount-type">Tipe</Label>
                <Select
                  id="discount-type"
                  value={discountType}
                  onChange={(e) => setDiscountType(e.target.value as "PERCENT" | "NOMINAL")}
                >
                  <option value="PERCENT">Persen (%)</option>
                  <option value="NOMINAL">Nominal (Rp/unit)</option>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="discount-value">Nilai</Label>
                <Input
                  id="discount-value"
                  type="number"
                  min="0"
                  step="any"
                  value={discountValue}
                  onChange={(e) => setDiscountValue(e.target.value)}
                  placeholder={discountType === "PERCENT" ? "mis. 10" : "mis. 2000"}
                />
              </div>
            </div>
            {targetType === "item" && targetId && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="discount-min-qty">Syarat Minimal Qty (opsional)</Label>
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    id="discount-min-qty"
                    type="number"
                    min="0"
                    step="any"
                    value={minQty}
                    onChange={(e) => setMinQty(e.target.value)}
                    placeholder="mis. 10"
                  />
                  <Select
                    aria-label="Satuan syarat minimal"
                    value={minQtyUnitId}
                    onChange={(e) => setMinQtyUnitId(e.target.value)}
                  >
                    <option value="">Satuan...</option>
                    {targetUnits.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.unit_label} (×{u.conversion_factor})
                      </option>
                    ))}
                  </Select>
                </div>
                <p className="text-xs text-slate-500">
                  Kosongkan kalau diskon berlaku dari unit pertama. Qty dijumlah lintas baris dan satuan
                  (dalam satuan dasar); begitu terpenuhi, diskon berlaku ke seluruh qty. Buat beberapa
                  aturan dengan syarat berbeda untuk diskon bertingkat. Satuan yang dipilih tidak bisa
                  diubah faktor konversinya lagi.
                </p>
              </div>
            )}
            {error && <FormError>{error}</FormError>}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="secondary" onClick={() => setShowForm(false)}>
                Batal
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? "..." : "+ Tambah"}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

export default function DiscountRulesPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [items, setItems] = useState<Item[]>([]);
  const [itemCategories, setItemCategories] = useState<ItemCategory[]>([]);
  const [roles, setRoles] = useState<string[]>([]);

  const loadItemsAndCategories = useCallback(async () => {
    const [{ data: itemRows }, { data: catRows }] = await Promise.all([
      supabase.from("items").select("id, name, item_type, uom, inventory_account_id, category_id, brand_id, archived_at").order("name"),
      supabase.from("item_categories").select("id, name, archived_at").order("name"),
    ]);
    setItems((itemRows ?? []) as Item[]);
    setItemCategories((catRows ?? []) as ItemCategory[]);
  }, []);

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
      await loadItemsAndCategories();
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadItemsAndCategories]);

  if (checkingSession) {
    return <LoadingScreen />;
  }

  const canWrite = roles.includes("admin");

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">Aturan Diskon</h1>
        <p className="text-sm text-slate-500">
          Trade discount barang/kategori, otomatis dicocokkan sistem saat transaksi penjualan dibuat.{" "}
          {!canWrite && "Cuma role admin yang bisa ubah — kamu cuma bisa lihat."}
        </p>
      </div>
      <ItemDiscountRulesManager items={items} categories={itemCategories} canWrite={canWrite} />
    </div>
  );
}
