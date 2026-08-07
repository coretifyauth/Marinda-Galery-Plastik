"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import type { Account } from "@/lib/accounts/schema";
import { postDepreciationSchema, type FixedAsset, type DepreciationEntry } from "@/lib/fixed-assets/schema";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormError, FormHint } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";

export function FixedAssetDetailView({ id }: { id: string }) {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [asset, setAsset] = useState<FixedAsset | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [entries, setEntries] = useState<DepreciationEntry[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [showPostForm, setShowPostForm] = useState(false);
  const [postPeriod, setPostPeriod] = useState("");
  const [postSourceRef, setPostSourceRef] = useState("");
  const [postOverride, setPostOverride] = useState("");
  const [postError, setPostError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);

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

  async function handlePost(e: FormEvent) {
    e.preventDefault();
    setPostError(null);

    const parsed = postDepreciationSchema.safeParse({
      fixed_asset_id: id,
      period: postPeriod,
      source_ref: postSourceRef,
      amount_override: postOverride || undefined,
    });
    if (!parsed.success) {
      setPostError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setPosting(true);
    const { error } = await supabase.rpc("post_depreciation", {
      p_fixed_asset_id: parsed.data.fixed_asset_id,
      p_period: parsed.data.period,
      p_source_ref: parsed.data.source_ref,
      p_amount_override: parsed.data.amount_override ?? null,
    });
    setPosting(false);
    if (error) {
      setPostError(error.message);
      return;
    }

    setShowPostForm(false);
    setPostPeriod("");
    setPostSourceRef("");
    setPostOverride("");
    await load();
  }

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
  const canWrite = roles.includes("admin") || roles.includes("accountant");

  return (
    <div className="flex w-full max-w-4xl flex-1 flex-col gap-6">
      <BackLink href="/fixed-assets" label="Kembali ke Fixed Assets" />
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold text-black">{asset.name}</h1>
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
        <div className="flex items-start gap-4">
          <div className="text-right">
            <div className="text-xs uppercase text-slate-400">Nilai Buku</div>
            <div className="font-mono text-lg font-medium text-black">
              {bookValue.toLocaleString("id-ID")}
            </div>
            <div className="text-sm text-slate-500">
              Akumulasi {accumulated.toLocaleString("id-ID")} / cap {cap.toLocaleString("id-ID")}
            </div>
          </div>
          {canWrite && (
            <Button variant="toolbar" onClick={() => setShowPostForm((v) => !v)}>
              {showPostForm ? "Batal" : "Posting Penyusutan"}
            </Button>
          )}
        </div>
      </div>

      {loadError && <FormError>{loadError}</FormError>}

      {showPostForm && (
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="mb-3 text-sm text-slate-500">
            Jumlah penyusutan dihitung otomatis sesuai metode aset ini (
            {asset.depreciation_method === "straight_line"
              ? "straight-line: nilai perolehan dibagi umur manfaat"
              : "declining balance: nilai buku dikali tarif"}
            ) — biasanya gak perlu isi apapun selain periode & rujukan dokumen.
          </p>
          <form onSubmit={handlePost} className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="post_period">Periode</Label>
              <Input
                id="post_period"
                type="date"
                value={postPeriod}
                onChange={(e) => setPostPeriod(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="post_source_ref">Rujukan dokumen</Label>
              <Input
                id="post_source_ref"
                placeholder="mis. PENYST-OVEN-2026-01"
                value={postSourceRef}
                onChange={(e) => setPostSourceRef(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="post_override">Jumlah Manual (jarang dipakai)</Label>
              <Input
                id="post_override"
                type="number"
                min="0"
                placeholder="kosongkan — biarkan dihitung otomatis"
                value={postOverride}
                onChange={(e) => setPostOverride(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={posting}>
              {posting ? "Memproses..." : "Post"}
            </Button>
          </form>
          <FormHint>
            Isi kolom &quot;Jumlah Manual&quot; cuma kalau ini periode TERAKHIR aset declining
            balance & mau dipotong biar nilai buku pas berhenti di nilai residu (lihat catatan
            teknis di <code>docs/domain/human/fixed-assets.md</code>). Selain itu, selalu
            kosongkan.
          </FormHint>
          {postError && (
            <div className="mt-2">
              <FormError>{postError}</FormError>
            </div>
          )}
        </div>
      )}

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
