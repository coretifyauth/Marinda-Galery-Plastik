"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { bundlePromoRuleSchema, type BundlePromoRule } from "@/lib/promotion-bundle-rules/schema";
import type { Item } from "@/lib/items/schema";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { Modal } from "@/components/ui/modal";
import { LoadingScreen } from "@/components/ui/loading-screen";

/** Kelola promotion_bundle_rules -- "Beli N Gratis X", berbasis kuantitas (beda dari
 * promotion_item_discount_rules yang berbasis harga). Barang pemicu WAJIB spesifik (gak ada
 * opsi kategori), barang hadiah boleh sama/beda dari pemicu. Ref:
 * docs/domain/accounts-receivable.md submodule "Beli N Gratis X (Bundle Promo)". */
type UnitOption = { id: string; unit_label: string; conversion_factor: number };

// Satuan NON-dasar milik 1 barang -- "satuan dasar" sendiri dipilih lewat opsi kosong (null).
async function fetchNonBaseUnits(itemId: string): Promise<UnitOption[]> {
  const { data } = await supabase
    .from("item_units")
    .select("id, unit_label, conversion_factor")
    .eq("item_id", itemId)
    .eq("is_base", false)
    .order("conversion_factor");
  return (data ?? []) as UnitOption[];
}

function rewardLabel(row: { reward_type?: string; reward_value?: number | null }): string {
  if (row.reward_type === "PERCENT") return `diskon ${row.reward_value}%`;
  if (row.reward_type === "NOMINAL") return `diskon Rp${(row.reward_value ?? 0).toLocaleString("id-ID")}/unit dasar`;
  return "gratis";
}

function BundlePromoRulesManager({ items, canWrite }: { items: Item[]; canWrite: boolean }) {
  const [rows, setRows] = useState<
    (BundlePromoRule & {
      created_at: string;
      created_by: string | null;
      trigger: { name: string };
      reward: { name: string };
      buy_unit: { unit_label: string } | null;
      reward_unit: { unit_label: string } | null;
    })[]
  >([]);
  const [name, setName] = useState("");
  const [triggerItemId, setTriggerItemId] = useState("");
  const [buyQty, setBuyQty] = useState("");
  const [buyUnitId, setBuyUnitId] = useState("");
  const [triggerUnits, setTriggerUnits] = useState<UnitOption[]>([]);
  const [rewardItemId, setRewardItemId] = useState("");
  const [freeQty, setFreeQty] = useState("");
  const [rewardUnitId, setRewardUnitId] = useState("");
  const [rewardUnits, setRewardUnits] = useState<UnitOption[]>([]);
  const [rewardType, setRewardType] = useState<"FREE" | "PERCENT" | "NOMINAL">("FREE");
  const [rewardValue, setRewardValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"active" | "archived" | "all">("active");

  const activeItems = items.filter((i) => !i.archived_at);
  const visibleRows = rows.filter((row) => {
    if (statusFilter === "active") return !row.archived_at;
    if (statusFilter === "archived") return !!row.archived_at;
    return true;
  });

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("promotion_bundle_rules")
      .select(
        "id, name, trigger_item_id, buy_qty, reward_item_id, free_qty, archived_at, created_at, created_by, reward_type, reward_value, buy_unit_id, buy_unit_qty, reward_unit_id, reward_unit_qty, trigger:items!promotion_bundle_rules_trigger_item_id_fkey(name), reward:items!promotion_bundle_rules_reward_item_id_fkey(name), buy_unit:item_units!promotion_bundle_rules_buy_unit_id_fkey(unit_label), reward_unit:item_units!promotion_bundle_rules_reward_unit_id_fkey(unit_label)"
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

  async function handleTriggerItemChange(id: string) {
    setTriggerItemId(id);
    setBuyUnitId("");
    setTriggerUnits(id ? await fetchNonBaseUnits(id) : []);
  }

  async function handleRewardItemChange(id: string) {
    setRewardItemId(id);
    setRewardUnitId("");
    setRewardUnits(id ? await fetchNonBaseUnits(id) : []);
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    // Kalau satuan dipilih, buy_qty/free_qty yang dikirim cuma placeholder (qty ketikan) -- trigger
    // DB yang menghitung nilai kanonik satuan dasarnya (qty x faktor satuan).
    const parsed = bundlePromoRuleSchema.safeParse({
      name,
      trigger_item_id: triggerItemId,
      buy_qty: buyQty,
      buy_unit_id: buyUnitId || null,
      buy_unit_qty: buyUnitId ? buyQty : null,
      reward_item_id: rewardItemId,
      free_qty: freeQty,
      reward_unit_id: rewardUnitId || null,
      reward_unit_qty: rewardUnitId ? freeQty : null,
      reward_type: rewardType,
      reward_value: rewardType === "FREE" ? null : rewardValue,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }
    setSubmitting(true);
    const { error: err } = await supabase.from("promotion_bundle_rules").insert(parsed.data);
    setSubmitting(false);
    if (err) {
      setError(
        err.code === "23505"
          ? "Sudah ada promo aktif dengan barang pemicu dan barang hadiah yang sama — nonaktifkan yang lama dulu."
          : err.message
      );
      return;
    }
    setName("");
    setTriggerItemId("");
    setBuyQty("");
    setBuyUnitId("");
    setTriggerUnits([]);
    setRewardItemId("");
    setFreeQty("");
    setRewardUnitId("");
    setRewardUnits([]);
    setRewardType("FREE");
    setRewardValue("");
    setShowForm(false);
    await load();
  }

  async function toggleArchive(row: BundlePromoRule) {
    await supabase
      .from("promotion_bundle_rules")
      .update({ archived_at: row.archived_at ? null : new Date().toISOString() })
      .eq("id", row.id);
    await load();
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="font-semibold text-black">Promo Beli N Gratis X</h2>
        {canWrite && (
          <Button variant="toolbar-primary" onClick={() => setShowForm(true)}>
            + Tambah
          </Button>
        )}
      </div>
      <p className="mb-3 text-sm text-slate-500">
        Berbasis kuantitas — barang hadiah boleh beda dari barang pemicu, berulang tiap kelipatan
        qty beli. Qty beli dan qty hadiah boleh ditulis dalam satuan tertentu (mis. beli 10 dos
        gratis 1 dos) — sistem yang mengonversi ke satuan dasar, qty pemicu dijumlah lintas baris.
        Hadiah bisa gratis penuh atau diskon (persen/nominal) hanya untuk qty yang berhak. Barang
        hadiah TETAP harus dipilih/scan manual di invoice/keranjang — sistem gak pernah
        menambahkannya otomatis. Untuk Sales Order yang dikirim bertahap, promo dihitung per
        pengiriman.
      </p>
      <div className="mb-3 flex items-center gap-2">
        <Label htmlFor="promo-status-filter" className="text-xs">
          Status
        </Label>
        <div className="w-40">
          <Select
            id="promo-status-filter"
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
            <th className="py-1.5">Syarat</th>
            <th className="py-1.5">Hadiah</th>
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
                Beli{" "}
                {row.buy_unit && row.buy_unit_qty != null
                  ? `${row.buy_unit_qty} ${row.buy_unit.unit_label}`
                  : row.buy_qty}{" "}
                {row.trigger.name}
              </td>
              <td className="py-1.5">
                {row.reward_unit && row.reward_unit_qty != null
                  ? `${row.reward_unit_qty} ${row.reward_unit.unit_label}`
                  : row.free_qty}{" "}
                {row.reward.name} ({rewardLabel(row)})
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
              <td colSpan={7} className="py-3 text-center text-slate-400">
                Belum ada promo bundle.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {canWrite && (
        <Modal open={showForm} onClose={() => setShowForm(false)} title="Promo Beli N Gratis X">
          <form onSubmit={handleCreate} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="bundle-name">Nama Promo</Label>
              <Input
                id="bundle-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="mis. Beli 2 Sabun Gratis 1 Shampo"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="bundle-trigger">Barang Pemicu</Label>
                <Select id="bundle-trigger" value={triggerItemId} onChange={(e) => handleTriggerItemChange(e.target.value)}>
                  <option value="">Pilih...</option>
                  {activeItems.map((it) => (
                    <option key={it.id} value={it.id}>
                      {it.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="bundle-buy-qty">Qty Beli Minimal</Label>
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    id="bundle-buy-qty"
                    type="number"
                    min="0"
                    step="any"
                    value={buyQty}
                    onChange={(e) => setBuyQty(e.target.value)}
                    placeholder="mis. 10"
                  />
                  <Select aria-label="Satuan qty beli" value={buyUnitId} onChange={(e) => setBuyUnitId(e.target.value)}>
                    <option value="">
                      {`Satuan dasar${items.find((i) => i.id === triggerItemId) ? ` (${items.find((i) => i.id === triggerItemId)?.uom})` : ""}`}
                    </option>
                    {triggerUnits.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.unit_label} (×{u.conversion_factor})
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="bundle-reward">Barang Hadiah</Label>
                <Select id="bundle-reward" value={rewardItemId} onChange={(e) => handleRewardItemChange(e.target.value)}>
                  <option value="">Pilih...</option>
                  {activeItems.map((it) => (
                    <option key={it.id} value={it.id}>
                      {it.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="bundle-free-qty">Qty Hadiah</Label>
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    id="bundle-free-qty"
                    type="number"
                    min="0"
                    step="any"
                    value={freeQty}
                    onChange={(e) => setFreeQty(e.target.value)}
                    placeholder="mis. 1"
                  />
                  <Select
                    aria-label="Satuan qty hadiah"
                    value={rewardUnitId}
                    onChange={(e) => setRewardUnitId(e.target.value)}
                  >
                    <option value="">
                      {`Satuan dasar${items.find((i) => i.id === rewardItemId) ? ` (${items.find((i) => i.id === rewardItemId)?.uom})` : ""}`}
                    </option>
                    {rewardUnits.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.unit_label} (×{u.conversion_factor})
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="bundle-reward-type">Jenis Hadiah</Label>
                <Select
                  id="bundle-reward-type"
                  value={rewardType}
                  onChange={(e) => {
                    setRewardType(e.target.value as "FREE" | "PERCENT" | "NOMINAL");
                    setRewardValue("");
                  }}
                >
                  <option value="FREE">Gratis (harga Rp0)</option>
                  <option value="PERCENT">Diskon persen (%)</option>
                  <option value="NOMINAL">Diskon nominal (Rp/unit dasar)</option>
                </Select>
              </div>
              {rewardType !== "FREE" && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="bundle-reward-value">
                    {rewardType === "PERCENT" ? "Diskon (%)" : "Diskon (Rp per unit satuan dasar)"}
                  </Label>
                  <Input
                    id="bundle-reward-value"
                    type="number"
                    min="0"
                    step="any"
                    value={rewardValue}
                    onChange={(e) => setRewardValue(e.target.value)}
                    placeholder={rewardType === "PERCENT" ? "mis. 50" : "mis. 4000"}
                  />
                </div>
              )}
            </div>
            <p className="text-xs text-slate-500">
              Satuan yang dipilih tidak bisa diubah faktor konversinya lagi. Diskon hadiah cuma berlaku
              untuk qty hadiah yang berhak (kelipatan syarat), bukan seluruh baris hadiah.
            </p>
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

export default function PromoRulesPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [items, setItems] = useState<Item[]>([]);
  const [roles, setRoles] = useState<string[]>([]);

  const loadItems = useCallback(async () => {
    const { data } = await supabase
      .from("items")
      .select("id, name, item_type, uom, inventory_account_id, category_id, brand_id, archived_at")
      .order("name");
    setItems((data ?? []) as Item[]);
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
      await loadItems();
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadItems]);

  if (checkingSession) {
    return <LoadingScreen />;
  }

  const canWrite = roles.includes("admin");

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">Aturan Promo</h1>
        <p className="text-sm text-slate-500">
          Promo &quot;Beli N Gratis X&quot; berbasis kuantitas.{" "}
          {!canWrite && "Cuma role admin yang bisa ubah — kamu cuma bisa lihat."}
        </p>
      </div>
      <BundlePromoRulesManager items={items} canWrite={canWrite} />
    </div>
  );
}
