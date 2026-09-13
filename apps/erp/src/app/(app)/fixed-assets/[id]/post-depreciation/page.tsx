"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { postDepreciationSchema, type FixedAsset } from "@/lib/fixed-assets/schema";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormError, FormHint } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { LoadingScreen } from "@/components/ui/loading-screen";

export default function PostDepreciationPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [asset, setAsset] = useState<FixedAsset | null>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [postPeriod, setPostPeriod] = useState("");
  const [postOverride, setPostOverride] = useState("");
  const [postError, setPostError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);

  const load = useCallback(async () => {
    const { data: fa, error: faErr } = await supabase
      .from("fixed_assets")
      .select(
        "id, name, asset_account_id, accumulated_depreciation_account_id, depreciation_expense_account_id, acquisition_cost, salvage_value, useful_life_months, acquisition_date, depreciation_method, depreciation_rate, archived_at, disposed_at"
      )
      .eq("id", id)
      .single();
    if (faErr) {
      setLoadError(faErr.message);
      return;
    }
    setLoadError(null);
    setAsset(fa as FixedAsset);
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

    router.push(`/fixed-assets/${id}`);
  }

  if (checkingSession) {
    return <LoadingScreen />;
  }

  if (!asset) {
    return <FormError>{loadError ?? "Aset gak ditemukan."}</FormError>;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href={`/fixed-assets/${id}`} label="Kembali ke Detail Aset Tetap" />

      <div>
        <h1 className="text-xl font-semibold text-black">Posting Penyusutan</h1>
        <p className="text-sm text-slate-500">
          Aset: {asset.name}. Jumlah penyusutan dihitung otomatis sesuai metode aset ini (
          {asset.depreciation_method === "straight_line"
            ? "straight-line: nilai perolehan dibagi umur manfaat"
            : "declining balance: nilai buku dikali tarif"}
          ) — biasanya gak perlu isi apapun selain periode & rujukan dokumen.
        </p>
      </div>

      {!canWrite && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-700">
          Kamu belum punya role admin/accountant — submit di bawah kemungkinan bakal ketolak RLS.
        </p>
      )}

      <form onSubmit={handlePost} className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4 lg:sticky lg:top-4 lg:col-span-1 lg:self-start">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-6">
            <p className="mb-2.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Soal Jumlah Manual
            </p>
            <FormHint>
              Isi kolom &quot;Jumlah Manual&quot; cuma kalau ini periode TERAKHIR aset declining
              balance & mau dipotong biar nilai buku pas berhenti di nilai residu (lihat catatan
              teknis di <code>docs/domain/human/fixed-assets.md</code>). Selain itu, selalu
              kosongkan.
            </FormHint>
          </div>

          {postError && <FormError>{postError}</FormError>}

          <div className="flex flex-col gap-2">
            <Button type="submit" disabled={posting}>
              {posting ? "Memproses..." : "Posting"}
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
