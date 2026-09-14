"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { itemTypes, updateItemSchema, type Item } from "@/lib/items/schema";
import type { ItemCategory } from "@/lib/item-categories/schema";
import type { ItemBrand } from "@/lib/item-brands/schema";
import { fetchDefaultAccounts, type ResolvedAccount } from "@/lib/default-accounts/schema";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { LockedAccountField } from "@/components/ui/locked-account-field";
import { JournalPreviewPanel } from "@/components/ui/journal-preview-panel";
import { LoadingScreen } from "@/components/ui/loading-screen";

const itemTypeLabel: Record<string, string> = {
  RAW_MATERIAL: "Bahan Baku",
  FINISHED_GOOD: "Barang Jadi",
};

export default function EditItemPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [item, setItem] = useState<Item | null>(null);
  const [categories, setCategories] = useState<ItemCategory[]>([]);
  const [brands, setBrands] = useState<ItemBrand[]>([]);
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [editName, setEditName] = useState("");
  const [editItemType, setEditItemType] = useState<(typeof itemTypes)[number]>("RAW_MATERIAL");
  const [editUom, setEditUom] = useState("");
  const [editCategoryId, setEditCategoryId] = useState("");
  const [editBrandId, setEditBrandId] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [editSubmitting, setEditSubmitting] = useState(false);

  const load = useCallback(async () => {
    const [{ data: it, error: itErr }, { data: cats }, { data: brs }, resolvedDefaultAccounts] = await Promise.all([
      supabase
        .from("items")
        .select("id, name, item_type, uom, inventory_account_id, category_id, brand_id, archived_at")
        .eq("id", id)
        .single(),
      supabase.from("item_categories").select("id, name, archived_at").order("name"),
      supabase.from("item_brands").select("id, name, archived_at").order("name"),
      fetchDefaultAccounts(),
    ]);
    if (itErr) {
      setLoadError(itErr.message);
      return;
    }
    setLoadError(null);
    const typedItem = it as Item;
    setItem(typedItem);
    setCategories((cats ?? []) as ItemCategory[]);
    setBrands((brs ?? []) as ItemBrand[]);
    setDefaultAccounts(resolvedDefaultAccounts);
    setEditName(typedItem.name);
    setEditItemType(typedItem.item_type);
    setEditUom(typedItem.uom);
    setEditCategoryId(typedItem.category_id ?? "");
    setEditBrandId(typedItem.brand_id ?? "");
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

  const editInventoryRoleKey = editItemType === "RAW_MATERIAL" ? "inventory.raw_material" : "inventory.finished_good";

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
    router.push(`/items/${item.id}`);
  }

  if (checkingSession) {
    return <LoadingScreen />;
  }

  if (!item) {
    return <FormError>{loadError ?? "Item gak ditemukan."}</FormError>;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");
  const activeCategories = categories.filter((c) => !c.archived_at);
  const activeBrands = brands.filter((b) => !b.archived_at);

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href={`/items/${item.id}`} label="Kembali ke Detail Item" />

      <div>
        <h1 className="text-xl font-semibold text-black">Edit Item</h1>
        <p className="text-sm text-slate-500">Ubah data master item {item.name}.</p>
      </div>

      {!canWrite && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-700">
          Kamu belum punya role admin/accountant — submit di bawah kemungkinan bakal ketolak RLS.
        </p>
      )}

      <form onSubmit={handleUpdate} className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-5">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="edit_name">Nama</Label>
                <Input id="edit_name" autoFocus value={editName} onChange={(e) => setEditName(e.target.value)} />
              </div>
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="edit_item_type">Tipe</Label>
                  <Select
                    id="edit_item_type"
                    value={editItemType}
                    onChange={(e) => setEditItemType(e.target.value as (typeof itemTypes)[number])}
                  >
                    {itemTypes.map((t) => (
                      <option key={t} value={t}>
                        {itemTypeLabel[t] ?? t}
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
                  ⚠ Ganti Tipe ngubah akun Persediaan yang kepakai (`inventory_account_id`) — transaksi lama
                  yang udah kepakai akun sebelumnya gak berubah, cuma barang ini yang mulai pakai akun baru
                  buat transaksi berikutnya.
                </p>
              )}
              {editUom !== item.uom && (
                <p className="text-xs text-amber-600">
                  ⚠ Satuan dasar dipakai buat semua pelacakan stok (PO/GRN/BOM/Production/Barang Keluar) —
                  ganti ini gak mengonversi ulang riwayat transaksi, cuma label tampilan ke depannya.
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4 lg:sticky lg:top-4 lg:col-span-1 lg:self-start">
          <JournalPreviewPanel
            groups={[[{ label: "Akun Persediaan", resolved: defaultAccounts[editInventoryRoleKey] }]]}
          />

          {editError && <FormError>{editError}</FormError>}

          <div className="flex flex-col gap-2">
            <Button type="submit" disabled={editSubmitting}>
              {editSubmitting ? "Menyimpan..." : "Simpan Perubahan"}
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
