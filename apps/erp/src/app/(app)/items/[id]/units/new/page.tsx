"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { createItemUnitSchema, type ItemUnit } from "@/lib/item-units/schema";
import type { Item } from "@/lib/items/schema";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { LoadingScreen } from "@/components/ui/loading-screen";

export default function NewItemUnitPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [item, setItem] = useState<Item | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [unitIsBase, setUnitIsBase] = useState(false);
  const [unitLabel, setUnitLabel] = useState("");
  const [conversionFactor, setConversionFactor] = useState("1");
  const [unitPrice, setUnitPrice] = useState("");
  const [unitError, setUnitError] = useState<string | null>(null);
  const [unitSubmitting, setUnitSubmitting] = useState(false);

  const load = useCallback(async () => {
    const [{ data: it, error: itErr }, { data: us }] = await Promise.all([
      supabase
        .from("items")
        .select("id, name, item_type, uom, inventory_account_id, category_id, brand_id, archived_at")
        .eq("id", id)
        .single(),
      supabase
        .from("item_units")
        .select("id, item_id, unit_label, conversion_factor, price, is_base, barcode")
        .eq("item_id", id)
        .order("is_base", { ascending: false }),
    ]);
    if (itErr || !it) {
      setLoadError(itErr?.message ?? "Item gak ditemukan.");
      return;
    }
    setLoadError(null);
    const typedItem = it as Item;
    setItem(typedItem);
    const typedUnits = (us ?? []) as ItemUnit[];
    const hasBaseUnit = typedUnits.some((u) => u.is_base);
    if (!hasBaseUnit) {
      // Belum ada satuan dasar -- paksa baris pertama jadi satuan dasar, unit_label
      // dikunci sama items.uom (konvensi, ref docs/domain/inventory.md).
      setUnitIsBase(true);
      setUnitLabel(typedItem.uom);
      setConversionFactor("1");
    } else {
      setUnitIsBase(false);
      setUnitLabel("");
      setConversionFactor("");
    }
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

  async function handleAddUnit(e: FormEvent) {
    e.preventDefault();
    setUnitError(null);
    const parsed = createItemUnitSchema.safeParse({
      item_id: id,
      unit_label: unitLabel,
      conversion_factor: conversionFactor,
      price: unitPrice || undefined,
      is_base: unitIsBase,
    });
    if (!parsed.success) {
      setUnitError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }
    if (parsed.data.is_base && parsed.data.conversion_factor !== 1) {
      setUnitError("Satuan dasar wajib faktor konversi 1");
      return;
    }
    setUnitSubmitting(true);
    const { error } = await supabase.from("item_units").insert({
      item_id: parsed.data.item_id,
      unit_label: parsed.data.unit_label,
      conversion_factor: parsed.data.conversion_factor,
      price: parsed.data.price ?? null,
      is_base: parsed.data.is_base,
    });
    setUnitSubmitting(false);
    if (error) {
      setUnitError(error.message);
      return;
    }
    router.push(`/items/${id}`);
  }

  if (checkingSession) {
    return <LoadingScreen />;
  }

  if (!item) {
    return <FormError>{loadError ?? "Item gak ditemukan."}</FormError>;
  }

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href={`/items/${id}`} label="Kembali ke Detail Item" />

      <div>
        <h1 className="text-xl font-semibold text-black">Tambah Satuan Jual</h1>
        <p className="text-sm text-slate-500">
          Satuan jual baru buat {item.name} — dipakai buat transaksi keluar & harga jual.
        </p>
      </div>

      <form onSubmit={handleAddUnit} className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-5">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="unit_label">Nama Satuan</Label>
                <Input
                  id="unit_label"
                  autoFocus
                  placeholder="mis. lusin"
                  value={unitLabel}
                  onChange={(e) => setUnitLabel(e.target.value)}
                  disabled={unitIsBase}
                />
              </div>
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="conversion_factor">Faktor Konversi (ke {item.uom})</Label>
                  <Input
                    id="conversion_factor"
                    type="number"
                    min="0"
                    placeholder="mis. 12"
                    value={conversionFactor}
                    onChange={(e) => setConversionFactor(e.target.value)}
                    disabled={unitIsBase}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="unit_price">Harga (opsional)</Label>
                  <Input
                    id="unit_price"
                    type="number"
                    min="0"
                    placeholder="mis. 22000"
                    value={unitPrice}
                    onChange={(e) => setUnitPrice(e.target.value)}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4 lg:sticky lg:top-4 lg:col-span-1 lg:self-start">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-6">
            <p className="mb-2.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Soal Satuan & Faktor Konversi
            </p>
            <p className="text-sm text-slate-600">
              {unitIsBase
                ? "Ini jadi satuan dasar item — nama & faktor konversi dikunci (harus sama dengan satuan dasar di master data, faktor 1)."
                : "Faktor konversi = berapa satuan dasar sama dengan 1 satuan ini (mis. 1 lusin = 12 buah)."}
            </p>
          </div>

          {unitError && <FormError>{unitError}</FormError>}

          <div className="flex flex-col gap-2">
            <Button type="submit" disabled={unitSubmitting}>
              {unitSubmitting ? "Menyimpan..." : "Simpan Satuan"}
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
