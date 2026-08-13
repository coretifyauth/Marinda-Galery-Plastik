"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import type { Item } from "@/lib/items/schema";
import { createItemUnitSchema, type ItemUnit } from "@/lib/item-units/schema";
import { getLeafAccounts, type Account } from "@/lib/accounts/schema";
import type { InventoryBalance } from "@/lib/inventory/schema";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { Modal } from "@/components/ui/modal";
import { DetailRows } from "@/components/ui/detail-rows";

export function ItemDetailView({ id }: { id: string }) {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [item, setItem] = useState<Item | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [balance, setBalance] = useState<InventoryBalance | null>(null);
  const [units, setUnits] = useState<ItemUnit[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [showUnitForm, setShowUnitForm] = useState(false);
  const [unitIsBase, setUnitIsBase] = useState(false);
  const [unitLabel, setUnitLabel] = useState("");
  const [conversionFactor, setConversionFactor] = useState("1");
  const [unitPrice, setUnitPrice] = useState("");
  const [unitError, setUnitError] = useState<string | null>(null);
  const [unitSubmitting, setUnitSubmitting] = useState(false);

  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    const [{ data: it, error: itErr }, { data: acc }, { data: bal }, { data: us }] = await Promise.all([
      supabase
        .from("items")
        .select("id, name, item_type, uom, inventory_account_id, archived_at")
        .eq("id", id)
        .single(),
      supabase
        .from("accounts")
        .select("id, code, name, category, normal_balance, is_contra, parent_id, archived_at"),
      supabase.from("inventory_balances").select("item_id, qty_on_hand, avg_cost").eq("item_id", id).maybeSingle(),
      supabase
        .from("item_units")
        .select("id, item_id, unit_label, conversion_factor, price, is_base")
        .eq("item_id", id)
        .order("is_base", { ascending: false }),
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
        { label: "Qty On Hand", value: `${totalQty} ${item.uom}` },
        { label: "Avg Cost / " + item.uom, value: (balance?.avg_cost ?? 0).toLocaleString("id-ID") },
        { label: "Nilai Persediaan", value: totalValue.toLocaleString("id-ID") },
      ],
    },
  ];

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

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/items" label="Kembali ke Items" />
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-black">Item Details</h1>
        {canWrite && (
          <div className="flex gap-2">
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
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Satuan</th>
              <th className="px-4 py-2 text-right">Faktor Konversi</th>
              <th className="px-4 py-2 text-right">Harga</th>
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
                <td colSpan={4} className="px-4 py-6 text-center text-slate-400">
                  Belum ada satuan jual — item ini belum bisa dipakai di Goods Issue.
                </td>
              </tr>
            )}
          </tbody>
        </table>

      </div>

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
    </div>
  );
}
