"use client";

import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  changePct,
  getSalesPurchaseMonthly,
  sumSalesPurchase,
  type SalesPurchaseMonth,
} from "@/lib/reports/sales-purchase";
import { Input } from "@/components/ui/input";
import { FormError, FormHint } from "@/components/ui/form-message";
import { InlineSpinner } from "@/components/ui/loading-screen";

const TREND_MONTHS = 6;

const rp = (n: number) => `Rp${n.toLocaleString("id-ID", { maximumFractionDigits: 2 })}`;
const pct = (n: number) => `${n.toLocaleString("id-ID", { maximumFractionDigits: 1 })}%`;
const monthLabel = (ym: string) =>
  new Date(`${ym.slice(0, 7)}-01T00:00:00`).toLocaleDateString("id-ID", { month: "short", year: "numeric" });

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Geser "YYYY-MM" sebanyak `delta` bulan (aritmatika string, tanpa Date -- aman dari zona waktu). */
function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

function lastDay(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
}

function Delta({ current, previous, goodWhenUp = true }: { current: number; previous: number; goodWhenUp?: boolean }) {
  const change = changePct(current, previous);
  if (change === null) return <span className="text-xs text-slate-400">tanpa pembanding bulan lalu</span>;
  const up = change >= 0;
  const good = up === goodWhenUp;
  return (
    <span className={`text-xs ${Math.abs(change) < 0.05 ? "text-slate-500" : good ? "text-emerald-700" : "text-red-600"}`}>
      {up ? "▲" : "▼"} {pct(Math.abs(change))} vs bulan lalu
    </span>
  );
}

function Card({ label, value, hint, children }: { label: string; value: string; hint: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-sm font-medium text-slate-500">{label}</div>
      <div className="text-2xl font-semibold text-black">{value}</div>
      {children}
      <div className="mt-1 text-xs text-slate-500">{hint}</div>
    </div>
  );
}

function TrendChart({ months }: { months: SalesPurchaseMonth[] }) {
  const max = Math.max(1, ...months.flatMap((m) => [m.netSales, m.netPurchases]));
  const bar = (v: number) => `${Math.max(0, (v / max) * 100)}%`;
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-semibold text-black">Tren {months.length} Bulan</h2>
        <div className="flex gap-4 text-xs text-slate-600">
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-blue-600" /> Penjualan Bersih
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-amber-500" /> Pembelian Bersih
          </span>
        </div>
      </div>
      <div className="flex h-48 items-end gap-3">
        {months.map((m) => (
          <div key={m.month} className="flex h-full flex-1 flex-col justify-end gap-1">
            <div className="flex h-full items-end justify-center gap-1">
              <div
                className="w-full max-w-8 rounded-t bg-blue-600"
                style={{ height: bar(m.netSales) }}
                title={`Penjualan bersih ${monthLabel(m.month)}: ${rp(m.netSales)}`}
              />
              <div
                className="w-full max-w-8 rounded-t bg-amber-500"
                style={{ height: bar(m.netPurchases) }}
                title={`Pembelian bersih ${monthLabel(m.month)}: ${rp(m.netPurchases)}`}
              />
            </div>
            <div className="text-center text-xs text-slate-500">{monthLabel(m.month)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const [month, setMonth] = useState(currentMonth());

  // Ambil 1 bulan ekstra di depan supaya bulan terlama di tren tetap punya pembanding.
  const { data, error, isFetching } = useQuery({
    queryKey: ["dashboard_sales_purchase", month],
    queryFn: () => getSalesPurchaseMonthly(`${shiftMonth(month, -TREND_MONTHS)}-01`, lastDay(month)),
    enabled: /^\d{4}-\d{2}$/.test(month),
    staleTime: 30_000,
  });

  const trend = data?.slice(-TREND_MONTHS) ?? [];
  const current = data?.[data.length - 1];
  const previous = data && data.length >= 2 ? data[data.length - 2] : undefined;
  const total = trend.length > 0 ? sumSalesPurchase(trend) : null;

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-black">Dashboard Penjualan & Pembelian</h1>
          <FormHint>
            Dihitung dari invoice, POS, retur, dan barang masuk. Tanpa PPN, biaya tambahan, dan dokumen yang dibatalkan.
          </FormHint>
        </div>
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          Bulan
          <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-44" />
        </label>
      </div>

      {error && <FormError>{error instanceof Error ? error.message : "Gagal memuat dashboard"}</FormError>}
      {!data && isFetching && <InlineSpinner />}

      {current && (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Card
              label={`Penjualan Bersih — ${monthLabel(current.month)}`}
              value={rp(current.netSales)}
              hint={
                current.discount > 0 || current.salesReturn > 0
                  ? `Kotor ${rp(current.grossSales)} − diskon ${rp(current.discount)} − retur ${rp(current.salesReturn)}`
                  : "Barang terjual setelah diskon, tanpa PPN"
              }
            >
              {previous && <Delta current={current.netSales} previous={previous.netSales} />}
            </Card>
            <Card
              label="Laba Kotor"
              value={rp(current.grossProfit)}
              hint={current.marginPct != null ? `Margin ${pct(current.marginPct)} dari penjualan bersih` : "Belum ada penjualan bulan ini"}
            >
              {previous && <Delta current={current.grossProfit} previous={previous.grossProfit} />}
            </Card>
            <Card label="HPP" value={rp(current.hpp)} hint="Biaya pokok barang yang terjual (setelah retur)">
              {previous && <Delta current={current.hpp} previous={previous.hpp} goodWhenUp={false} />}
            </Card>
            <Card
              label="Pembelian Bersih"
              value={rp(current.netPurchases)}
              hint="Barang yang diterima bulan ini (setelah retur ke supplier). Menambah stok, bukan mengurangi laba."
            >
              {previous && <Delta current={current.netPurchases} previous={previous.netPurchases} goodWhenUp={false} />}
            </Card>
          </div>

          <TrendChart months={trend} />

          <div className="flex flex-col gap-2">
            <h2 className="text-base font-semibold text-black">Rincian per Bulan</h2>
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
                    <th className="px-4 py-2">Bulan</th>
                    <th className="px-4 py-2 text-right">Penjualan Kotor</th>
                    <th className="px-4 py-2 text-right">Diskon</th>
                    <th className="px-4 py-2 text-right">Retur</th>
                    <th className="px-4 py-2 text-right">Penjualan Bersih</th>
                    <th className="px-4 py-2 text-right">HPP</th>
                    <th className="px-4 py-2 text-right">Laba Kotor</th>
                    <th className="px-4 py-2 text-right">Margin</th>
                    <th className="px-4 py-2 text-right">Pembelian Bersih</th>
                  </tr>
                </thead>
                <tbody>
                  {[...trend].reverse().map((m) => (
                    <tr key={m.month} className="border-b border-slate-100 hover:bg-slate-50">
                      <td className="whitespace-nowrap px-4 py-2">{monthLabel(m.month)}</td>
                      <td className="px-4 py-2 text-right font-mono">{rp(m.grossSales)}</td>
                      <td className="px-4 py-2 text-right font-mono">{m.discount > 0 ? `− ${rp(m.discount)}` : "0"}</td>
                      <td className="px-4 py-2 text-right font-mono">{m.salesReturn > 0 ? `− ${rp(m.salesReturn)}` : "0"}</td>
                      <td className="px-4 py-2 text-right font-mono">{rp(m.netSales)}</td>
                      <td className="px-4 py-2 text-right font-mono">{rp(m.hpp)}</td>
                      <td className={`px-4 py-2 text-right font-mono ${m.grossProfit < 0 ? "text-red-600" : ""}`}>
                        {rp(m.grossProfit)}
                      </td>
                      <td className="px-4 py-2 text-right font-mono">{m.marginPct != null ? pct(m.marginPct) : "—"}</td>
                      <td className="px-4 py-2 text-right font-mono">{rp(m.netPurchases)}</td>
                    </tr>
                  ))}
                </tbody>
                {total && (
                  <tfoot>
                    <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
                      <td className="px-4 py-2">Total {trend.length} bulan</td>
                      <td className="px-4 py-2 text-right font-mono">{rp(total.grossSales)}</td>
                      <td className="px-4 py-2 text-right font-mono">{total.discount > 0 ? `− ${rp(total.discount)}` : "0"}</td>
                      <td className="px-4 py-2 text-right font-mono">
                        {total.salesReturn > 0 ? `− ${rp(total.salesReturn)}` : "0"}
                      </td>
                      <td className="px-4 py-2 text-right font-mono">{rp(total.netSales)}</td>
                      <td className="px-4 py-2 text-right font-mono">{rp(total.hpp)}</td>
                      <td className={`px-4 py-2 text-right font-mono ${total.grossProfit < 0 ? "text-red-600" : ""}`}>
                        {rp(total.grossProfit)}
                      </td>
                      <td className="px-4 py-2 text-right font-mono">
                        {total.marginPct != null ? pct(total.marginPct) : "—"}
                      </td>
                      <td className="px-4 py-2 text-right font-mono">{rp(total.netPurchases)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
            <FormHint>
              Pembelian dihitung saat barang diterima, retur di bulan retur dibuat. Angka bisa sedikit berbeda dari Laba Rugi
              karena dihitung dari dokumen, bukan jurnal.
            </FormHint>
          </div>
        </>
      )}
    </div>
  );
}
