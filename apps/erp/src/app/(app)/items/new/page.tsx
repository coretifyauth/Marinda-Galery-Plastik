"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import { createItemSchema, itemTypes, type CreateItemInput } from "@/lib/items/schema";
import type { ItemCategory } from "@/lib/item-categories/schema";
import type { ItemBrand } from "@/lib/item-brands/schema";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { LockedAccountField } from "@/components/ui/locked-account-field";
import { JournalPreviewPanel } from "@/components/ui/journal-preview-panel";
import { fetchDefaultAccounts, type ResolvedAccount } from "@/lib/default-accounts/schema";
import { LoadingScreen } from "@/components/ui/loading-screen";

const itemTypeLabel: Record<string, string> = {
  RAW_MATERIAL: "Bahan Baku",
  FINISHED_GOOD: "Barang Jadi",
};

export default function NewItemPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [checkingSession, setCheckingSession] = useState(true);
  const [roles, setRoles] = useState<string[]>([]);
  const [categories, setCategories] = useState<ItemCategory[]>([]);
  const [brands, setBrands] = useState<ItemBrand[]>([]);
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});

  const [name, setName] = useState("");
  const [itemType, setItemType] = useState<(typeof itemTypes)[number]>("RAW_MATERIAL");
  const [uom, setUom] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [brandId, setBrandId] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const inventoryRoleKey = itemType === "RAW_MATERIAL" ? "inventory.raw_material" : "inventory.finished_good";

  const loadAux = useCallback(async () => {
    const [{ data: cats }, { data: brs }] = await Promise.all([
      supabase.from("item_categories").select("id, name, archived_at").order("name"),
      supabase.from("item_brands").select("id, name, archived_at").order("name"),
    ]);
    setCategories((cats ?? []) as ItemCategory[]);
    setBrands((brs ?? []) as ItemBrand[]);
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
      await Promise.all([loadAux(), fetchDefaultAccounts().then(setDefaultAccounts)]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadAux]);

  const createItemMutation = useMutation({
    mutationFn: async (input: CreateItemInput) => {
      const { error } = await supabase.from("items").insert(input);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["items"] });
      router.push("/items");
    },
    onError: (err) => {
      setFormError(err instanceof Error ? err.message : "Gagal menyimpan item");
    },
  });

  function handleCreate(e: FormEvent) {
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
    createItemMutation.mutate(parsed.data);
  }

  if (checkingSession) {
    return <LoadingScreen />;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");
  const activeCategories = categories.filter((c) => !c.archived_at);
  const activeBrands = brands.filter((b) => !b.archived_at);

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/items" label="Kembali ke Item" />

      <div>
        <h1 className="text-xl font-semibold text-black">Tambah Item</h1>
        <p className="text-sm text-slate-500">
          Master data barang baru — bahan baku atau barang jadi, dipakai di transaksi persediaan.
        </p>
      </div>

      {!canWrite && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-700">
          Kamu belum punya role admin/accountant — submit di bawah kemungkinan bakal ketolak RLS.
        </p>
      )}

      <form onSubmit={handleCreate} className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-5">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="name">Nama</Label>
                <Input
                  id="name"
                  autoFocus
                  placeholder="mis. Tepung Terigu"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="item_type">Tipe</Label>
                  <Select
                    id="item_type"
                    value={itemType}
                    onChange={(e) => setItemType(e.target.value as (typeof itemTypes)[number])}
                  >
                    {itemTypes.map((t) => (
                      <option key={t} value={t}>
                        {itemTypeLabel[t] ?? t}
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
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4 lg:sticky lg:top-4 lg:col-span-1 lg:self-start">
          <JournalPreviewPanel
            groups={[[{ label: "Akun Persediaan", resolved: defaultAccounts[inventoryRoleKey] }]]}
          />

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-6">
            <p className="text-sm text-slate-600">
              Satuan jual & harga (bisa lebih dari 1, misal per buah dan per lusin) dikelola di
              halaman detail item — setelah item ini disimpan.
            </p>
          </div>

          {formError && <FormError>{formError}</FormError>}

          <div className="flex flex-col gap-2">
            <Button type="submit" disabled={createItemMutation.isPending}>
              {createItemMutation.isPending ? "Menyimpan..." : "Simpan Item"}
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
