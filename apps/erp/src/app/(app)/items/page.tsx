"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { getLeafAccounts, type Account } from "@/lib/accounts/schema";
import { createItemSchema, itemTypes, type Item } from "@/lib/items/schema";
import type { ItemUnit } from "@/lib/item-units/schema";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";

export default function ItemsPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [items, setItems] = useState<Item[]>([]);
  const [itemUnits, setItemUnits] = useState<ItemUnit[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [itemType, setItemType] = useState<(typeof itemTypes)[number]>("RAW_MATERIAL");
  const [uom, setUom] = useState("");
  const [inventoryAccountId, setInventoryAccountId] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const leafAccounts = getLeafAccounts(accounts);

  const loadItems = useCallback(async () => {
    const [{ data, error }, { data: units }] = await Promise.all([
      supabase
        .from("items")
        .select("id, name, item_type, uom, inventory_account_id, archived_at")
        .order("name"),
      supabase.from("item_units").select("id, item_id, unit_label, conversion_factor, price, is_base"),
    ]);
    if (error) {
      setLoadError(error.message);
      return;
    }
    setLoadError(null);
    setItems((data ?? []) as Item[]);
    setItemUnits((units ?? []) as ItemUnit[]);
  }, []);

  const loadAccounts = useCallback(async () => {
    const { data } = await supabase
      .from("accounts")
      .select("id, code, name, category, normal_balance, parent_id, archived_at")
      .order("code");
    setAccounts((data ?? []) as Account[]);
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
      await Promise.all([loadItems(), loadAccounts()]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadItems, loadAccounts]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = createItemSchema.safeParse({
      name,
      item_type: itemType,
      uom,
      inventory_account_id: inventoryAccountId,
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
    setInventoryAccountId("");
    setShowForm(false);
    await loadItems();
  }

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");

  return (
    <div className="flex w-full max-w-4xl flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">Items — CV Roti Barokah</h1>
        <p className="text-sm text-slate-500">
          Role kamu:{" "}
          {roles.length > 0 ? roles.join(", ") : "belum ada role — cuma bisa lihat"}
        </p>
      </div>

      {loadError && <FormError>{loadError}</FormError>}

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
              <Button variant="toolbar-primary" onClick={() => setShowForm((v) => !v)}>
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
              <th className="px-4 py-2">Akun Persediaan</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const account = accounts.find((a) => a.id === item.inventory_account_id);
              const units = itemUnits.filter((u) => u.item_id === item.id);
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
                  <td className="px-4 py-2">{account ? `${account.code} — ${account.name}` : "-"}</td>
                </tr>
              );
            })}
            {items.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-400">
                  Belum ada item.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showForm && (
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 font-semibold text-black">Tambah Item</h2>
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
          <form onSubmit={handleCreate} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="name">Nama</Label>
                <Input
                  id="name"
                  placeholder="mis. Tepung Terigu"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
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
                <Label htmlFor="inventory_account">Akun Persediaan</Label>
                <Select
                  id="inventory_account"
                  value={inventoryAccountId}
                  onChange={(e) => setInventoryAccountId(e.target.value)}
                >
                  <option value="">Pilih akun...</option>
                  {leafAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </Select>
              </div>
            </div>

            {formError && <FormError>{formError}</FormError>}

            <Button type="submit" disabled={submitting} className="w-fit">
              {submitting ? "Menyimpan..." : "Simpan Item"}
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
