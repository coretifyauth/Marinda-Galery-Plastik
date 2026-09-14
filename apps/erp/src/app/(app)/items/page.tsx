"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { itemTypes } from "@/lib/items/schema";
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS, useItems } from "@/lib/items/queries";
import type { ItemUnit } from "@/lib/item-units/schema";
import { createItemCategorySchema, type ItemCategory } from "@/lib/item-categories/schema";
import { createItemBrandSchema, type ItemBrand } from "@/lib/item-brands/schema";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { Modal } from "@/components/ui/modal";
import { Tabs, type TabDef } from "@/components/ui/tabs";
import { Pagination } from "@/components/ui/pagination";
import { fetchDefaultAccounts, type ResolvedAccount } from "@/lib/default-accounts/schema";
import { LoadingScreen, InlineSpinner } from "@/components/ui/loading-screen";

// Input kecil buat baris filter di header tabel -- pola sama journal-entries/page.tsx.
const compactFilterInputClass =
  "w-full rounded border border-slate-200 bg-white px-1.5 py-1 text-xs font-normal normal-case text-slate-700 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-1 focus:ring-blue-600/40";

const itemTypeLabel: Record<string, string> = {
  RAW_MATERIAL: "Bahan Baku",
  FINISHED_GOOD: "Barang Jadi",
};

type ItemRef = { category_id: string | null; brand_id: string | null };

export default function ItemsPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [activeTab, setActiveTab] = useState("items");
  const [itemUnits, setItemUnits] = useState<ItemUnit[]>([]);
  const [categories, setCategories] = useState<ItemCategory[]>([]);
  const [brands, setBrands] = useState<ItemBrand[]>([]);
  // Lean, unpaginated list dipakai KHUSUS buat hitung "Jumlah Barang" di sub-tab
  // Kategori/Brand -- item table utama sekarang dipaginasi, jadi gak bisa lagi hitung dari
  // situ. Sub-tab kategori/brand sengaja gak disentuh (lihat catatan rollout), cuma sumber
  // datanya dipindah ke fetch kecil ini.
  const [itemRefs, setItemRefs] = useState<ItemRef[]>([]);
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [nameSearchInput, setNameSearchInput] = useState("");
  const [itemTypeFilter, setItemTypeFilter] = useState<"" | (typeof itemTypes)[number]>("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [brandFilter, setBrandFilter] = useState("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const debouncedNameSearch = useDebouncedValue(nameSearchInput, 300);

  const [categoryName, setCategoryName] = useState("");
  const [categoryFormError, setCategoryFormError] = useState<string | null>(null);
  const [categorySubmitting, setCategorySubmitting] = useState(false);
  const [showCategoryForm, setShowCategoryForm] = useState(false);

  const [brandName, setBrandName] = useState("");
  const [brandFormError, setBrandFormError] = useState<string | null>(null);
  const [brandSubmitting, setBrandSubmitting] = useState(false);
  const [showBrandForm, setShowBrandForm] = useState(false);

  // Filter berubah -> balik ke halaman 1 (pola "adjust state during render", lihat
  // journal-entries/page.tsx -- BUKAN useEffect, biar gak kena lint react-hooks/set-state-in-effect).
  const filterKey = `${debouncedNameSearch}|${itemTypeFilter}|${categoryFilter}|${brandFilter}|${pageSize}`;
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey);
  if (filterKey !== prevFilterKey) {
    setPrevFilterKey(filterKey);
    setPage(0);
  }

  const filters = {
    nameSearch: debouncedNameSearch,
    itemType: itemTypeFilter,
    categoryId: categoryFilter,
    brandId: brandFilter,
    page,
    pageSize,
  };
  const itemsQuery = useItems(filters);
  const items = itemsQuery.data?.rows ?? [];
  const total = itemsQuery.data?.total ?? 0;

  // item_units: keyed off item id, dipakai buat nampilin harga satuan jual per item di baris
  // tabel -- tetap fetch semua (gak difilter per-halaman), sama kayak sebelum rollout ini.
  const loadAux = useCallback(async () => {
    const [{ data: units }, { data: cats }, { data: brs }, { data: refs, error: refsError }] =
      await Promise.all([
        supabase.from("item_units").select("id, item_id, unit_label, conversion_factor, price, is_base"),
        supabase.from("item_categories").select("id, name, archived_at").order("name"),
        supabase.from("item_brands").select("id, name, archived_at").order("name"),
        supabase.from("items").select("category_id, brand_id"),
      ]);
    if (refsError) {
      setLoadError(refsError.message);
      return;
    }
    setLoadError(null);
    setItemUnits((units ?? []) as ItemUnit[]);
    setCategories((cats ?? []) as ItemCategory[]);
    setBrands((brs ?? []) as ItemBrand[]);
    setItemRefs((refs ?? []) as ItemRef[]);
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
        .from("app_user_roles")
        .select("role_name")
        .eq("user_id", session.user.id);
      if (!active) return;
      setRoles(((roleRows ?? []) as { role_name: string }[]).map((r) => r.role_name));
      await Promise.all([loadAux(), loadDefaultAccounts()]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadAux, loadDefaultAccounts]);

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
    await loadAux();
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
    await loadAux();
  }

  if (checkingSession) {
    return <LoadingScreen />;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");
  const canManageCatalog = roles.includes("admin");
  const activeCategories = categories.filter((c) => !c.archived_at);
  const activeBrands = brands.filter((b) => !b.archived_at);

  const tabs: TabDef[] = [
    { key: "items", label: "Item", badge: total },
    { key: "categories", label: "Kategori", badge: categories.length },
    { key: "brands", label: "Brand", badge: brands.length },
  ];

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">Item</h1>
        <p className="text-sm text-slate-500">
          Role kamu:{" "}
          {roles.length > 0 ? roles.join(", ") : "belum ada role — cuma bisa lihat"}
        </p>
      </div>

      {loadError && <FormError>{loadError}</FormError>}
      {itemsQuery.error && <FormError>{(itemsQuery.error as Error).message}</FormError>}

      <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} />

      {activeTab === "items" && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-black">Item</span>
              <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
                {total}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <Button variant="toolbar" onClick={() => itemsQuery.refetch()}>
                Muat Ulang
              </Button>
              {canWrite && (
                <Button variant="toolbar-primary" onClick={() => router.push("/items/new")}>
                  + Tambah
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
              <tr className="border-b border-slate-200 bg-slate-50/50">
                <th className="px-4 py-1.5">
                  <input
                    type="text"
                    placeholder="Cari nama..."
                    value={nameSearchInput}
                    onChange={(e) => setNameSearchInput(e.target.value)}
                    className={compactFilterInputClass}
                  />
                </th>
                <th className="px-4 py-1.5">
                  <select
                    aria-label="Filter tipe"
                    value={itemTypeFilter}
                    onChange={(e) => setItemTypeFilter(e.target.value as "" | (typeof itemTypes)[number])}
                    className={compactFilterInputClass}
                  >
                    <option value="">Semua Tipe</option>
                    {itemTypes.map((t) => (
                      <option key={t} value={t}>
                        {itemTypeLabel[t] ?? t}
                      </option>
                    ))}
                  </select>
                </th>
                <th className="px-4 py-1.5" />
                <th className="px-4 py-1.5" />
                <th className="px-4 py-1.5">
                  <select
                    aria-label="Filter kategori"
                    value={categoryFilter}
                    onChange={(e) => setCategoryFilter(e.target.value)}
                    className={compactFilterInputClass}
                  >
                    <option value="">Semua Kategori</option>
                    {activeCategories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </th>
                <th className="px-4 py-1.5">
                  <select
                    aria-label="Filter brand"
                    value={brandFilter}
                    onChange={(e) => setBrandFilter(e.target.value)}
                    className={compactFilterInputClass}
                  >
                    <option value="">Semua Brand</option>
                    {activeBrands.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </th>
                <th className="px-4 py-1.5" />
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
                        {itemTypeLabel[item.item_type] ?? item.item_type}
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
                    {itemsQuery.isLoading ? <InlineSpinner /> : "Belum ada item."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <Pagination
            page={page}
            pageSize={pageSize}
            total={total}
            onPageChange={setPage}
            pageSizeOptions={PAGE_SIZE_OPTIONS}
            onPageSizeChange={setPageSize}
          />
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
                + Tambah
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
                  <td className="px-4 py-2">{itemRefs.filter((i) => i.category_id === cat.id).length}</td>
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
                + Tambah
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
                  <td className="px-4 py-2">{itemRefs.filter((i) => i.brand_id === brand.id).length}</td>
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
