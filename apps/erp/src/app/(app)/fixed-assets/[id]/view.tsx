"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import type { Account } from "@/lib/accounts/schema";
import { disposalTypeLabels, type FixedAsset, type DepreciationEntry, type FixedAssetDisposal } from "@/lib/fixed-assets/schema";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { DetailRows } from "@/components/ui/detail-rows";
import { LoadingScreen } from "@/components/ui/loading-screen";

export function FixedAssetDetailView({ id }: { id: string }) {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [asset, setAsset] = useState<FixedAsset | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [entries, setEntries] = useState<DepreciationEntry[]>([]);
  const [disposal, setDisposal] = useState<FixedAssetDisposal | null>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [{ data: fa, error: faErr }, { data: acc }, { data: de, error: deErr }, { data: disp }] =
      await Promise.all([
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
        supabase
          .from("fixed_asset_disposals")
          .select(
            "id, fixed_asset_id, disposal_date, disposal_type, proceeds_amount, proceeds_account_id, book_value_at_disposal, gain_loss_amount, gain_loss_account_id, journal_entry_id, notes, created_at"
          )
          .eq("fixed_asset_id", id)
          .maybeSingle(),
      ]);
    if (faErr) {
      setLoadError(faErr.message);
      return;
    }
    setLoadError(deErr?.message ?? null);
    setAsset(fa as FixedAsset);
    setAccounts((acc ?? []) as Account[]);
    setEntries((de ?? []) as DepreciationEntry[]);
    setDisposal((disp as FixedAssetDisposal | null) ?? null);
  }, [id]);

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
  const canWrite = roles.includes("admin") || roles.includes("accountant");

  const detailGroups = [
    {
      title: "Informasi Aset",
      rows: [
        { label: "Nama", value: asset.name },
        {
          label: "Metode Penyusutan",
          value: (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
              {asset.depreciation_method === "straight_line"
                ? "Straight-Line"
                : `Declining Balance (${(asset.depreciation_rate! * 100).toFixed(0)}%)`}
            </span>
          ),
        },
        { label: "Nilai Perolehan", value: asset.acquisition_cost.toLocaleString("id-ID") },
        { label: "Nilai Residu", value: asset.salvage_value.toLocaleString("id-ID") },
        { label: "Umur Manfaat", value: `${asset.useful_life_months} bulan` },
        { label: "Tanggal Akuisisi", value: asset.acquisition_date },
        { label: "Akun Aset Tetap", value: assetAccount ? `${assetAccount.code} — ${assetAccount.name}` : "-" },
        {
          label: "Akun Akumulasi Penyusutan",
          value: accumAccount ? `${accumAccount.code} — ${accumAccount.name}` : "-",
        },
        {
          label: "Akun Beban Penyusutan",
          value: expenseAccount ? `${expenseAccount.code} — ${expenseAccount.name}` : "-",
        },
        {
          label: "Status",
          value: asset.disposed_at ? "Sudah Dilepas (Disposal)" : asset.archived_at ? "Diarsipkan" : "Aktif",
        },
      ],
    },
    {
      title: "Ringkasan",
      rows: [
        { label: "Nilai Buku", value: bookValue.toLocaleString("id-ID") },
        { label: "Akumulasi", value: accumulated.toLocaleString("id-ID") },
        { label: "Cap (Perolehan − Residu)", value: cap.toLocaleString("id-ID") },
      ],
    },
  ];

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/fixed-assets" label="Kembali ke Aset Tetap" />
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-black">Detail Aset Tetap</h1>
      </div>

      {loadError && <FormError>{loadError}</FormError>}

      {asset.disposed_at && disposal && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <p className="text-sm font-medium text-black">
            🗑 Aset ini sudah di-disposal ({disposalTypeLabels[disposal.disposal_type]})
          </p>
          <p className="mt-1 text-sm text-slate-600">
            Tanggal: {disposal.disposal_date} · Nilai Buku Saat Itu:{" "}
            {disposal.book_value_at_disposal.toLocaleString("id-ID")} · Nilai Jual:{" "}
            {disposal.proceeds_amount.toLocaleString("id-ID")} ·{" "}
            {disposal.gain_loss_amount >= 0 ? "Laba" : "Rugi"}:{" "}
            {Math.abs(disposal.gain_loss_amount).toLocaleString("id-ID")}
          </p>
          {disposal.notes && <p className="mt-1 text-sm text-slate-500">Catatan: {disposal.notes}</p>}
        </div>
      )}

      {isPublished && !asset.disposed_at && (
        <p className="text-sm text-amber-600">
          🔒 Aset ini udah punya penyusutan — nilai perolehan/residu/umur manfaat/metode/akun
          terkunci (<code>fixed_assets_published_lock</code>). Cuma <code>name</code>/
          <code>archived_at</code> yang masih bisa diubah.
        </p>
      )}

      <DetailRows groups={detailGroups} />

      {canWrite && !asset.disposed_at && (
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => router.push(`/fixed-assets/${id}/dispose`)}>
            Lepas Aset
          </Button>
          <Button variant="toolbar" onClick={() => router.push(`/fixed-assets/${id}/post-depreciation`)}>
            Posting Penyusutan
          </Button>
        </div>
      )}

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
