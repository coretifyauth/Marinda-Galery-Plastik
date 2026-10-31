"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import { poolDepositLimit, useBillAdjustments, usePoolReleases, type ApBillPool } from "@/lib/ap-bills/pool";
import { useGoodsReceiptsForBill } from "@/lib/goods-receipts/queries";
import { receiptNumber } from "@/lib/goods-receipts/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormError } from "@/components/ui/form-message";
import { CancelledBadge } from "@/components/ui/cancelled";
import { AdjustBillModal } from "@/components/ap-bills/adjust-bill-modal";

const rp = (n: number) => `Rp${n.toLocaleString("id-ID", { maximumFractionDigits: 2 })}`;

type ReleaseKind = "pembulatan" | "uang_muka";

/**
 * Bagian "Kolam Barang" di detail tagihan barang: nilai barang di nota yang menunggu barang masuk. Menampilkan sisa
 * kolam, barang masuk yang sudah dibuat dari tagihan ini, pelepasan sisa (pembulatan / uang muka), dan form pelepasan.
 * Alokasi barang masuk ke kolam gak berjurnal sendiri -- lihat docs/domain/accounts-payable.md.
 */
export function GoodsPoolSection({
  billId,
  billAmount,
  pool,
  paid,
  outstanding,
  canWrite,
  isCancelled,
  onChanged,
}: {
  billId: string;
  billAmount: number;
  pool: ApBillPool;
  /** Uang yang sudah dibayar ke tagihan ini: pembayaran kas/bank + uang muka yang diterapkan. */
  paid: number;
  /** Sisa utang tagihan -- batas penurunan Koreksi Tagihan. */
  outstanding: number;
  canWrite: boolean;
  isCancelled: boolean;
  onChanged: () => void | Promise<void>;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const receiptsQuery = useGoodsReceiptsForBill(billId);
  const releasesQuery = usePoolReleases(billId);
  const receipts = receiptsQuery.data ?? [];
  const releases = releasesQuery.data ?? [];
  const adjustments = useBillAdjustments(billId).data ?? [];
  const [showAdjust, setShowAdjust] = useState(false);

  const [showRelease, setShowRelease] = useState(false);
  const [kind, setKind] = useState<ReleaseKind>("uang_muka");
  const [amount, setAmount] = useState("");
  const [releaseDate, setReleaseDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [confirmed, setConfirmed] = useState(false);
  const [bankUnit, setBankUnit] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    supabase
      .from("app_settings")
      .select("rounding_unit_bank")
      .maybeSingle()
      .then(({ data }) => {
        const unit = (data as { rounding_unit_bank?: number } | null)?.rounding_unit_bank;
        if (unit && unit > 0) setBankUnit(unit);
      });
  }, []);

  const releasedAsDeposit = releases.filter((r) => r.kind === "uang_muka").reduce((s, r) => s + r.amount, 0);
  const depositLimit = poolDepositLimit({ billAmount, pool, paid, releasedAsDeposit });
  const canRoundOff = pool.remaining > 0 && pool.remaining < bankUnit;
  const open = !isCancelled && pool.remaining > 0.005;
  const progress = pool.pool_amount > 0 ? Math.min(100, ((pool.received_value + pool.released_amount) / pool.pool_amount) * 100) : 0;

  function openRelease(nextKind: ReleaseKind) {
    setKind(nextKind);
    setAmount(String(nextKind === "pembulatan" ? pool.remaining : depositLimit));
    setConfirmed(false);
    setError(null);
    setShowRelease(true);
  }

  async function handleRelease(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const value = parseFloat(amount);
    if (!(value > 0)) return setError("Nominal penutupan harus lebih dari 0");
    if (!releaseDate) return setError("Tanggal wajib diisi");
    if (!confirmed) return setError("Centang konfirmasi dulu -- penutupan sisa barang tidak bisa dibatalkan");
    setSubmitting(true);
    const { error: rpcError } = await supabase.rpc("release_ap_bill_pool", {
      p_bill_id: billId,
      p_kind: kind,
      p_amount: value,
      p_release_date: releaseDate,
      p_source_ref: null,
    });
    setSubmitting(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    setShowRelease(false);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["ap_bill_pool", billId] }),
      queryClient.invalidateQueries({ queryKey: ["ap_bill_pool_releases", billId] }),
      queryClient.invalidateQueries({ queryKey: ["open_pool_bills"] }),
      queryClient.invalidateQueries({ queryKey: ["ap_deposits"] }),
    ]);
    await onChanged();
  }

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium text-black">Barang Belum Diterima</h2>
          {pool.open_age_days != null && pool.open_age_days > 0 && (
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700">
              terbuka {pool.open_age_days} hari
            </span>
          )}
        </div>
        {canWrite && !isCancelled && (
          <div className="flex items-center gap-2">
            {open && (
              <>
                <Button variant="toolbar-primary" onClick={() => router.push(`/goods-receipts/new?bill=${billId}`)}>
                  + Catat Barang Masuk
                </Button>
                <Button variant="toolbar" onClick={() => openRelease(canRoundOff ? "pembulatan" : "uang_muka")}>
                  Tutup Sisa Barang
                </Button>
              </>
            )}
            <Button variant="toolbar" onClick={() => setShowAdjust(true)}>
              Koreksi Tagihan
            </Button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div>
          <p className="text-xs text-slate-500">Nilai barang di nota</p>
          <p className="font-mono text-black">{rp(pool.pool_amount)}</p>
        </div>
        <div>
          <p className="text-xs text-slate-500">Sudah diterima</p>
          <p className="font-mono text-black">{rp(pool.received_value)}</p>
        </div>
        <div>
          <p className="text-xs text-slate-500">Ditutup</p>
          <p className="font-mono text-black">{rp(pool.released_amount)}</p>
        </div>
        <div>
          <p className="text-xs text-slate-500">Belum diterima</p>
          <p className="font-mono font-medium text-black">{rp(pool.remaining)}</p>
        </div>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100" aria-hidden>
        <div className="h-full bg-emerald-500" style={{ width: `${progress}%` }} />
      </div>
      <p className="text-xs text-slate-500">
        Nilai barang di nota berkurang setiap kali barang masuk dicatat dari tagihan ini. Status bayar tagihan tidak mempengaruhinya.
        Sisa yang barangnya tidak akan datang bisa ditutup: receh jadi selisih pembulatan, bagian yang sudah dibayar
        jadi uang muka ke supplier. Sisa yang belum dibayar diturunkan lewat Koreksi Tagihan.
      </p>

      {showRelease && (
        <form onSubmit={handleRelease} className="flex flex-col gap-3 rounded-lg border border-amber-200 bg-amber-50/50 p-4">
          <p className="text-sm font-medium text-black">Tutup Sisa Barang</p>
          <div className="flex flex-wrap gap-4 text-sm">
            <label className={`flex items-center gap-2 ${canRoundOff ? "" : "opacity-40"}`}>
              <input
                type="radio"
                name="kind"
                checked={kind === "pembulatan"}
                disabled={!canRoundOff}
                onChange={() => openRelease("pembulatan")}
              />
              Pembulatan (sisa kurang dari Rp{bankUnit.toLocaleString("id-ID")})
            </label>
            <label className={`flex items-center gap-2 ${depositLimit > 0 ? "" : "opacity-40"}`}>
              <input
                type="radio"
                name="kind"
                checked={kind === "uang_muka"}
                disabled={depositLimit <= 0}
                onChange={() => openRelease("uang_muka")}
              />
              Jadikan Uang Muka (maksimal {rp(depositLimit)} — bagian yang sudah dibayar dan belum terpakai)
            </label>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="release_amount">Nominal (Rp)</Label>
              <Input
                id="release_amount"
                type="number"
                min="0"
                step="0.01"
                value={amount}
                readOnly={kind === "pembulatan"}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="release_date">Tanggal</Label>
              <Input id="release_date" type="date" value={releaseDate} onChange={(e) => setReleaseDate(e.target.value)} />
            </div>
          </div>
          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input type="checkbox" className="mt-1" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            Saya mengerti penutupan sisa barang tidak bisa dibatalkan, dan tagihan ini tidak bisa dibatalkan lagi sesudahnya.
          </label>
          {error && <FormError>{error}</FormError>}
          <div className="flex gap-2">
            <Button type="submit" disabled={submitting}>
              {submitting ? "Memproses..." : "Tutup Sisa Barang"}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setShowRelease(false)}>
              Batal
            </Button>
          </div>
        </form>
      )}

      <div className="overflow-x-auto">
        <p className="mb-2 text-xs font-medium uppercase text-slate-500">Barang Masuk dari Tagihan Ini</p>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-3 py-2">Nomor</th>
              <th className="px-3 py-2">Tanggal</th>
              <th className="px-3 py-2">No. Surat Jalan</th>
              <th className="px-3 py-2 text-right">Nilai</th>
              <th className="px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {receipts.map((g) => (
              <tr
                key={g.id}
                className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                onClick={() => router.push(`/goods-receipts/${g.id}`)}
              >
                <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-slate-600">{receiptNumber(g)}</td>
                <td className="whitespace-nowrap px-3 py-2">{g.note_date}</td>
                <td className="px-3 py-2 text-slate-500">{g.delivery_note_ref ?? "—"}</td>
                <td className="px-3 py-2 text-right font-mono">{rp(g.total_value)}</td>
                <td className="px-3 py-2">
                  {g.status === "dibatalkan" ? (
                    <CancelledBadge />
                  ) : (
                    <span className="rounded-full bg-green-50 px-2 py-0.5 text-xs text-green-700">Aktif</span>
                  )}
                </td>
              </tr>
            ))}
            {receipts.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-center text-slate-400">
                  {receiptsQuery.isLoading ? "Memuat..." : "Belum ada barang masuk dari tagihan ini."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {adjustments.length > 0 && (
        <div className="overflow-x-auto">
          <p className="mb-2 text-xs font-medium uppercase text-slate-500">Riwayat Koreksi Tagihan</p>
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
                <th className="px-3 py-2">Tanggal</th>
                <th className="px-3 py-2">Rujukan</th>
                <th className="px-3 py-2">Alasan</th>
                <th className="px-3 py-2 text-right">Nominal</th>
              </tr>
            </thead>
            <tbody>
              {adjustments.map((a) => (
                <tr key={a.id} className="border-b border-slate-100">
                  <td className="whitespace-nowrap px-3 py-2">{a.adjustment_date}</td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-600">
                    {a.source_ref}
                    {a.supplier_document_ref && <span className="ml-1 font-sans text-slate-400">({a.supplier_document_ref})</span>}
                  </td>
                  <td className="px-3 py-2 text-slate-600">{a.reason}</td>
                  <td className="px-3 py-2 text-right font-mono">
                    {a.amount > 0 ? "+" : ""}
                    {rp(a.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {releases.length > 0 && (
        <div className="overflow-x-auto">
          <p className="mb-2 text-xs font-medium uppercase text-slate-500">Riwayat Penutupan Sisa</p>
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
                <th className="px-3 py-2">Tanggal</th>
                <th className="px-3 py-2">Jenis</th>
                <th className="px-3 py-2">Rujukan</th>
                <th className="px-3 py-2 text-right">Nominal</th>
              </tr>
            </thead>
            <tbody>
              {releases.map((r) => (
                <tr key={r.id} className="border-b border-slate-100">
                  <td className="whitespace-nowrap px-3 py-2">{r.release_date}</td>
                  <td className="px-3 py-2">
                    {r.kind === "pembulatan" ? "Pembulatan" : "Uang muka"}
                    {r.deposit_id && (
                      <button
                        type="button"
                        className="ml-2 text-xs text-blue-600 hover:underline"
                        onClick={() => router.push(`/ap-deposits/${r.deposit_id}`)}
                      >
                        lihat uang muka
                      </button>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-600">{r.source_ref}</td>
                  <td className="px-3 py-2 text-right font-mono">{rp(r.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AdjustBillModal
        billId={billId}
        open={showAdjust}
        remainingGoods={pool.remaining}
        outstanding={outstanding}
        onClose={() => setShowAdjust(false)}
        onDone={onChanged}
      />
    </div>
  );
}
