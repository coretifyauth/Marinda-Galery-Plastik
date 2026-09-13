"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import type { Account } from "@/lib/accounts/schema";
import {
  createFixedAssetDisposalSchema,
  disposalTypes,
  disposalTypeLabels,
  type FixedAsset,
  type DepreciationEntry,
} from "@/lib/fixed-assets/schema";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormError, FormHint } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { LockedAccountField } from "@/components/ui/locked-account-field";
import { JournalPreviewPanel } from "@/components/ui/journal-preview-panel";
import { CashMethodField, resolveCashAccount, type CashMethod } from "@/components/ui/cash-method-field";
import { fetchDefaultAccounts, type ResolvedAccount } from "@/lib/default-accounts/schema";
import { LoadingScreen } from "@/components/ui/loading-screen";

export default function DisposeFixedAssetPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [asset, setAsset] = useState<FixedAsset | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [entries, setEntries] = useState<DepreciationEntry[]>([]);
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  const [disposeDate, setDisposeDate] = useState("");
  const [disposeType, setDisposeType] = useState<(typeof disposalTypes)[number]>("sold");
  const [disposeProceeds, setDisposeProceeds] = useState("0");
  const [disposeCashMethod, setDisposeCashMethod] = useState<CashMethod>("TUNAI");
  const [disposeNotes, setDisposeNotes] = useState("");
  const [disposeError, setDisposeError] = useState<string | null>(null);
  const [disposing, setDisposing] = useState(false);

  const load = useCallback(async () => {
    const [{ data: fa, error: faErr }, { data: acc }, { data: de }, defAcc] = await Promise.all([
      supabase
        .from("fixed_assets")
        .select(
          "id, name, asset_account_id, accumulated_depreciation_account_id, depreciation_expense_account_id, acquisition_cost, salvage_value, useful_life_months, acquisition_date, depreciation_method, depreciation_rate, archived_at, disposed_at"
        )
        .eq("id", id)
        .single(),
      supabase.from("accounts").select("id, code, name, category, normal_balance, is_contra, parent_id, archived_at"),
      supabase
        .from("depreciation_entries")
        .select("id, fixed_asset_id, period, amount, journal_entry_id, created_at")
        .eq("fixed_asset_id", id)
        .order("period"),
      fetchDefaultAccounts(),
    ]);
    if (faErr) {
      setLoadError(faErr.message);
      return;
    }
    setLoadError(null);
    setAsset(fa as FixedAsset);
    setAccounts((acc ?? []) as Account[]);
    setEntries((de ?? []) as DepreciationEntry[]);
    setDefaultAccounts(defAcc);
  }, [id]);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) {
        router.replace("/login");
        return;
      }
      await load();
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, load]);

  if (checkingSession) {
    return <LoadingScreen />;
  }

  if (!asset) {
    return <FormError>{loadError ?? "Aset gak ditemukan."}</FormError>;
  }

  const findAccount = (accId: string) => accounts.find((a) => a.id === accId);
  const assetAccount = findAccount(asset.asset_account_id);
  const accumAccount = findAccount(asset.accumulated_depreciation_account_id);

  const accumulated = entries.reduce((sum, e) => sum + e.amount, 0);
  const bookValue = asset.acquisition_cost - accumulated;

  const disposeProceedsNum = Number(disposeProceeds) || 0;
  const disposeGainLoss = disposeProceedsNum - bookValue;
  const disposeProceedsAccount = resolveCashAccount(disposeCashMethod, defaultAccounts);
  const disposeGainAccount = defaultAccounts["fixed_assets.disposal_gain"];
  const disposeLossAccount = defaultAccounts["fixed_assets.disposal_loss"];

  async function handleDispose(e: FormEvent) {
    e.preventDefault();
    setDisposeError(null);

    const proceedsAmount = Number(disposeProceeds) || 0;
    const proceedsAccount = resolveCashAccount(disposeCashMethod, defaultAccounts);
    const gainAccount = defaultAccounts["fixed_assets.disposal_gain"];
    const lossAccount = defaultAccounts["fixed_assets.disposal_loss"];

    const parsed = createFixedAssetDisposalSchema.safeParse({
      fixed_asset_id: id,
      disposal_date: disposeDate,
      disposal_type: disposeType,
      proceeds_amount: proceedsAmount,
      proceeds_account_id: proceedsAmount > 0 ? proceedsAccount?.id : undefined,
      gain_account_id: gainAccount?.id,
      loss_account_id: lossAccount?.id,
      notes: disposeNotes || undefined,
    });
    if (!parsed.success) {
      setDisposeError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setDisposing(true);
    let sourceRef: string;
    try {
      sourceRef = await generateDocumentNumber("fixed_asset_disposals");
    } catch (err) {
      setDisposing(false);
      setDisposeError(err instanceof Error ? err.message : "Gagal generate nomor dokumen");
      return;
    }
    const { error } = await supabase.rpc("create_fixed_asset_disposal", {
      p_fixed_asset_id: parsed.data.fixed_asset_id,
      p_disposal_date: parsed.data.disposal_date,
      p_disposal_type: parsed.data.disposal_type,
      p_source_ref: sourceRef,
      p_proceeds_amount: parsed.data.proceeds_amount,
      p_proceeds_account_id: parsed.data.proceeds_account_id ?? null,
      p_gain_account_id: parsed.data.gain_account_id ?? null,
      p_loss_account_id: parsed.data.loss_account_id ?? null,
      p_notes: parsed.data.notes ?? null,
    });
    setDisposing(false);
    if (error) {
      setDisposeError(error.message);
      return;
    }

    router.push(`/fixed-assets/${id}`);
  }

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href={`/fixed-assets/${id}`} label="Kembali ke Detail Aset Tetap" />

      <div>
        <h1 className="text-xl font-semibold text-black">Lepas Aset (Disposal)</h1>
        <p className="text-sm text-slate-500">
          Aset: {asset.name}. Aset ini berhenti dipakai selamanya — dijual, dibuang/rusak total, atau
          hilang. Nilai buku dihitung ulang otomatis ({bookValue.toLocaleString("id-ID")}) dan
          dibandingkan ke nilai jual buat nentuin laba/rugi pelepasan. Aksi ini gak bisa dibatalkan
          (koreksi cuma lewat jurnal pembalik).
        </p>
      </div>

      <form onSubmit={handleDispose} className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="dispose_type">Jenis Pelepasan</Label>
                <select
                  id="dispose_type"
                  className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  value={disposeType}
                  onChange={(e) => {
                    const next = e.target.value as (typeof disposalTypes)[number];
                    setDisposeType(next);
                    if (next !== "sold") setDisposeProceeds("0");
                  }}
                >
                  {disposalTypes.map((t) => (
                    <option key={t} value={t}>
                      {disposalTypeLabels[t]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="dispose_date">Tanggal Disposal</Label>
                <Input
                  id="dispose_date"
                  type="date"
                  value={disposeDate}
                  onChange={(e) => setDisposeDate(e.target.value)}
                />
              </div>
              {disposeType === "sold" ? (
                <>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="dispose_proceeds">Nilai Jual</Label>
                    <Input
                      id="dispose_proceeds"
                      type="number"
                      min="0"
                      value={disposeProceeds}
                      onChange={(e) => setDisposeProceeds(e.target.value)}
                    />
                  </div>
                  <CashMethodField
                    label="Diterima Sebagai"
                    htmlFor="dispose_cash_method"
                    method={disposeCashMethod}
                    onChange={setDisposeCashMethod}
                    defaultAccounts={defaultAccounts}
                  />
                </>
              ) : (
                <FormHint>
                  {disposeType === "scrapped"
                    ? "Dibuang/rusak total — gak ada uang masuk (nilai jual Rp0). Seluruh nilai buku diakui sebagai rugi pelepasan."
                    : "Hilang/dicuri — gak ada uang masuk (nilai jual Rp0). Seluruh nilai buku diakui sebagai rugi pelepasan."}
                </FormHint>
              )}
              <LockedAccountField htmlFor="dispose_gain_account" resolved={disposeGainAccount} />
              <LockedAccountField htmlFor="dispose_loss_account" resolved={disposeLossAccount} />
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="dispose_notes">Catatan (opsional)</Label>
                <Input
                  id="dispose_notes"
                  value={disposeNotes}
                  onChange={(e) => setDisposeNotes(e.target.value)}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4 lg:sticky lg:top-4 lg:col-span-1 lg:self-start">
          <JournalPreviewPanel
            groups={[
              [
                accumulated > 0 && {
                  label: "Akumulasi Penyusutan (debit)",
                  resolved: accumAccount,
                  side: "debit",
                },
                { label: "Aset Tetap (kredit)", resolved: assetAccount, side: "credit" },
                disposeProceedsNum > 0 && {
                  label: "Akun Kas/Bank (debit)",
                  resolved: disposeProceedsAccount,
                  side: "debit",
                },
                disposeGainLoss > 0 && {
                  label: "Laba Pelepasan Aset Tetap (kredit)",
                  resolved: disposeGainAccount,
                  side: "credit",
                },
                disposeGainLoss < 0 && {
                  label: "Rugi Pelepasan Aset Tetap (debit)",
                  resolved: disposeLossAccount,
                  side: "debit",
                },
              ],
            ]}
          />

          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <p className="text-sm text-slate-500">Laba/Rugi Pelepasan</p>
            <p
              className={`mt-1 font-mono text-2xl ${
                disposeGainLoss > 0 ? "text-emerald-600" : disposeGainLoss < 0 ? "text-red-600" : "text-slate-900"
              }`}
            >
              {disposeGainLoss === 0 ? "Rp0" : `Rp${Math.abs(disposeGainLoss).toLocaleString("id-ID")}`}
            </p>
            <p className="mt-1 text-xs text-slate-400">
              {disposeGainLoss > 0 && "Laba pelepasan"}
              {disposeGainLoss < 0 && "Rugi pelepasan"}
              {disposeGainLoss === 0 && "Gak ada laba/rugi pelepasan"}
            </p>
          </div>

          {disposeError && <FormError>{disposeError}</FormError>}

          <div className="flex flex-col gap-2">
            <Button type="submit" disabled={disposing}>
              {disposing ? "Memproses..." : "Lepas Aset"}
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
