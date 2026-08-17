"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import {
  createFixedAssetSchema,
  depreciationMethods,
  accumulatedDepreciation,
  bookValue,
  type CreateFixedAssetInput,
  type DepreciationEntry,
} from "@/lib/fixed-assets/schema";
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS, useFixedAssets } from "@/lib/fixed-assets/queries";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { Modal } from "@/components/ui/modal";
import { Pagination } from "@/components/ui/pagination";
import { fetchFixedAssetAccountPresets, type FixedAssetAccountPreset } from "@/lib/default-accounts/schema";

// Input kecil buat baris filter di header tabel -- pola sama journal-entries/page.tsx.
const compactFilterInputClass =
  "w-full rounded border border-slate-200 bg-white px-1.5 py-1 text-xs font-normal normal-case text-slate-700 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-1 focus:ring-blue-600/40";

export default function FixedAssetsPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [checkingSession, setCheckingSession] = useState(true);
  const [presets, setPresets] = useState<FixedAssetAccountPreset[]>([]);
  const [entries, setEntries] = useState<DepreciationEntry[]>([]);
  const [roles, setRoles] = useState<string[]>([]);

  const [nameSearchInput, setNameSearchInput] = useState("");
  const [methodFilter, setMethodFilter] = useState<"" | (typeof depreciationMethods)[number]>("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const debouncedNameSearch = useDebouncedValue(nameSearchInput, 300);

  const [name, setName] = useState("");
  const [presetId, setPresetId] = useState("");
  const [acquisitionCost, setAcquisitionCost] = useState("");
  const [salvageValue, setSalvageValue] = useState("0");
  const [usefulLifeMonths, setUsefulLifeMonths] = useState("");
  const [acquisitionDate, setAcquisitionDate] = useState("");
  const [method, setMethod] = useState<(typeof depreciationMethods)[number]>("straight_line");
  const [rate, setRate] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const activePresets = presets.filter((p) => !p.archived_at);

  // Filter berubah -> balik ke halaman 1 (pola "adjust state during render", lihat
  // journal-entries/page.tsx -- BUKAN useEffect, biar gak kena lint react-hooks/set-state-in-effect).
  const filterKey = `${debouncedNameSearch}|${methodFilter}|${pageSize}`;
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey);
  if (filterKey !== prevFilterKey) {
    setPrevFilterKey(filterKey);
    setPage(0);
  }

  const filters = {
    nameSearch: debouncedNameSearch,
    depreciationMethod: methodFilter,
    page,
    pageSize,
  };
  const assetsQuery = useFixedAssets(filters);
  const assets = assetsQuery.data?.rows ?? [];
  const total = assetsQuery.data?.total ?? 0;

  const loadEntries = useCallback(async () => {
    const { data } = await supabase
      .from("depreciation_entries")
      .select("id, fixed_asset_id, period, amount, journal_entry_id, created_at")
      .order("period");
    setEntries((data ?? []) as DepreciationEntry[]);
  }, []);

  const loadPresets = useCallback(async () => {
    setPresets(await fetchFixedAssetAccountPresets());
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
      await Promise.all([loadPresets(), loadEntries()]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadPresets, loadEntries]);

  const createMutation = useMutation({
    mutationFn: async (input: CreateFixedAssetInput) => {
      const { error } = await supabase.rpc("create_fixed_asset", {
        p_name: input.name,
        p_asset_account_id: input.asset_account_id,
        p_accumulated_depreciation_account_id: input.accumulated_depreciation_account_id,
        p_depreciation_expense_account_id: input.depreciation_expense_account_id,
        p_acquisition_cost: input.acquisition_cost,
        p_salvage_value: input.salvage_value,
        p_useful_life_months: input.useful_life_months,
        p_acquisition_date: input.acquisition_date,
        p_depreciation_method: input.depreciation_method,
        p_depreciation_rate: input.depreciation_rate ?? null,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      setName("");
      setPresetId("");
      setAcquisitionCost("");
      setSalvageValue("0");
      setUsefulLifeMonths("");
      setAcquisitionDate("");
      setMethod("straight_line");
      setRate("");
      setShowForm(false);
      queryClient.invalidateQueries({ queryKey: ["fixed_assets"] });
    },
    onError: (err) => {
      setFormError(err instanceof Error ? err.message : "Gagal menyimpan aset");
    },
  });

  function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const preset = presets.find((p) => p.id === presetId);
    const parsed = createFixedAssetSchema.safeParse({
      name,
      asset_account_id: preset?.asset_account_id ?? "",
      accumulated_depreciation_account_id: preset?.accumulated_depreciation_account_id ?? "",
      depreciation_expense_account_id: preset?.depreciation_expense_account_id ?? "",
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

    createMutation.mutate(parsed.data);
  }

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">Fixed Assets</h1>
        <p className="text-sm text-slate-500">
          Role kamu:{" "}
          {roles.length > 0 ? roles.join(", ") : "belum ada role — cuma bisa lihat"}
        </p>
      </div>

      {assetsQuery.error && <FormError>{(assetsQuery.error as Error).message}</FormError>}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-black">Fixed Assets</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
              {total}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="toolbar" onClick={() => Promise.all([assetsQuery.refetch(), loadEntries()])}>
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
              <th className="px-4 py-2">Metode</th>
              <th className="px-4 py-2 text-right">Nilai Perolehan</th>
              <th className="px-4 py-2 text-right">Akumulasi Penyusutan</th>
              <th className="px-4 py-2 text-right">Nilai Buku</th>
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
                  aria-label="Filter metode"
                  value={methodFilter}
                  onChange={(e) => setMethodFilter(e.target.value as "" | (typeof depreciationMethods)[number])}
                  className={compactFilterInputClass}
                >
                  <option value="">Semua Metode</option>
                  <option value="straight_line">Straight-Line</option>
                  <option value="declining_balance">Declining Balance</option>
                </select>
              </th>
              <th className="px-4 py-1.5" />
              <th className="px-4 py-1.5" />
              <th className="px-4 py-1.5" />
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
                  {assetsQuery.isLoading ? "Memuat..." : "Belum ada aset tetap."}
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

      <Modal
        open={showForm}
        onClose={() => setShowForm(false)}
        title="Tambah Aset Tetap"
        maxWidth="max-w-2xl"
      >
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
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">Nama Aset</Label>
            <Input
              id="name"
              placeholder="mis. Rak Display Toko"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="preset">Jenis Aset (Akun Aset/Akumulasi/Beban)</Label>
            <Select id="preset" value={presetId} onChange={(e) => setPresetId(e.target.value)}>
              <option value="">Pilih jenis aset...</option>
              {activePresets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
            {activePresets.length === 0 && (
              <p className="text-xs text-amber-600">
                Belum ada preset aktif — admin bisa setup di halaman Pengaturan &gt; Kategori & Pajak.
              </p>
            )}
            {presetId &&
              (() => {
                const preset = presets.find((p) => p.id === presetId);
                if (!preset) return null;
                return (
                  <p className="text-xs text-slate-500">
                    {preset.asset_account.code} — {preset.asset_account.name} /{" "}
                    {preset.accumulated_depreciation_account.code} — {preset.accumulated_depreciation_account.name} /{" "}
                    {preset.depreciation_expense_account.code} — {preset.depreciation_expense_account.name}
                  </p>
                );
              })()}
          </div>
          <div className="grid grid-cols-2 gap-4">
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

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setShowForm(false)}>
              Batal
            </Button>
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? "Menyimpan..." : "Simpan Aset"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
