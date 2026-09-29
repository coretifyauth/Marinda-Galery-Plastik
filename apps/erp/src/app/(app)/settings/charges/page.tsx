"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { getLeafAccounts, type Account } from "@/lib/accounts/schema";
import type { TaxSettings } from "@/lib/tax-settings/schema";
import { updateCompanySettingsSchema, type CompanySettings } from "@/lib/company-settings/schema";
import { itemDiscountRuleSchema, type ItemDiscountRule } from "@/lib/item-discount-rules/schema";
import { bundlePromoRuleSchema, type BundlePromoRule } from "@/lib/bundle-promo-rules/schema";
import type { Item } from "@/lib/items/schema";
import type { ItemCategory } from "@/lib/item-categories/schema";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { Modal } from "@/components/ui/modal";
import { Tabs, type TabDef } from "@/components/ui/tabs";
import { LoadingScreen } from "@/components/ui/loading-screen";

type CatalogModule = "pos" | "ar" | "ap";

type CatalogRow = {
  id: string;
  name: string;
  account_id: string;
  archived_at: string | null;
  accounts: { code: string; name: string };
};

/** Kelola 1 katalog "jenis biaya tambahan" — komponen generik, dipakai 3x (POS/AR/AP) karena
 * ketiga katalog itu 1 tabel fisik `charge_categories`, difilter kolom `module`. */
function CatalogManager({
  module,
  title,
  accounts,
  canWrite,
}: {
  module: CatalogModule;
  title: string;
  accounts: Account[];
  canWrite: boolean;
}) {
  const [rows, setRows] = useState<CatalogRow[]>([]);
  const [name, setName] = useState("");
  const [accountId, setAccountId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const leafAccounts = getLeafAccounts(accounts);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("charge_categories")
      .select("id, name, account_id, archived_at, accounts(code, name)")
      .eq("module", module)
      .order("name");
    setRows((data ?? []) as unknown as CatalogRow[]);
  }, [module]);

  useEffect(() => {
    let active = true;
    (async () => {
      if (active) await load();
    })();
    return () => {
      active = false;
    };
  }, [load]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim() || !accountId) {
      setError("Nama dan akun wajib diisi");
      return;
    }
    setSubmitting(true);
    const { error: err } = await supabase.from("charge_categories").insert({ name, account_id: accountId, module });
    setSubmitting(false);
    if (err) {
      setError(err.message);
      return;
    }
    setName("");
    setAccountId("");
    setShowForm(false);
    await load();
  }

  async function toggleArchive(row: CatalogRow) {
    await supabase
      .from("charge_categories")
      .update({ archived_at: row.archived_at ? null : new Date().toISOString() })
      .eq("id", row.id);
    await load();
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold text-black">{title}</h2>
        {canWrite && (
          <Button variant="toolbar-primary" onClick={() => setShowForm(true)}>
            + Tambah
          </Button>
        )}
      </div>
      <table className="mb-3 w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs font-medium uppercase text-slate-500">
            <th className="py-1.5">Nama</th>
            <th className="py-1.5">Akun</th>
            <th className="py-1.5">Status</th>
            {canWrite && <th className="py-1.5" />}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-slate-100">
              <td className="py-1.5">{row.name}</td>
              <td className="py-1.5">
                {row.accounts.code} — {row.accounts.name}
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
              {canWrite && (
                <td className="py-1.5 text-right">
                  <Button type="button" variant="toolbar" onClick={() => toggleArchive(row)}>
                    {row.archived_at ? "Aktifkan" : "Nonaktifkan"}
                  </Button>
                </td>
              )}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} className="py-3 text-center text-slate-400">
                Belum ada kategori.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {canWrite && (
        <Modal open={showForm} onClose={() => setShowForm(false)} title={title}>
          <form onSubmit={handleCreate} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${module}-name`}>Nama Kategori</Label>
              <Input
                id={`${module}-name`}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="mis. Biaya Packing"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${module}-account`}>Akun</Label>
              <Select id={`${module}-account`} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                <option value="">Pilih akun...</option>
                {leafAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} — {a.name}
                  </option>
                ))}
              </Select>
            </div>
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

/** Kelola item_discount_rules -- trade discount sisi penjualan, ditempel ke 1 item ATAU 1
 * category (mutual exclusive, ditegakkan constraint DB). Resolusi "aturan mana yang dipakai"
 * (item menang atas category) dilakukan client-side saat Sales Order/Goods Issue dibuat, lihat
 * @/lib/item-discount-rules/schema.ts. Ref: docs/domain/accounts-receivable.md submodule
 * "Diskon Penjualan (Trade Discount)". */
function ItemDiscountRulesManager({
  items,
  categories,
  canWrite,
}: {
  items: Item[];
  categories: ItemCategory[];
  canWrite: boolean;
}) {
  const [rows, setRows] = useState<(ItemDiscountRule & { items: { name: string } | null; item_categories: { name: string } | null })[]>(
    []
  );
  const [name, setName] = useState("");
  const [targetType, setTargetType] = useState<"item" | "category">("item");
  const [targetId, setTargetId] = useState("");
  const [discountType, setDiscountType] = useState<"PERCENT" | "NOMINAL">("PERCENT");
  const [discountValue, setDiscountValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const activeItems = items.filter((i) => !i.archived_at);
  const activeCategories = categories.filter((c) => !c.archived_at);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("item_discount_rules")
      .select("id, name, item_id, category_id, discount_type, discount_value, archived_at, items(name), item_categories(name)")
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

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = itemDiscountRuleSchema.safeParse({
      name,
      item_id: targetType === "item" ? targetId : null,
      category_id: targetType === "category" ? targetId : null,
      discount_type: discountType,
      discount_value: discountValue,
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
    const { error: err } = await supabase.from("item_discount_rules").insert(parsed.data);
    setSubmitting(false);
    if (err) {
      setError(err.message);
      return;
    }
    setName("");
    setTargetId("");
    setDiscountValue("");
    setShowForm(false);
    await load();
  }

  async function toggleArchive(row: ItemDiscountRule) {
    await supabase
      .from("item_discount_rules")
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
        Langsung dibuat (staf gak pilih manual). Maksimal 1 aturan aktif per barang dan per
        kategori; kalau 1 barang match ke aturan barang DAN aturan kategorinya sekaligus, aturan
        barang yang menang.
      </p>
      <table className="mb-3 w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs font-medium uppercase text-slate-500">
            <th className="py-1.5">Nama</th>
            <th className="py-1.5">Target</th>
            <th className="py-1.5">Diskon</th>
            <th className="py-1.5">Status</th>
            {canWrite && <th className="py-1.5" />}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-slate-100">
              <td className="py-1.5">{row.name}</td>
              <td className="py-1.5">
                {row.items ? `Barang: ${row.items.name}` : `Kategori: ${row.item_categories?.name ?? "-"}`}
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
              {canWrite && (
                <td className="py-1.5 text-right">
                  <Button type="button" variant="toolbar" onClick={() => toggleArchive(row)}>
                    {row.archived_at ? "Aktifkan" : "Nonaktifkan"}
                  </Button>
                </td>
              )}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="py-3 text-center text-slate-400">
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
                }}
              >
                <option value="item">Barang tertentu</option>
                <option value="category">Kategori barang</option>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="discount-target">{targetType === "item" ? "Barang" : "Kategori"}</Label>
              <Select id="discount-target" value={targetId} onChange={(e) => setTargetId(e.target.value)}>
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

/** Kelola bundle_promo_rules -- "Beli N Gratis X", berbasis kuantitas (beda dari
 * item_discount_rules yang berbasis harga). Barang pemicu WAJIB spesifik (gak ada opsi
 * kategori), barang hadiah boleh sama/beda dari pemicu. Ref: docs/domain/accounts-receivable.md
 * submodule "Beli N Gratis X (Bundle Promo)". */
function BundlePromoRulesManager({ items, canWrite }: { items: Item[]; canWrite: boolean }) {
  const [rows, setRows] = useState<
    (BundlePromoRule & { trigger: { name: string }; reward: { name: string } })[]
  >([]);
  const [name, setName] = useState("");
  const [triggerItemId, setTriggerItemId] = useState("");
  const [buyQty, setBuyQty] = useState("");
  const [rewardItemId, setRewardItemId] = useState("");
  const [freeQty, setFreeQty] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const activeItems = items.filter((i) => !i.archived_at);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("bundle_promo_rules")
      .select("id, name, trigger_item_id, buy_qty, reward_item_id, free_qty, archived_at, trigger:items!bundle_promo_rules_trigger_item_id_fkey(name), reward:items!bundle_promo_rules_reward_item_id_fkey(name)")
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

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = bundlePromoRuleSchema.safeParse({
      name,
      trigger_item_id: triggerItemId,
      buy_qty: buyQty,
      reward_item_id: rewardItemId,
      free_qty: freeQty,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }
    setSubmitting(true);
    const { error: err } = await supabase.from("bundle_promo_rules").insert(parsed.data);
    setSubmitting(false);
    if (err) {
      setError(err.message);
      return;
    }
    setName("");
    setTriggerItemId("");
    setBuyQty("");
    setRewardItemId("");
    setFreeQty("");
    setShowForm(false);
    await load();
  }

  async function toggleArchive(row: BundlePromoRule) {
    await supabase
      .from("bundle_promo_rules")
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
        qty beli. Barang hadiah TETAP harus dipilih/scan manual di invoice/keranjang — sistem gak
        pernah menambahkannya otomatis, cuma mengoreksi harganya jadi Rp0 sampai batas qty gratis.
      </p>
      <table className="mb-3 w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs font-medium uppercase text-slate-500">
            <th className="py-1.5">Nama</th>
            <th className="py-1.5">Syarat</th>
            <th className="py-1.5">Hadiah</th>
            <th className="py-1.5">Status</th>
            {canWrite && <th className="py-1.5" />}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-slate-100">
              <td className="py-1.5">{row.name}</td>
              <td className="py-1.5">
                Beli {row.buy_qty} {row.trigger.name}
              </td>
              <td className="py-1.5">
                Gratis {row.free_qty} {row.reward.name}
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
              {canWrite && (
                <td className="py-1.5 text-right">
                  <Button type="button" variant="toolbar" onClick={() => toggleArchive(row)}>
                    {row.archived_at ? "Aktifkan" : "Nonaktifkan"}
                  </Button>
                </td>
              )}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="py-3 text-center text-slate-400">
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
                <Select id="bundle-trigger" value={triggerItemId} onChange={(e) => setTriggerItemId(e.target.value)}>
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
                <Input
                  id="bundle-buy-qty"
                  type="number"
                  min="0"
                  step="any"
                  value={buyQty}
                  onChange={(e) => setBuyQty(e.target.value)}
                  placeholder="mis. 2"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="bundle-reward">Barang Hadiah</Label>
                <Select id="bundle-reward" value={rewardItemId} onChange={(e) => setRewardItemId(e.target.value)}>
                  <option value="">Pilih...</option>
                  {activeItems.map((it) => (
                    <option key={it.id} value={it.id}>
                      {it.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="bundle-free-qty">Qty Gratis</Label>
                <Input
                  id="bundle-free-qty"
                  type="number"
                  min="0"
                  step="any"
                  value={freeQty}
                  onChange={(e) => setFreeQty(e.target.value)}
                  placeholder="mis. 1"
                />
              </div>
            </div>
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

type DefaultAccountRow = {
  id: string;
  role_key: string;
  label: string;
  account_id: string;
  accounts: { code: string; name: string };
};

/** Kelola default_account_settings — role_key -> akun, dipakai <LockedAccountField>
 * di seluruh form transaksi biar user gak lagi pilih akun bebas (memory/preferences/ui/
 * form-components.md). Baris fixed/diseed migration, admin cuma reassign account_id
 * per baris (gak ada tambah/hapus baris dari sini -- role_key ditentukan kode FE). */
function DefaultAccountsManager({ accounts, canWrite }: { accounts: Account[]; canWrite: boolean }) {
  const [rows, setRows] = useState<DefaultAccountRow[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editAccountId, setEditAccountId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const leafAccounts = getLeafAccounts(accounts);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("app_default_account_settings")
      .select("id, role_key, label, account_id, accounts(code, name)")
      .order("role_key");
    setRows((data ?? []) as unknown as DefaultAccountRow[]);
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

  function startEdit(row: DefaultAccountRow) {
    setEditingId(row.id);
    setEditAccountId(row.account_id);
    setError(null);
  }

  async function handleSave(row: DefaultAccountRow) {
    if (!editAccountId) {
      setError("Akun wajib dipilih");
      return;
    }
    setSubmitting(true);
    const { error: err } = await supabase
      .from("app_default_account_settings")
      .update({ account_id: editAccountId })
      .eq("id", row.id);
    setSubmitting(false);
    if (err) {
      setError(err.message);
      return;
    }
    setEditingId(null);
    await load();
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="mb-1 font-semibold text-black">Default Akun</h2>
      <p className="mb-3 text-sm text-slate-500">
        Akun yang otomatis dipakai form transaksi (Piutang, Utang, Kas, dst) — user gak lagi pilih
        akun bebas, cukup lihat. Ubah di sini kalau akunnya perlu diganti, gak perlu deploy kode baru.
      </p>
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs font-medium uppercase text-slate-500">
            <th className="py-1.5">Slot</th>
            <th className="py-1.5">Akun</th>
            {canWrite && <th className="py-1.5" />}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-slate-100">
              <td className="py-1.5">{row.label}</td>
              <td className="py-1.5">
                {editingId === row.id ? (
                  <Select value={editAccountId} onChange={(e) => setEditAccountId(e.target.value)}>
                    <option value="">Pilih akun...</option>
                    {leafAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} — {a.name}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <>
                    {row.accounts.code} — {row.accounts.name}
                  </>
                )}
              </td>
              {canWrite && (
                <td className="py-1.5 text-right">
                  {editingId === row.id ? (
                    <div className="flex justify-end gap-1.5">
                      <Button type="button" variant="toolbar" onClick={() => setEditingId(null)}>
                        Batal
                      </Button>
                      <Button
                        type="button"
                        variant="toolbar-primary"
                        disabled={submitting}
                        onClick={() => handleSave(row)}
                      >
                        {submitting ? "..." : "Simpan"}
                      </Button>
                    </div>
                  ) : (
                    <Button type="button" variant="toolbar" onClick={() => startEdit(row)}>
                      Ubah
                    </Button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {error && <FormError>{error}</FormError>}
    </div>
  );
}

/** Kelola app_settings (kolom identitas perusahaan) — singleton (pola sama TaxSettingsCard
 * di bawah, migration 0028 gabungan tax_settings+company_settings+pos_settings), dibaca
 * live buat kop surat cetakan AR Invoice/PO (docs/domain/print-templates.md). */
function CompanySettingsCard({ canWrite }: { canWrite: boolean }) {
  const [settings, setSettings] = useState<CompanySettings | null>(null);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [npwp, setNpwp] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("app_settings")
      .select("id, name, address, npwp, logo_url, updated_at, updated_by")
      .maybeSingle();
    if (data) {
      const s = data as CompanySettings;
      setSettings(s);
      setName(s.name);
      setAddress(s.address ?? "");
      setNpwp(s.npwp ?? "");
      setLogoUrl(s.logo_url ?? "");
    }
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

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    const parsed = updateCompanySettingsSchema.safeParse({ name, address, npwp, logo_url: logoUrl });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }
    setSubmitting(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { error: err } = await supabase
      .from("app_settings")
      .update({
        name: parsed.data.name,
        address: parsed.data.address || null,
        npwp: parsed.data.npwp || null,
        logo_url: parsed.data.logo_url || null,
        updated_by: user?.id ?? null,
      })
      .eq("id", true);
    setSubmitting(false);
    if (err) {
      setError(err.message);
      return;
    }
    setSaved(true);
    await load();
  }

  if (!settings) return null;

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="mb-1 font-semibold text-black">Identitas Perusahaan (Kop Surat)</h2>
      <p className="mb-3 text-sm text-slate-500">
        Muncul di kop surat cetakan Invoice &amp; Purchase Order. Logo cuma link ke gambar yang
        sudah di-host di tempat lain — belum ada upload file di fase ini.
      </p>
      <form onSubmit={handleSave} className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="company_name">Nama Perusahaan</Label>
            <Input id="company_name" value={name} onChange={(e) => setName(e.target.value)} disabled={!canWrite} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="company_npwp">NPWP</Label>
            <Input id="company_npwp" value={npwp} onChange={(e) => setNpwp(e.target.value)} disabled={!canWrite} />
          </div>
          <div className="flex flex-col gap-1 sm:col-span-2">
            <Label htmlFor="company_address">Alamat</Label>
            <Input
              id="company_address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              disabled={!canWrite}
            />
          </div>
          <div className="flex flex-col gap-1 sm:col-span-2">
            <Label htmlFor="company_logo">URL Logo (opsional)</Label>
            <Input
              id="company_logo"
              value={logoUrl}
              onChange={(e) => setLogoUrl(e.target.value)}
              placeholder="https://..."
              disabled={!canWrite}
            />
          </div>
        </div>
        {logoUrl && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500">Preview:</span>
            {/* eslint-disable-next-line @next/next/no-img-element -- logo_url link eksternal, bukan asset Next.js */}
            <img src={logoUrl} alt="Logo perusahaan" className="h-10 max-w-30 object-contain" />
          </div>
        )}
        {canWrite && (
          <Button type="submit" disabled={submitting} className="w-fit">
            {submitting ? "Menyimpan..." : "Simpan Identitas Perusahaan"}
          </Button>
        )}
        {saved && <p className="text-sm text-emerald-600">Tersimpan.</p>}
        {error && <FormError>{error}</FormError>}
      </form>
    </div>
  );
}

function TaxSettingsCard({ canWrite }: { canWrite: boolean }) {
  const [settings, setSettings] = useState<TaxSettings | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [isActive, setIsActive] = useState(false);
  const [rate, setRate] = useState("11");
  const [keluaranId, setKeluaranId] = useState("");
  const [masukanId, setMasukanId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);

  const leafAccounts = getLeafAccounts(accounts);

  const load = useCallback(async () => {
    const [{ data: ts }, { data: acc }] = await Promise.all([
      supabase
        .from("app_settings")
        .select("id, is_active, ppn_rate, ppn_keluaran_account_id, ppn_masukan_account_id")
        .maybeSingle(),
      supabase
        .from("accounts")
        .select("id, code, name, category, normal_balance, parent_id, archived_at")
        .order("code"),
    ]);
    setAccounts((acc ?? []) as Account[]);
    if (ts) {
      const t = ts as TaxSettings;
      setSettings(t);
      setIsActive(t.is_active);
      setRate(String(t.ppn_rate));
      setKeluaranId(t.ppn_keluaran_account_id ?? "");
      setMasukanId(t.ppn_masukan_account_id ?? "");
    }
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

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setSubmitting(true);
    const { error: err } = await supabase
      .from("app_settings")
      .update({
        is_active: isActive,
        ppn_rate: Number(rate),
        ppn_keluaran_account_id: keluaranId || null,
        ppn_masukan_account_id: masukanId || null,
      })
      .eq("id", true);
    setSubmitting(false);
    if (err) {
      setError(err.message);
      return;
    }
    setSaved(true);
    await load();
  }

  if (!settings) return null;

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="mb-3 font-semibold text-black">Pengaturan Pajak (PPN)</h2>
      <form onSubmit={handleSave} className="flex flex-col gap-3">
        <label className="flex w-fit items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
            disabled={!canWrite}
          />
          Kios ini wajib pungut PPN (PKP)
        </label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="ppn_rate">Tarif PPN (%)</Label>
            <Input
              id="ppn_rate"
              type="number"
              min="0"
              step="0.5"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              disabled={!canWrite}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="ppn_keluaran">Akun PPN Keluaran (AR/POS)</Label>
            <Select
              id="ppn_keluaran"
              value={keluaranId}
              onChange={(e) => setKeluaranId(e.target.value)}
              disabled={!canWrite}
            >
              <option value="">Pilih akun...</option>
              {leafAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} — {a.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="ppn_masukan">Akun PPN Masukan (AP)</Label>
            <Select
              id="ppn_masukan"
              value={masukanId}
              onChange={(e) => setMasukanId(e.target.value)}
              disabled={!canWrite}
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
        {canWrite && (
          <Button type="submit" disabled={submitting} className="w-fit">
            {submitting ? "Menyimpan..." : "Simpan Pengaturan Pajak"}
          </Button>
        )}
        {saved && <p className="text-sm text-emerald-600">Tersimpan.</p>}
        {error && <FormError>{error}</FormError>}
      </form>
    </div>
  );
}

const settingsTabs: TabDef[] = [
  { key: "default_accounts", label: "Default Akun" },
  { key: "charge_categories", label: "Kategori Tambahan" },
  { key: "item_discount_rules", label: "Aturan Diskon Barang" },
  { key: "bundle_promo_rules", label: "Promo Beli N Gratis X" },
  { key: "tax", label: "Pajak" },
  { key: "print_documents", label: "Dokumen Cetak" },
];

export default function ChargesSettingsPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [itemCategories, setItemCategories] = useState<ItemCategory[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<string>(settingsTabs[0].key);

  const loadAccounts = useCallback(async () => {
    const { data } = await supabase
      .from("accounts")
      .select("id, code, name, category, normal_balance, parent_id, archived_at")
      .order("code");
    setAccounts((data ?? []) as Account[]);
  }, []);

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
      await Promise.all([loadAccounts(), loadItemsAndCategories()]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadAccounts, loadItemsAndCategories]);

  if (checkingSession) {
    return <LoadingScreen />;
  }

  const canWrite = roles.includes("admin");

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">Pengaturan</h1>
        <p className="text-sm text-slate-500">
          Setup Default Akun, katalog kategori biaya tambahan (POS/AR/AP), aturan diskon barang
          (sisi penjualan), pengaturan PPN, dan identitas perusahaan/penandatangan buat cetakan
          dokumen.{" "}
          {!canWrite && "Cuma role admin yang bisa ubah — kamu cuma bisa lihat."}
        </p>
      </div>
      <Tabs tabs={settingsTabs} active={activeTab} onChange={setActiveTab} />
      {activeTab === "default_accounts" && <DefaultAccountsManager accounts={accounts} canWrite={canWrite} />}
      {activeTab === "charge_categories" && (
        <div className="flex flex-col gap-6">
          <CatalogManager
            module="pos"
            title="Kategori Biaya Tambahan — POS"
            accounts={accounts}
            canWrite={canWrite}
          />
          <CatalogManager
            module="ar"
            title="Kategori Pendapatan Tambahan — Invoice"
            accounts={accounts}
            canWrite={canWrite}
          />
          <CatalogManager
            module="ap"
            title="Kategori Beban/Persediaan Tambahan — Tagihan"
            accounts={accounts}
            canWrite={canWrite}
          />
        </div>
      )}
      {activeTab === "item_discount_rules" && (
        <ItemDiscountRulesManager items={items} categories={itemCategories} canWrite={canWrite} />
      )}
      {activeTab === "bundle_promo_rules" && <BundlePromoRulesManager items={items} canWrite={canWrite} />}
      {activeTab === "tax" && <TaxSettingsCard canWrite={canWrite} />}
      {activeTab === "print_documents" && <CompanySettingsCard canWrite={canWrite} />}
    </div>
  );
}
