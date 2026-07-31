"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import type { Item } from "@/lib/items/schema";
import { createBomSchema, type BomHeader } from "@/lib/bom/schema";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";

type LineInput = { raw_material_item_id: string; qty_per_batch: string };

function emptyLine(): LineInput {
  return { raw_material_item_id: "", qty_per_batch: "" };
}

export default function BomPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [items, setItems] = useState<Item[]>([]);
  const [boms, setBoms] = useState<BomHeader[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [finishedItemId, setFinishedItemId] = useState("");
  const [outputQty, setOutputQty] = useState("");
  const [lines, setLines] = useState<LineInput[]>([emptyLine()]);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const finishedGoods = items.filter((i) => i.item_type === "FINISHED_GOOD");
  const rawMaterials = items.filter((i) => i.item_type === "RAW_MATERIAL");

  const loadBoms = useCallback(async () => {
    const { data, error } = await supabase
      .from("bom_headers")
      .select(
        "id, finished_item_id, output_qty, is_active, created_at, items(name, uom), bom_lines(id, raw_material_item_id, qty_per_batch, items(name, uom))"
      )
      .order("created_at", { ascending: false });
    if (error) {
      setLoadError(error.message);
      return;
    }
    setLoadError(null);
    setBoms((data ?? []) as unknown as BomHeader[]);
  }, []);

  const loadItems = useCallback(async () => {
    const { data } = await supabase
      .from("items")
      .select("id, name, item_type, costing_method, uom, inventory_account_id, archived_at")
      .order("name");
    setItems((data ?? []) as Item[]);
  }, []);

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
      await Promise.all([loadItems(), loadBoms()]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadItems, loadBoms]);

  function updateLine(index: number, patch: Partial<LineInput>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function addLine() {
    setLines((prev) => [...prev, emptyLine()]);
  }

  function removeLine(index: number) {
    setLines((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const parsed = createBomSchema.safeParse({
      finished_item_id: finishedItemId,
      output_qty: outputQty,
      lines,
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setSubmitting(true);
    const { data: header, error: headerError } = await supabase
      .from("bom_headers")
      .insert({ finished_item_id: parsed.data.finished_item_id, output_qty: parsed.data.output_qty })
      .select("id")
      .single();
    if (headerError || !header) {
      setSubmitting(false);
      setFormError(headerError?.message ?? "Gagal bikin BOM header");
      return;
    }

    const { error: linesError } = await supabase.from("bom_lines").insert(
      parsed.data.lines.map((l) => ({
        bom_header_id: header.id,
        raw_material_item_id: l.raw_material_item_id,
        qty_per_batch: l.qty_per_batch,
      }))
    );
    setSubmitting(false);
    if (linesError) {
      setFormError(linesError.message);
      return;
    }

    setFinishedItemId("");
    setOutputQty("");
    setLines([emptyLine()]);
    setShowForm(false);
    await loadBoms();
  }

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");

  return (
    <div className="flex w-full max-w-4xl flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">BOM (Resep) — CV Roti Barokah</h1>
        <p className="text-sm text-slate-500">
          Role kamu:{" "}
          {roles.length > 0 ? roles.join(", ") : "belum ada role — cuma bisa lihat"}
        </p>
      </div>

      {loadError && <FormError>{loadError}</FormError>}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-black">BOM</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
              {boms.length}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="toolbar" onClick={() => loadBoms()}>
              Refresh
            </Button>
            {canWrite && (
              <Button variant="toolbar-primary" onClick={() => setShowForm((v) => !v)}>
                + New
              </Button>
            )}
          </div>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Barang Jadi</th>
              <th className="px-4 py-2">Output/Batch</th>
              <th className="px-4 py-2">Bahan Baku</th>
              <th className="px-4 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {boms.map((bom) => (
              <tr key={bom.id} className="border-b border-slate-100 align-top hover:bg-slate-50">
                <td className="px-4 py-2 font-medium text-black">{bom.items.name}</td>
                <td className="px-4 py-2">
                  {bom.output_qty} {bom.items.uom}
                </td>
                <td className="px-4 py-2">
                  <ul className="space-y-0.5">
                    {bom.bom_lines.map((l) => (
                      <li key={l.id}>
                        {l.items.name} — {l.qty_per_batch} {l.items.uom}
                      </li>
                    ))}
                  </ul>
                </td>
                <td className="px-4 py-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs ${
                      bom.is_active ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-400"
                    }`}
                  >
                    {bom.is_active ? "Aktif" : "Nonaktif"}
                  </span>
                </td>
              </tr>
            ))}
            {boms.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-slate-400">
                  Belum ada resep.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showForm && (
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 font-semibold text-black">Buat Resep (BOM)</h2>
          {!canWrite && (
            <p className="mb-4 text-sm text-amber-600">
              Kamu belum punya role admin/accountant — submit di bawah kemungkinan bakal
              ketolak RLS.
            </p>
          )}
          <form onSubmit={handleCreate} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="finished_item">Barang Jadi</Label>
                <Select
                  id="finished_item"
                  value={finishedItemId}
                  onChange={(e) => setFinishedItemId(e.target.value)}
                >
                  <option value="">Pilih barang jadi...</option>
                  {finishedGoods.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} ({item.uom})
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="output_qty">Output per Batch</Label>
                <Input
                  id="output_qty"
                  type="number"
                  min="0"
                  placeholder="mis. 50"
                  value={outputQty}
                  onChange={(e) => setOutputQty(e.target.value)}
                />
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-[1fr_8rem_2.5rem] gap-2 text-sm font-medium text-slate-500">
                <span>Bahan Baku</span>
                <span>Qty/Batch</span>
                <span />
              </div>
              {lines.map((line, i) => (
                <div key={i} className="grid grid-cols-[1fr_8rem_2.5rem] gap-2">
                  <Select
                    value={line.raw_material_item_id}
                    onChange={(e) => updateLine(i, { raw_material_item_id: e.target.value })}
                  >
                    <option value="">Pilih bahan baku...</option>
                    {rawMaterials.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} ({item.uom})
                      </option>
                    ))}
                  </Select>
                  <Input
                    type="number"
                    min="0"
                    placeholder="0"
                    value={line.qty_per_batch}
                    onChange={(e) => updateLine(i, { qty_per_batch: e.target.value })}
                  />
                  <button
                    type="button"
                    onClick={() => removeLine(i)}
                    disabled={lines.length <= 1}
                    className="text-slate-400 hover:text-red-600 disabled:opacity-30"
                    aria-label="Hapus baris"
                  >
                    ✕
                  </button>
                </div>
              ))}
              <Button type="button" variant="secondary" onClick={addLine} className="w-fit">
                + Tambah bahan baku
              </Button>
            </div>

            {formError && <FormError>{formError}</FormError>}

            <Button type="submit" disabled={submitting} className="w-fit">
              {submitting ? "Menyimpan..." : "Simpan Resep"}
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
