"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import type { BomHeader } from "@/lib/bom/schema";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";

export function BomDetailView({ id }: { id: string }) {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [bom, setBom] = useState<BomHeader | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("bom_headers")
      .select(
        "id, finished_item_id, output_qty, is_active, created_at, items(name, uom), bom_lines(id, raw_material_item_id, qty_per_batch, items(name, uom))"
      )
      .eq("id", id)
      .single();
    if (error || !data) {
      setLoadError(error?.message ?? "BOM gak ditemukan.");
      return;
    }
    setBom(data as unknown as BomHeader);
    setLoadError(null);
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

  if (!bom) {
    return <FormError>{loadError ?? "BOM gak ditemukan."}</FormError>;
  }

  return (
    <div className="flex w-full max-w-4xl flex-1 flex-col gap-6">
      <BackLink href="/bom" label="Kembali ke BOM" />
      <div className="flex items-center gap-2">
        <h1 className="text-xl font-semibold text-black">{bom.items.name}</h1>
        <span
          className={`rounded-full px-2 py-0.5 text-xs ${
            bom.is_active ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-400"
          }`}
        >
          {bom.is_active ? "Aktif" : "Nonaktif"}
        </span>
      </div>

      {loadError && <FormError>{loadError}</FormError>}

      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs uppercase text-slate-400">Barang Jadi</dt>
            <dd className="text-black">{bom.items.name}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-400">Output per Batch</dt>
            <dd className="font-mono text-black">
              {bom.output_qty} {bom.items.uom}
            </dd>
          </div>
        </dl>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-4 py-2">
          <span className="text-sm font-medium text-black">Bahan Baku</span>
          <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
            {bom.bom_lines.length}
          </span>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Bahan Baku</th>
              <th className="px-4 py-2 text-right">Qty/Batch</th>
            </tr>
          </thead>
          <tbody>
            {bom.bom_lines.map((line) => (
              <tr key={line.id} className="border-b border-slate-100 hover:bg-slate-50">
                <td className="px-4 py-2 font-medium text-black">{line.items.name}</td>
                <td className="px-4 py-2 text-right font-mono">
                  {line.qty_per_batch} {line.items.uom}
                </td>
              </tr>
            ))}
            {bom.bom_lines.length === 0 && (
              <tr>
                <td colSpan={2} className="px-4 py-6 text-center text-slate-400">
                  Belum ada bahan baku.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
