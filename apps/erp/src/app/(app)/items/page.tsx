"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { createItemSchema, itemTypes, type Item } from "@/lib/items/schema";
import type { ItemUnit } from "@/lib/item-units/schema";
import { createItemCategorySchema, type ItemCategory } from "@/lib/item-categories/schema";
import { createItemBrandSchema, type ItemBrand } from "@/lib/item-brands/schema";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { Modal } from "@/components/ui/modal";
import { LockedAccountField } from "@/components/ui/locked-account-field";
import { JournalPreviewPanel } from "@/components/ui/journal-preview-panel";
import { Tabs, type TabDef } from "@/components/ui/tabs";
import { fetchDefaultAccounts, type ResolvedAccount } from "@/lib/default-accounts/schema";

export default function ItemsPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [activeTab, setActiveTab] = useState("items");
  const [items, setItems] = useState<Item[]>([]);
  const [itemUnits, setItemUnits] = useState<ItemUnit[]>([]);
  const [categories, setCategories] = useState<ItemCategory[]>([]);
  const [brands, setBrands] = useState<ItemBrand[]>([]);
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [itemType, setItemType] = useState<(typeof itemTypes)[number]>("RAW_MATERIAL");
  const [uom, setUom] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [brandId, setBrandId] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const [categoryName, setCategoryName] = useState("");
  const [categoryFormError, setCategoryFormError] = useState<string | null>(null);
  const [categorySubmitting, setCategorySubmitting] = useState(false);
  const [showCategoryForm, setShowCategoryForm] = useState(false);

  const [brandName, setBrandName] = useState("");
  const [brandFormError, setBrandFormError] = useState<string | null>(null);
  const [brandSubmitting, setBrandSubmitting] = useState(false);
  const [showBrandForm, setShowBrandForm] = useState(false);

  const inventoryRoleKey = itemType === "RAW_MATERIAL" ? "inventory.raw_material" : "inventory.finished_good";

  const loadItems = useCallback(async () => {
    const [{ data, error }, { data: units }, { data: cats }, { data: brs }] = await Promise.all([
      supabase
        .from("items")
        .select("id, name, item_type, uom, inventory_account_id, category_id, brand_id, archived_at")
        .order("name"),
      supabase.from("item_units").select("id, item_id, unit_label, conversion_factor, price, is_base"),
      supabase.from("item_categories").select("id, name, archived_at").order("name"),
      supabase.from("item_brands").select("id, name, archived_at").order("name"),
    ]);
    if (error) {
      setLoadError(error.message);
      return;
    }
    setLoadError(null);
    setItems((data ?? []) as Item[]);
    setItemUnits((units ?? []) as ItemUnit[]);
    setCategories((cats ?? []) as ItemCategory[]);
    setBrands((brs ?? []) as ItemBrand[]);
  }, []);

  const loadDefaultAccounts = useCallback(async () => {
    setDefaultAccounts(await fetchDefaultAccounts());
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
      await Promise.all([loadItems(), loadDefaultAccounts()]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadItems, loadDefaultAccounts]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = createItemSchema.safeParse({
      name,
      item_type: itemType,
      uom,
      inventory_account_id: defaultAccounts[inventoryRoleKey]?.id ?? "",
      category_id: categoryId || null,
      brand_id: brandId || null,
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }
    setSubmitting(true);
    const { error } = await supabase.from("items").insert(parsed.data);
    setSubmitting(false);
    if (error) {
      setFormError(error.message);
      return;
    }
    setName("");
    setItemType("RAW_MATERIAL");
    setUom("");
    setCategoryId("");
    setBrandId("");
    setShowForm(false);
    await loadItems();
  }

  async function handleCreateCategory(e: FormEvent) {
    e.preventDefault();
    setCategoryFormError(null);
    const parsed = createItemCategorySchema.safeParse({ name: categoryName });
    if (!parsed.success) {
      setCategoryFormError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }
    setCategorySubmitting(true);
    const { error } = await supabase.from("item_categories").insert(parsed.data);
    setCategorySubmitting(false);
    if (error) {
      setCategoryFormError(error.message);
      return;
    }
    setCategoryName("");
    setShowCategoryForm(false);
    await loadItems();
  }

  async function handleCreateBrand(e: FormEvent) {
    e.preventDefault();
    setBrandFormError(null);
    const parsed = createItemBrandSchema.safeParse({ name: brandName });
    if (!parsed.success) {
      setBrandFormError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }
    setBrandSubmitting(true);
    const { error } = await supabase.from("item_brands").insert(parsed.data);
    setBrandSubmitting(false);
    if (error) {
      setBrandFormError(error.message);
      return;
    }
    setBrandName("");
    setShowBrandForm(false);
    await loadItems();
  }

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");
  const canManageCatalog = roles.includes("admin");
  const activeCategories = categories.filter((c) => !c.archived_at);
  const activeBrands = brands.filter((b) => !b.archived_at);

  const tabs: TabDef[] = [
    { key: "items", label: "Items", badge: items.length },
    { key: "categories", label: "Kategori", badge: categories.length },
    { key: "brands", label: "Brand", badge: brands.length },
  ];

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">Items</h1>
        <p className="text-sm text-slate-500">
          Role kamu:{" "}
          {roles.length > 0 ? roles.join(", ") : "belum ada role — cuma bisa lihat"}
        </p>
      </div>

      {loadError && <FormError>{loadError}</FormError>}

      <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} />

      {activeTab === "items" && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-black">Items</span>
              <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
                {items.length}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <Button variant="toolbar" onClick={() => loadItems()}>
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
                <th className="px-4 py-2">Nama</th>
                <th className="px-4 py-2">Tipe</th>
                <th className="px-4 py-2">Satuan Dasar</th>
                <th className="px-4 py-2">Satuan Jual</th>
                <th className="px-4 py-2">Kategori</th>
                <th className="px-4 py-2">Brand</th>
                <th className="px-4 py-2">Akun Persediaan</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const account = Object.values(defaultAccounts).find((a) => a.id === item.inventory_account_id);
                const units = itemUnits.filter((u) => u.item_id === item.id);
                const category = categories.find((c) => c.id === item.category_id);
                const brand = brands.find((b) => b.id === item.brand_id);
                return (
                  <tr
                    key={item.id}
                    className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                    onClick={() => router.push(`/items/${item.id}`)}
                  >
                    <td className="px-4 py-2 font-medium text-black">{item.name}</td>
                    <td className="px-4 py-2">
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                        {item.item_type}
                      </span>
                    </td>
                    <td className="px-4 py-2">{item.uom}</td>
                    <td className="px-4 py-2">
                      {units.length > 0
                        ? units
                            .map((u) => `${u.unit_label}${u.price != null ? ` (${u.price.toLocaleString("id-ID")})` : ""}`)
                            .join(", ")
                        : "-"}
                    </td>
                    <td className="px-4 py-2">{category ? category.name : "-"}</td>
                    <td className="px-4 py-2">{brand ? brand.name : "-"}</td>
                    <td className="px-4 py-2">{account ? `${account.code} — ${account.name}` : "-"}</td>
                  </tr>
                );
              })}
              {items.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-slate-400">
                    Belum ada item.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === "categories" && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-black">Kategori Barang</span>
              <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
                {categories.length}
              </span>
            </div>
            {canManageCatalog && (
              <Button variant="toolbar-primary" onClick={() => setShowCategoryForm(true)}>
                + New
              </Button>
            )}
          </div>
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
                <th className="px-4 py-2">Nama</th>
                <th className="px-4 py-2">Jumlah Barang</th>
                <th className="px-4 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {categories.map((cat) => (
                <tr
                  key={cat.id}
                  className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                  onClick={() => router.push(`/item-categories/${cat.id}`)}
                >
                  <td className="px-4 py-2 font-medium text-black">{cat.name}</td>
                  <td className="px-4 py-2">{items.filter((i) => i.category_id === cat.id).length}</td>
                  <td className="px-4 py-2">
                    {cat.archived_at ? (
                      <span className="text-xs text-slate-400">Dinonaktifkan</span>
                    ) : (
                      <span className="text-xs text-emerald-600">Aktif</span>
                    )}
                  </td>
                </tr>
              ))}
              {categories.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-6 text-center text-slate-400">
                    Belum ada kategori.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === "brands" && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-black">Brand Barang</span>
              <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
                {brands.length}
              </span>
            </div>
            {canManageCatalog && (
              <Button variant="toolbar-primary" onClick={() => setShowBrandForm(true)}>
                + New
              </Button>
            )}
          </div>
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
                <th className="px-4 py-2">Nama</th>
                <th className="px-4 py-2">Jumlah Barang</th>
                <th className="px-4 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {brands.map((brand) => (
                <tr
                  key={brand.id}
                  className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                  onClick={() => router.push(`/item-brands/${brand.id}`)}
                >
                  <td className="px-4 py-2 font-medium text-black">{brand.name}</td>
                  <td className="px-4 py-2">{items.filter((i) => i.brand_id === brand.id).length}</td>
                  <td className="px-4 py-2">
                    {brand.archived_at ? (
                      <span className="text-xs text-slate-400">Dinonaktifkan</span>
                    ) : (
                      <span className="text-xs text-emerald-600">Aktif</span>
                    )}
                  </td>
                </tr>
              ))}
              {brands.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-6 text-center text-slate-400">
                    Belum ada brand.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={showForm} onClose={() => setShowForm(false)} title="Tambah Item">
        {!canWrite && (
          <p className="mb-4 text-sm text-amber-600">
            Kamu belum punya role admin/accountant — submit di bawah kemungkinan bakal
            ketolak RLS.
          </p>
        )}
        <p className="mb-4 text-sm text-slate-500">
          Satuan jual & harga (bisa lebih dari 1, misal per buah dan per lusin) dikelola di
          halaman detail item — setelah item ini disimpan.
        </p>
        <JournalPreviewPanel
          groups={[[{ label: "Akun Persediaan", resolved: defaultAccounts[inventoryRoleKey] }]]}
        />
        <form onSubmit={handleCreate} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">Nama</Label>
            <Input
              id="name"
              placeholder="mis. Tepung Terigu"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="item_type">Tipe</Label>
              <Select
                id="item_type"
                value={itemType}
                onChange={(e) => setItemType(e.target.value as (typeof itemTypes)[number])}
              >
                {itemTypes.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="uom">Satuan Dasar (UOM)</Label>
              <Input
                id="uom"
                placeholder="mis. kg, buah"
                value={uom}
                onChange={(e) => setUom(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="category">Kategori (opsional)</Label>
              <Select id="category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">Tanpa kategori</option>
                {activeCategories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="brand">Brand (opsional)</Label>
              <Select id="brand" value={brandId} onChange={(e) => setBrandId(e.target.value)}>
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
            htmlFor="inventory_account"
            resolved={defaultAccounts[inventoryRoleKey]}
          />

          {formError && <FormError>{formError}</FormError>}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setShowForm(false)}>
              Batal
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Menyimpan..." : "Simpan Item"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal open={showCategoryForm} onClose={() => setShowCategoryForm(false)} title="Tambah Kategori">
        <form onSubmit={handleCreateCategory} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="category_name">Nama Kategori</Label>
            <Input
              id="category_name"
              placeholder="mis. Alat Makan"
              value={categoryName}
              onChange={(e) => setCategoryName(e.target.value)}
            />
          </div>
          {categoryFormError && <FormError>{categoryFormError}</FormError>}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setShowCategoryForm(false)}>
              Batal
            </Button>
            <Button type="submit" disabled={categorySubmitting}>
              {categorySubmitting ? "Menyimpan..." : "Simpan Kategori"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal open={showBrandForm} onClose={() => setShowBrandForm(false)} title="Tambah Brand">
        <form onSubmit={handleCreateBrand} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="brand_name">Nama Brand</Label>
            <Input
              id="brand_name"
              placeholder="mis. Lion Star"
              value={brandName}
              onChange={(e) => setBrandName(e.target.value)}
            />
          </div>
          {brandFormError && <FormError>{brandFormError}</FormError>}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setShowBrandForm(false)}>
              Batal
            </Button>
            <Button type="submit" disabled={brandSubmitting}>
              {brandSubmitting ? "Menyimpan..." : "Simpan Brand"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
