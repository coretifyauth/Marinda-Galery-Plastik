"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import { createBomSchema, type CreateBomInput } from "@/lib/bom/schema";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { DraftNotice } from "@/components/ui/draft-notice";
import { useFormDraft } from "@/lib/form-draft/use-form-draft";
import { LoadingScreen } from "@/components/ui/loading-screen";
import { ItemPicker } from "@/components/pickers/item-picker";

type LineInput = { raw_material_item_id: string; qty_per_batch: string };

function emptyLine(): LineInput {
  return { raw_material_item_id: "", qty_per_batch: "" };
}

export default function NewBomPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [roles, setRoles] = useState<string[]>([]);

  const [finishedItemId, setFinishedItemId] = useState("");
  const [outputQty, setOutputQty] = useState("");
  const [lines, setLines] = useState<LineInput[]>([emptyLine()]);
  const [formError, setFormError] = useState<string | null>(null);
  const draft = useFormDraft(
    "bom/new",
    { finishedItemId, outputQty, lines },
    (d) => {
      setFinishedItemId(d.finishedItemId);
      setOutputQty(d.outputQty);
      setLines(d.lines);
    },
    !checkingSession
  );

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
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router]);

  const createMutation = useMutation({
    mutationFn: async (input: CreateBomInput) => {
      const { data: header, error: headerError } = await supabase
        .from("bom_headers")
        .insert({ finished_item_id: input.finished_item_id, output_qty: input.output_qty })
        .select("id")
        .single();
      if (headerError || !header) {
        throw new Error(headerError?.message ?? "Gagal bikin BOM header");
      }

      const { error: linesError } = await supabase.from("bom_lines").insert(
        input.lines.map((l) => ({
          bom_header_id: header.id,
          raw_material_item_id: l.raw_material_item_id,
          qty_per_batch: l.qty_per_batch,
        }))
      );
      if (linesError) throw new Error(linesError.message);
      return header.id as string;
    },
    onSuccess: (newId) => {
      draft.clear();
      router.push(`/bom/${newId}`);
    },
    onError: (err) => {
      setFormError(err instanceof Error ? err.message : "Gagal menyimpan resep");
    },
  });

  function updateLine(index: number, patch: Partial<LineInput>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function addLine() {
    setLines((prev) => [...prev, emptyLine()]);
  }

  function removeLine(index: number) {
    setLines((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  }

  function handleCreate(e: FormEvent) {
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

    createMutation.mutate(parsed.data);
  }

  if (checkingSession) {
    return <LoadingScreen />;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/bom" label="Kembali ke BOM" />
      <DraftNotice draft={draft} />

      <div>
        <h1 className="text-xl font-semibold text-black">Buat Resep (BOM)</h1>
        <p className="text-sm text-slate-500">
          Resep bahan baku per batch untuk 1 barang jadi — dipakai Production Order buat
          konsumsi bahan baku otomatis.
        </p>
      </div>

      {!canWrite && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-700">
          Kamu belum punya role admin/accountant — submit di bawah kemungkinan bakal ketolak RLS.
        </p>
      )}

      <form onSubmit={handleCreate} className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="finished_item">Barang Jadi</Label>
                <ItemPicker
                  id="finished_item"
                  itemType="FINISHED_GOOD"
                  placeholder="Pilih barang jadi..."
                  value={finishedItemId}
                  onChange={setFinishedItemId}
                />
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
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-[1fr_8rem_2.5rem] gap-2 text-sm font-medium text-slate-500">
                <span>Bahan Baku</span>
                <span>Qty/Batch</span>
                <span />
              </div>
              {lines.map((line, i) => (
                <div key={i} className="grid grid-cols-[1fr_8rem_2.5rem] gap-2">
                  <ItemPicker
                    itemType="RAW_MATERIAL"
                    placeholder="Pilih bahan baku..."
                    value={line.raw_material_item_id}
                    onChange={(id) => updateLine(i, { raw_material_item_id: id })}
                  />
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
          </div>
        </div>

        <div className="flex flex-col gap-4 lg:sticky lg:top-4 lg:col-span-1 lg:self-start">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-6">
            <p className="mb-2.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Soal Resep (BOM)
            </p>
            <p className="text-sm text-slate-600">
              Output per Batch dan Qty/Batch tiap bahan baku dipakai Production Order buat
              menghitung otomatis berapa bahan baku dikonsumsi tiap kali produksi jalan
              (Weighted Average) — gak perlu diinput ulang manual tiap kali produksi.
            </p>
          </div>

          {formError && <FormError>{formError}</FormError>}

          <div className="flex flex-col gap-2">
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? "Menyimpan..." : "Simpan Resep"}
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
