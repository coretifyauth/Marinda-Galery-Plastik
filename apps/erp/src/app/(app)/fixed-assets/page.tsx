"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { getLeafAccounts, type Account } from "@/lib/accounts/schema";
import {
  createFixedAssetSchema,
  depreciationMethods,
  accumulatedDepreciation,
  bookValue,
  type FixedAsset,
  type DepreciationEntry,
} from "@/lib/fixed-assets/schema";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";

export default function FixedAssetsPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [assets, setAssets] = useState<FixedAsset[]>([]);
  const [entries, setEntries] = useState<DepreciationEntry[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [assetAccountId, setAssetAccountId] = useState("");
  const [accumAccountId, setAccumAccountId] = useState("");
  const [expenseAccountId, setExpenseAccountId] = useState("");
  const [acquisitionCost, setAcquisitionCost] = useState("");
  const [salvageValue, setSalvageValue] = useState("0");
  const [usefulLifeMonths, setUsefulLifeMonths] = useState("");
  const [acquisitionDate, setAcquisitionDate] = useState("");
  const [method, setMethod] = useState<(typeof depreciationMethods)[number]>("straight_line");
  const [rate, setRate] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const leafAccounts = getLeafAccounts(accounts);
  const assetAccounts = leafAccounts.filter((a) => a.category === "asset" && !a.is_contra);
  const contraAccounts = leafAccounts.filter((a) => a.category === "asset" && a.is_contra);
  const expenseAccounts = leafAccounts.filter((a) => a.category === "expense");

  const loadAssets = useCallback(async () => {
    const { data, error } = await supabase
      .from("fixed_assets")
      .select(
        "id, name, asset_account_id, accumulated_depreciation_account_id, depreciation_expense_account_id, acquisition_cost, salvage_value, useful_life_months, acquisition_date, depreciation_method, depreciation_rate, archived_at"
      )
      .order("acquisition_date");
    if (error) {
      setLoadError(error.message);
      return;
    }
    setLoadError(null);
    setAssets((data ?? []) as FixedAsset[]);
  }, []);

  const loadEntries = useCallback(async () => {
    const { data } = await supabase
      .from("depreciation_entries")
      .select("id, fixed_asset_id, period, amount, journal_entry_id, created_at")
      .order("period");
    setEntries((data ?? []) as DepreciationEntry[]);
  }, []);

  const loadAccounts = useCallback(async () => {
    const { data } = await supabase
      .from("accounts")
      .select("id, code, name, category, normal_balance, is_contra, parent_id, archived_at")
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
      await Promise.all([loadAccounts(), loadAssets(), loadEntries()]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadAccounts, loadAssets, loadEntries]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const parsed = createFixedAssetSchema.safeParse({
      name,
      asset_account_id: assetAccountId,
      accumulated_depreciation_account_id: accumAccountId,
      depreciation_expense_account_id: expenseAccountId,
      acquisition_cost: acquisitionCost,
      salvage_value: salvageValue,
      useful_life_months: usefulLifeMonths,
      acquisition_date: acquisitionDate,
      depreciation_method: method,
      depreciation_rate: method === "declining_balance" ? rate : undefined,
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setSubmitting(true);
    const { error } = await supabase.rpc("create_fixed_asset", {
      p_name: parsed.data.name,
      p_asset_account_id: parsed.data.asset_account_id,
      p_accumulated_depreciation_account_id: parsed.data.accumulated_depreciation_account_id,
      p_depreciation_expense_account_id: parsed.data.depreciation_expense_account_id,
      p_acquisition_cost: parsed.data.acquisition_cost,
      p_salvage_value: parsed.data.salvage_value,
      p_useful_life_months: parsed.data.useful_life_months,
      p_acquisition_date: parsed.data.acquisition_date,
      p_depreciation_method: parsed.data.depreciation_method,
      p_depreciation_rate: parsed.data.depreciation_rate ?? null,
    });
    setSubmitting(false);
    if (error) {
      setFormError(error.message);
      return;
    }

    setName("");
    setAssetAccountId("");
    setAccumAccountId("");
    setExpenseAccountId("");
    setAcquisitionCost("");
    setSalvageValue("0");
    setUsefulLifeMonths("");
    setAcquisitionDate("");
    setMethod("straight_line");
    setRate("");
    setShowForm(false);
    await loadAssets();
  }

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");

  return (
    <div className="flex w-full max-w-5xl flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">Fixed Assets — CV Roti Barokah</h1>
        <p className="text-sm text-slate-500">
          Role kamu:{" "}
          {roles.length > 0 ? roles.join(", ") : "belum ada role — cuma bisa lihat"}
        </p>
      </div>

      {loadError && <FormError>{loadError}</FormError>}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-black">Fixed Assets</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
              {assets.length}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="toolbar" onClick={() => Promise.all([loadAssets(), loadEntries()])}>
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
              <th className="px-4 py-2">Metode</th>
              <th className="px-4 py-2 text-right">Nilai Perolehan</th>
              <th className="px-4 py-2 text-right">Akumulasi Penyusutan</th>
              <th className="px-4 py-2 text-right">Nilai Buku</th>
            </tr>
          </thead>
          <tbody>
            {assets.map((asset) => {
              const accumulated = accumulatedDepreciation(entries, asset.id);
              const book = bookValue(asset, accumulated);
              return (
                <tr
                  key={asset.id}
                  className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                  onClick={() => router.push(`/fixed-assets/${asset.id}`)}
                >
                  <td className="px-4 py-2 font-medium text-black">{asset.name}</td>
                  <td className="px-4 py-2">
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                      {asset.depreciation_method === "straight_line"
                        ? "Straight-Line"
                        : `Declining Balance (${(asset.depreciation_rate! * 100).toFixed(0)}%)`}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    {asset.acquisition_cost.toLocaleString("id-ID")}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    {accumulated.toLocaleString("id-ID")}
                  </td>
                  <td className="px-4 py-2 text-right font-mono font-medium text-black">
                    {book.toLocaleString("id-ID")}
                  </td>
                </tr>
              );
            })}
            {assets.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-400">
                  Belum ada aset tetap.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showForm && (
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 font-semibold text-black">Tambah Aset Tetap</h2>
          {!canWrite && (
            <p className="mb-4 text-sm text-amber-600">
              Kamu belum punya role admin/accountant — submit di bawah kemungkinan bakal
              ketolak RLS.
            </p>
          )}
          <p className="mb-4 text-sm text-slate-500">
            Cuma nyimpen master data aset. Jurnal akuisisi (Debit Aset Tetap, Kredit Kas/Utang)
            dicatat terpisah lewat halaman Journal Entries.
          </p>
          <form onSubmit={handleCreate} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="name">Nama Aset</Label>
                <Input
                  id="name"
                  placeholder="mis. Oven Tambahan"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="asset_account">Akun Aset Tetap</Label>
                <Select id="asset_account" value={assetAccountId} onChange={(e) => setAssetAccountId(e.target.value)}>
                  <option value="">Pilih akun...</option>
                  {assetAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="accum_account">Akun Akumulasi Penyusutan</Label>
                <Select id="accum_account" value={accumAccountId} onChange={(e) => setAccumAccountId(e.target.value)}>
                  <option value="">Pilih akun...</option>
                  {contraAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="expense_account">Akun Beban Penyusutan</Label>
                <Select id="expense_account" value={expenseAccountId} onChange={(e) => setExpenseAccountId(e.target.value)}>
                  <option value="">Pilih akun...</option>
                  {expenseAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="acquisition_cost">Nilai Perolehan</Label>
                <Input
                  id="acquisition_cost"
                  type="number"
                  min="0"
                  placeholder="mis. 15000000"
                  value={acquisitionCost}
                  onChange={(e) => setAcquisitionCost(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="salvage_value">Nilai Residu</Label>
                <Input
                  id="salvage_value"
                  type="number"
                  min="0"
                  value={salvageValue}
                  onChange={(e) => setSalvageValue(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="useful_life_months">Umur Manfaat (bulan)</Label>
                <Input
                  id="useful_life_months"
                  type="number"
                  min="1"
                  placeholder="mis. 60"
                  value={usefulLifeMonths}
                  onChange={(e) => setUsefulLifeMonths(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="acquisition_date">Tanggal Akuisisi</Label>
                <Input
                  id="acquisition_date"
                  type="date"
                  value={acquisitionDate}
                  onChange={(e) => setAcquisitionDate(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="method">Metode Penyusutan</Label>
                <Select
                  id="method"
                  value={method}
                  onChange={(e) => setMethod(e.target.value as (typeof depreciationMethods)[number])}
                >
                  {depreciationMethods.map((m) => (
                    <option key={m} value={m}>
                      {m === "straight_line" ? "Straight-Line" : "Declining Balance"}
                    </option>
                  ))}
                </Select>
              </div>
              {method === "declining_balance" && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="rate">Tarif per Periode Posting (0-1)</Label>
                  <Input
                    id="rate"
                    type="number"
                    step="0.01"
                    min="0"
                    max="1"
                    placeholder="mis. 0.40"
                    value={rate}
                    onChange={(e) => setRate(e.target.value)}
                  />
                </div>
              )}
            </div>

            {formError && <FormError>{formError}</FormError>}

            <Button type="submit" disabled={submitting} className="w-fit">
              {submitting ? "Menyimpan..." : "Simpan Aset"}
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
