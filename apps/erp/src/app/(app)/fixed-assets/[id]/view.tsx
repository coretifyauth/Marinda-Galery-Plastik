"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import type { Account } from "@/lib/accounts/schema";
import {
  postDepreciationSchema,
  createFixedAssetDisposalSchema,
  disposalTypes,
  disposalTypeLabels,
  type FixedAsset,
  type DepreciationEntry,
  type FixedAssetDisposal,
} from "@/lib/fixed-assets/schema";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormError, FormHint } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { Modal } from "@/components/ui/modal";
import { DetailRows } from "@/components/ui/detail-rows";
import { LockedAccountField } from "@/components/ui/locked-account-field";
import { JournalPreviewPanel } from "@/components/ui/journal-preview-panel";
import { CashMethodField, resolveCashAccount, type CashMethod } from "@/components/ui/cash-method-field";
import { fetchDefaultAccounts, type ResolvedAccount } from "@/lib/default-accounts/schema";

export function FixedAssetDetailView({ id }: { id: string }) {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [asset, setAsset] = useState<FixedAsset | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [entries, setEntries] = useState<DepreciationEntry[]>([]);
  const [disposal, setDisposal] = useState<FixedAssetDisposal | null>(null);
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [showPostForm, setShowPostForm] = useState(false);
  const [postPeriod, setPostPeriod] = useState("");
  const [postOverride, setPostOverride] = useState("");
  const [postError, setPostError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);

  const [showDisposeForm, setShowDisposeForm] = useState(false);
  const [disposeDate, setDisposeDate] = useState("");
  const [disposeType, setDisposeType] = useState<(typeof disposalTypes)[number]>("sold");
  const [disposeProceeds, setDisposeProceeds] = useState("0");
  const [disposeCashMethod, setDisposeCashMethod] = useState<CashMethod>("TUNAI");
  const [disposeNotes, setDisposeNotes] = useState("");
  const [disposeError, setDisposeError] = useState<string | null>(null);
  const [disposing, setDisposing] = useState(false);

  const load = useCallback(async () => {
    const [{ data: fa, error: faErr }, { data: acc }, { data: de, error: deErr }, { data: disp }, defAcc] =
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
        fetchDefaultAccounts(),
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
    setDefaultAccounts(defAcc);
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
      amount_override: postOverride || undefined,
    });
    if (!parsed.success) {
      setPostError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setPosting(true);
    let sourceRef: string;
    try {
      sourceRef = await generateDocumentNumber("depreciation_entries");
    } catch (err) {
      setPosting(false);
      setPostError(err instanceof Error ? err.message : "Gagal generate nomor dokumen");
      return;
    }
    const { error } = await supabase.rpc("post_depreciation", {
      p_fixed_asset_id: parsed.data.fixed_asset_id,
      p_period: parsed.data.period,
      p_source_ref: sourceRef,
      p_amount_override: parsed.data.amount_override ?? null,
    });
    setPosting(false);
    if (error) {
      setPostError(error.message);
      return;
    }

    setShowPostForm(false);
    setPostPeriod("");
    setPostOverride("");
    await load();
  }

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

    setShowDisposeForm(false);
    setDisposeDate("");
    setDisposeProceeds("0");
    setDisposeNotes("");
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

  const disposeProceedsNum = Number(disposeProceeds) || 0;
  const disposeGainLoss = disposeProceedsNum - bookValue;
  const disposeProceedsAccount = resolveCashAccount(disposeCashMethod, defaultAccounts);
  const disposeGainAccount = defaultAccounts["fixed_assets.disposal_gain"];
  const disposeLossAccount = defaultAccounts["fixed_assets.disposal_loss"];

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
      <BackLink href="/fixed-assets" label="Kembali ke Fixed Assets" />
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-black">Fixed Asset Details</h1>
      </div>

      {loadError && <FormError>{loadError}</FormError>}

      <Modal open={showPostForm} onClose={() => setShowPostForm(false)} title="Posting Penyusutan">
        <p className="mb-3 text-sm text-slate-500">
          Jumlah penyusutan dihitung otomatis sesuai metode aset ini (
          {asset.depreciation_method === "straight_line"
            ? "straight-line: nilai perolehan dibagi umur manfaat"
            : "declining balance: nilai buku dikali tarif"}
          ) — biasanya gak perlu isi apapun selain periode & rujukan dokumen.
        </p>
        <form onSubmit={handlePost} className="flex flex-col gap-4">
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
          <FormHint>
            Isi kolom &quot;Jumlah Manual&quot; cuma kalau ini periode TERAKHIR aset declining
            balance & mau dipotong biar nilai buku pas berhenti di nilai residu (lihat catatan
            teknis di <code>docs/domain/human/fixed-assets.md</code>). Selain itu, selalu
            kosongkan.
          </FormHint>
          {postError && <FormError>{postError}</FormError>}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setShowPostForm(false)}>
              Batal
            </Button>
            <Button type="submit" disabled={posting}>
              {posting ? "Memproses..." : "Post"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal open={showDisposeForm} onClose={() => setShowDisposeForm(false)} title="Lepas Aset (Disposal)">
        <p className="mb-4 text-sm text-slate-500">
          Aset ini berhenti dipakai selamanya — dijual, dibuang/rusak total, atau hilang. Nilai
          buku dihitung ulang otomatis ({bookValue.toLocaleString("id-ID")}) dan dibandingkan ke
          nilai jual buat nentuin laba/rugi pelepasan. Aksi ini gak bisa dibatalkan (koreksi cuma
          lewat jurnal pembalik).
        </p>
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
        <form onSubmit={handleDispose} className="mt-4 flex flex-col gap-4">
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
          <p
            className={`text-sm font-medium ${
              disposeGainLoss > 0 ? "text-emerald-600" : disposeGainLoss < 0 ? "text-red-600" : "text-slate-500"
            }`}
          >
            {disposeGainLoss > 0 && `Laba pelepasan: ${disposeGainLoss.toLocaleString("id-ID")}`}
            {disposeGainLoss < 0 && `Rugi pelepasan: ${Math.abs(disposeGainLoss).toLocaleString("id-ID")}`}
            {disposeGainLoss === 0 && "Gak ada laba/rugi pelepasan"}
          </p>
          {disposeError && <FormError>{disposeError}</FormError>}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setShowDisposeForm(false)}>
              Batal
            </Button>
            <Button type="submit" disabled={disposing}>
              {disposing ? "Memproses..." : "Lepas Aset"}
            </Button>
          </div>
        </form>
      </Modal>

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
          <Button variant="secondary" onClick={() => setShowDisposeForm(true)}>
            Lepas Aset
          </Button>
          <Button variant="toolbar" onClick={() => setShowPostForm(true)}>
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
