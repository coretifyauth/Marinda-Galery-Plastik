"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import {
  createFixedAssetSchema,
  depreciationMethods,
  type CreateFixedAssetInput,
} from "@/lib/fixed-assets/schema";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { fetchFixedAssetAccountPresets, type FixedAssetAccountPreset } from "@/lib/default-accounts/schema";
import { LoadingScreen } from "@/components/ui/loading-screen";

export default function NewFixedAssetPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [presets, setPresets] = useState<FixedAssetAccountPreset[]>([]);
  const [roles, setRoles] = useState<string[]>([]);

  const [name, setName] = useState("");
  const [presetId, setPresetId] = useState("");
  const [acquisitionCost, setAcquisitionCost] = useState("");
  const [salvageValue, setSalvageValue] = useState("0");
  const [usefulLifeMonths, setUsefulLifeMonths] = useState("");
  const [acquisitionDate, setAcquisitionDate] = useState("");
  const [method, setMethod] = useState<(typeof depreciationMethods)[number]>("straight_line");
  const [rate, setRate] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const activePresets = presets.filter((p) => !p.archived_at);

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
      await loadPresets();
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadPresets]);

  const createMutation = useMutation({
    mutationFn: async (input: CreateFixedAssetInput) => {
      const { data, error } = await supabase.rpc("create_fixed_asset", {
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
      return data as string | null;
    },
    onSuccess: (newId) => {
      router.push(newId ? `/fixed-assets/${newId}` : "/fixed-assets");
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
    return <LoadingScreen />;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");
  const selectedPreset = presets.find((p) => p.id === presetId);

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/fixed-assets" label="Kembali ke Aset Tetap" />

      <div>
        <h1 className="text-xl font-semibold text-black">Tambah Aset Tetap</h1>
        <p className="text-sm text-slate-500">
          Cuma nyimpen master data aset. Jurnal akuisisi (Debit Aset Tetap, Kredit Kas/Utang)
          dicatat terpisah lewat halaman Jurnal Umum.
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
                {selectedPreset && (
                  <p className="text-xs text-slate-500">
                    {selectedPreset.asset_account.code} — {selectedPreset.asset_account.name} /{" "}
                    {selectedPreset.accumulated_depreciation_account.code} —{" "}
                    {selectedPreset.accumulated_depreciation_account.name} /{" "}
                    {selectedPreset.depreciation_expense_account.code} —{" "}
                    {selectedPreset.depreciation_expense_account.name}
                  </p>
                )}
              </div>
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
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
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4 lg:sticky lg:top-4 lg:col-span-1 lg:self-start">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-6">
            <p className="mb-2.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Soal Metode Penyusutan
            </p>
            <p className="text-sm text-slate-600">
              Straight-Line membagi rata (Nilai Perolehan − Residu) ke tiap periode posting.
              Declining Balance mengalikan tarif ke nilai buku berjalan tiap posting — dipakai
              kalau penyusutan mau lebih besar di periode awal.
            </p>
          </div>

          {formError && <FormError>{formError}</FormError>}

          <div className="flex flex-col gap-2">
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? "Menyimpan..." : "Simpan Aset"}
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
