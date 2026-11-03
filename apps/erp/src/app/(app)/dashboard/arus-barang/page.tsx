"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  buildItemUnits,
  computeItemFlow,
  fetchAllItemUnits,
  fetchItemFlowRaw,
  type FlowDirection,
  type ItemFlow,
  type UnitView,
} from "@/lib/inventory/flow";
import { todayLocal } from "@/lib/dates";
import { formatStockBreakdown } from "@/lib/stock-display";
import { Input } from "@/components/ui/input";
import { FormError, FormHint } from "@/components/ui/form-message";
import { InlineSpinner } from "@/components/ui/loading-screen";

const qty = (n: number) => n.toLocaleString("id-ID", { maximumFractionDigits: 3 });


/** Qty dalam kombinasi satuan: "1 ikat 3 bungkus (234 lembar)". */
function UnitQty({ qtyBase, units }: { qtyBase: number; units: UnitView[] }) {
  const base = units.find((u) => u.factor === 1)?.label ?? units[units.length - 1].label;
  return (
    <span className="font-semibold text-black">
      {formatStockBreakdown(
        qtyBase,
        base,
        units.map((u) => ({ unit_label: u.label, conversion_factor: u.factor }))
      )}
    </span>
  );
}

function UnitChips({ units }: { units: UnitView[] }) {
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {units.map((u) => (
        <span
          key={u.label}
          className="rounded border border-slate-200 px-1.5 py-0.5 text-[11px] text-slate-500"
          title={u.factor === 1 ? "Satuan dasar" : `1 ${u.label} = ${qty(u.factor)} satuan dasar`}
        >
          {u.label}
        </span>
      ))}
    </div>
  );
}

function shiftDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

const DIRECTIONS: { key: FlowDirection; label: string }[] = [
  { key: "keluar", label: "Barang Keluar (Terjual)" },
  { key: "masuk", label: "Barang Masuk (Dibeli)" },
];

export default function ItemFlowPage() {
  const today = todayLocal();
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const [direction, setDirection] = useState<FlowDirection>("keluar");
  const [search, setSearch] = useState("");

  const validRange = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;
  const { data, error, isFetching } = useQuery({
    queryKey: ["item_flow", from, to],
    queryFn: () => fetchItemFlowRaw(from, to),
    enabled: validRange,
    staleTime: 30_000,
  });

  const { data: unitRows } = useQuery({
    queryKey: ["item_units_all"],
    queryFn: fetchAllItemUnits,
    staleTime: 60_000,
  });

  const unitsByItem = useMemo(() => {
    const grouped = new Map<string, NonNullable<typeof unitRows>>();
    for (const r of unitRows ?? []) grouped.set(r.item_id, [...(grouped.get(r.item_id) ?? []), r]);
    return grouped;
  }, [unitRows]);
  const unitsOf = (f: ItemFlow) => buildItemUnits(f.uom, unitsByItem.get(f.itemId) ?? []);

  // Hanya barang yang bergerak: ada penjualan (keluar) atau pembelian (masuk) dalam periode. Urut nama (dari RPC).
  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (data ?? [])
      .map((r) => computeItemFlow(r, direction))
      .filter((f) => f.qty > 0 && (!term || f.name.toLowerCase().includes(term)));
  }, [data, direction, search]);

  const presets = [
    { label: "Bulan ini", set: () => (setFrom(`${today.slice(0, 7)}-01`), setTo(today)) },
    { label: "30 hari", set: () => (setFrom(shiftDays(today, -29)), setTo(today)) },
    { label: "90 hari", set: () => (setFrom(shiftDays(today, -89)), setTo(today)) },
  ];

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">Dashboard Arus Barang</h1>
        <FormHint>
          Barang yang terjual dan barang yang dibeli per item dalam satu periode.
        </FormHint>
      </div>

      <div className="flex flex-wrap items-end gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          Dari
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          Sampai
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />
        </label>
        <div className="flex gap-1.5">
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={p.set}
              className="rounded-md border border-slate-200 px-2.5 py-2 text-xs text-slate-600 hover:bg-slate-50"
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          Arah
          <div className="flex overflow-hidden rounded-lg border border-slate-200">
            {DIRECTIONS.map((d) => (
              <button
                key={d.key}
                type="button"
                onClick={() => setDirection(d.key)}
                className={`px-3 py-2 text-sm ${
                  direction === d.key ? "bg-blue-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-sm font-medium text-slate-700">
          Cari barang
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Nama barang" />
        </label>
      </div>

      {!validRange && <FormError>Rentang tanggal tidak valid.</FormError>}
      {error && <FormError>{error instanceof Error ? error.message : "Gagal memuat arus barang"}</FormError>}
      {!data && isFetching && <InlineSpinner />}

      {data && (
        <>
          <FormHint>{rows.length} barang {direction === "keluar" ? "terjual" : "dibeli"} dalam periode ini.</FormHint>

          <div className="max-h-[75vh] overflow-auto rounded-xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-xs font-medium uppercase text-slate-500">
                  <th className="sticky top-0 z-10 bg-slate-50 px-4 py-2 shadow-[0_1px_0_0_#e2e8f0]">Barang</th>
                  <th className="sticky top-0 z-10 bg-slate-50 px-4 py-2 text-right shadow-[0_1px_0_0_#e2e8f0]">
                    {direction === "keluar" ? "Qty Terjual" : "Qty Dibeli"}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((f) => {
                  const units = unitsOf(f);
                  return (
                    <tr key={f.itemId} className="border-b border-slate-100 hover:bg-slate-50">
                      <td className="px-4 py-2">
                        <Link href={`/items/${f.itemId}`} className="text-blue-600 hover:underline">
                          {f.name}
                        </Link>
                        <UnitChips units={units} />
                      </td>
                      <td className="px-4 py-2 text-right font-mono">
                        <UnitQty qtyBase={f.qty} units={units} />
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={2} className="px-4 py-6 text-center text-slate-400">
                      Tidak ada barang {direction === "keluar" ? "terjual" : "dibeli"} untuk filter ini.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <FormHint>
            {direction === "keluar"
              ? "Terjual = barang keluar karena penjualan (invoice dan POS), dikurangi penjualan yang dibatalkan."
              : "Dibeli = barang yang diterima dari supplier, dikurangi penerimaan yang dibatalkan."}{" "}
            Retur, produksi, dan selisih opname tidak dihitung; lihat Kartu Stok per barang. Qty tampil dalam kombinasi satuan barang,
            mis. 1 ikat 3 bungkus (234 lembar).
          </FormHint>
        </>
      )}
    </div>
  );
}
