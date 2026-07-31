"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import type { Account } from "@/lib/accounts/schema";
import type { FixedAsset, DepreciationEntry } from "@/lib/fixed-assets/schema";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";

export function FixedAssetDetailView({ id }: { id: string }) {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [asset, setAsset] = useState<FixedAsset | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [entries, setEntries] = useState<DepreciationEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [{ data: fa, error: faErr }, { data: acc }, { data: de, error: deErr }] = await Promise.all([
      supabase
        .from("fixed_assets")
        .select(
          "id, name, asset_account_id, accumulated_depreciation_account_id, depreciation_expense_account_id, acquisition_cost, salvage_value, useful_life_months, acquisition_date, depreciation_method, depreciation_rate, archived_at"
        )
        .eq("id", id)
        .single(),
      supabase.from("accounts").select("id, code, name, category, normal_balance, is_contra, parent_id, archived_at"),
      supabase
        .from("depreciation_entries")
        .select("id, fixed_asset_id, period, amount, journal_entry_id, created_at")
        .eq("fixed_asset_id", id)
        .order("period"),
    ]);
    if (faErr) {
      setLoadError(faErr.message);
      return;
    }
    setLoadError(deErr?.message ?? null);
    setAsset(fa as FixedAsset);
    setAccounts((acc ?? []) as Account[]);
    setEntries((de ?? []) as DepreciationEntry[]);
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
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  if (!asset) {
    return <FormError>{loadError ?? "Aset gak ditemukan."}</FormError>;
  }

  const findAccount = (accId: string) => accounts.find((a) => a.id === accId);
  const assetAccount = findAccount(asset.asset_account_id);
  const accumAccount = findAccount(asset.accumulated_depreciation_account_id);
  const expenseAccount = findAccount(asset.depreciation_expense_account_id);

  const cap = asset.acquisition_cost - asset.salvage_value;
  const rows = entries.reduce<(DepreciationEntry & { accumulated: number; bookValue: number })[]>(
    (acc, entry) => {
      const prevAccumulated = acc.length > 0 ? acc[acc.length - 1].accumulated : 0;
      const accumulated = prevAccumulated + entry.amount;
      return [
        ...acc,
        { ...entry, accumulated, bookValue: asset.acquisition_cost - accumulated },
      ];
    },
    []
  );
  const accumulated = rows.length > 0 ? rows[rows.length - 1].accumulated : 0;
  const bookValue = asset.acquisition_cost - accumulated;
  const isPublished = entries.length > 0;

  return (
    <div className="flex w-full max-w-4xl flex-1 flex-col gap-6">
      <BackLink href="/fixed-assets" label="Kembali ke Fixed Assets" />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-black">{asset.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
              {asset.depreciation_method === "straight_line"
                ? "Straight-Line"
                : `Declining Balance (${(asset.depreciation_rate! * 100).toFixed(0)}%)`}
            </span>
            {asset.archived_at && (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
                Diarsipkan
              </span>
            )}
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs uppercase text-slate-400">Nilai Buku</div>
          <div className="font-mono text-lg font-medium text-black">
            {bookValue.toLocaleString("id-ID")}
          </div>
          <div className="text-sm text-slate-500">
            Akumulasi {accumulated.toLocaleString("id-ID")} / cap {cap.toLocaleString("id-ID")}
          </div>
        </div>
      </div>

      {loadError && <FormError>{loadError}</FormError>}

      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        {isPublished && (
          <p className="mb-4 text-sm text-amber-600">
            🔒 Aset ini udah punya penyusutan — nilai perolehan/residu/umur manfaat/metode/akun
            terkunci (<code>fixed_assets_published_lock</code>). Cuma <code>name</code>/
            <code>archived_at</code> yang masih bisa diubah.
          </p>
        )}
        <dl className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="text-xs uppercase text-slate-400">Nilai Perolehan</dt>
            <dd className="font-mono text-black">{asset.acquisition_cost.toLocaleString("id-ID")}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-400">Nilai Residu</dt>
            <dd className="font-mono text-black">{asset.salvage_value.toLocaleString("id-ID")}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-400">Umur Manfaat</dt>
            <dd className="text-black">{asset.useful_life_months} bulan</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-400">Tanggal Akuisisi</dt>
            <dd className="text-black">{asset.acquisition_date}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-400">Akun Aset Tetap</dt>
            <dd className="text-black">
              {assetAccount ? `${assetAccount.code} — ${assetAccount.name}` : "-"}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-400">Akun Akumulasi Penyusutan</dt>
            <dd className="text-black">
              {accumAccount ? `${accumAccount.code} — ${accumAccount.name}` : "-"}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-400">Akun Beban Penyusutan</dt>
            <dd className="text-black">
              {expenseAccount ? `${expenseAccount.code} — ${expenseAccount.name}` : "-"}
            </dd>
          </div>
        </dl>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-4 py-2">
          <span className="text-sm font-medium text-black">Histori Penyusutan</span>
          <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
            {entries.length}
          </span>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Periode</th>
              <th className="px-4 py-2 text-right">Jumlah</th>
              <th className="px-4 py-2 text-right">Akumulasi</th>
              <th className="px-4 py-2 text-right">Nilai Buku</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-slate-100 hover:bg-slate-50">
                <td className="whitespace-nowrap px-4 py-2">{row.period}</td>
                <td className="px-4 py-2 text-right font-mono">{row.amount.toLocaleString("id-ID")}</td>
                <td className="px-4 py-2 text-right font-mono">{row.accumulated.toLocaleString("id-ID")}</td>
                <td className="px-4 py-2 text-right font-mono font-medium">
                  {row.bookValue.toLocaleString("id-ID")}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-slate-400">
                  Belum ada penyusutan diposting.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
