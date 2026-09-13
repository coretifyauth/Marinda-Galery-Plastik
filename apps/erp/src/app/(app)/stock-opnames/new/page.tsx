"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import type { Item } from "@/lib/items/schema";
import type { ItemUnit } from "@/lib/item-units/schema";
import type { InventoryBalance } from "@/lib/inventory/schema";
import { recordStockOpnameSchema, type RecordStockOpnameInput } from "@/lib/stock-opnames/schema";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { LockedAccountField } from "@/components/ui/locked-account-field";
import { JournalPreviewPanel } from "@/components/ui/journal-preview-panel";
import { fetchDefaultAccounts, type ResolvedAccount } from "@/lib/default-accounts/schema";
import { MultiUomQtyInput } from "@/components/ui/multi-uom-qty-input";
import { LoadingScreen } from "@/components/ui/loading-screen";

type LineInput = { item_id: string; qty_actual: string };

function emptyLine(): LineInput {
  return { item_id: "", qty_actual: "" };
}

export default function NewStockOpnamePage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});
  const [items, setItems] = useState<Item[]>([]);
  const [itemUnits, setItemUnits] = useState<ItemUnit[]>([]);
  const [balances, setBalances] = useState<InventoryBalance[]>([]);
  const [roles, setRoles] = useState<string[]>([]);

  const [opnameDate, setOpnameDate] = useState("");
  const [lines, setLines] = useState<LineInput[]>([emptyLine()]);
  const [formError, setFormError] = useState<string | null>(null);

  const loadItems = useCallback(async () => {
    const [{ data }, { data: bal }, { data: units }] = await Promise.all([
      supabase
        .from("items")
        .select("id, name, item_type, uom, inventory_account_id, archived_at")
        .order("name"),
      supabase.from("inventory_balances").select("item_id, qty_on_hand, avg_cost"),
      supabase.from("item_units").select("id, item_id, unit_label, conversion_factor, price, is_base"),
    ]);
    setItems((data ?? []) as Item[]);
    setBalances((bal ?? []) as InventoryBalance[]);
    setItemUnits((units ?? []) as ItemUnit[]);
  }, []);

  const loadDefaultAccounts = useCallback(async () => {
    setDefaultAccounts(await fetchDefaultAccounts());
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
      await Promise.all([loadItems(), loadDefaultAccounts()]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadItems, loadDefaultAccounts]);

  function updateLine(index: number, patch: Partial<LineInput>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function addLine() {
    setLines((prev) => [...prev, emptyLine()]);
  }

  function removeLine(index: number) {
    setLines((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  }

  function systemQtyFor(itemId: string): number {
    return balances.find((b) => b.item_id === itemId)?.qty_on_hand ?? 0;
  }

  const createMutation = useMutation({
    mutationFn: async (input: RecordStockOpnameInput) => {
      const sourceRef = await generateDocumentNumber("stock_opnames");
      const { data, error } = await supabase.rpc("record_stock_opname", {
        p_opname_date: input.opname_date,
        p_source_ref: sourceRef,
        p_lines: input.lines,
        p_shortage_expense_account_id: input.shortage_expense_account_id,
        p_surplus_revenue_account_id: input.surplus_revenue_account_id,
      });
      if (error) throw new Error(error.message);
      return data as string | null;
    },
    onSuccess: (newId) => {
      router.push(newId ? `/stock-opnames/${newId}` : "/stock-opnames");
    },
    onError: (err) => {
      setFormError(err instanceof Error ? err.message : "Gagal menyimpan opname");
    },
  });

  function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const activeLines = lines
      .filter((l) => l.item_id.trim() !== "" && l.qty_actual.trim() !== "")
      .map((l) => {
        const item = items.find((i) => i.id === l.item_id);
        return {
          item_id: l.item_id,
          qty_actual: l.qty_actual,
          inventory_account_id: item?.inventory_account_id ?? "",
        };
      });

    const itemIds = activeLines.map((l) => l.item_id);
    if (new Set(itemIds).size !== itemIds.length) {
      setFormError("1 item cuma boleh muncul di 1 baris — gabungkan jadi 1 baris hasil hitung per item");
      return;
    }

    const parsed = recordStockOpnameSchema.safeParse({
      opname_date: opnameDate,
      shortage_expense_account_id: defaultAccounts["inventory.shortage_expense"]?.id ?? "",
      surplus_revenue_account_id: defaultAccounts["inventory.surplus_revenue"]?.id ?? "",
      lines: activeLines,
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
  const hasShortageLine = lines.some((l) => {
    if (!l.item_id || l.qty_actual.trim() === "") return false;
    const qty = Number(l.qty_actual);
    return !Number.isNaN(qty) && qty < systemQtyFor(l.item_id);
  });
  const hasSurplusLine = lines.some((l) => {
    if (!l.item_id || l.qty_actual.trim() === "") return false;
    const qty = Number(l.qty_actual);
    return !Number.isNaN(qty) && qty > systemQtyFor(l.item_id);
  });

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/stock-opnames" label="Kembali ke Stock Opname" />

      <div>
        <h1 className="text-xl font-semibold text-black">Catat Sesi Opname</h1>
        <p className="text-sm text-slate-500">
          Isi hasil hitung fisik per item. Item yang hasil hitungnya sama dengan catatan
          sistem otomatis dilewati — gak perlu dihapus dari daftar, cukup biarin kosong atau
          isi sama persis.
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
                <Label htmlFor="opname_date">Tanggal Opname</Label>
                <Input
                  id="opname_date"
                  type="date"
                  value={opnameDate}
                  onChange={(e) => setOpnameDate(e.target.value)}
                />
              </div>
              <LockedAccountField
                label="Akun Beban Selisih Persediaan (selisih kurang)"
                htmlFor="shortage_account"
                resolved={defaultAccounts["inventory.shortage_expense"]}
              />
              <LockedAccountField
                label="Akun Pendapatan Selisih Persediaan (selisih lebih)"
                htmlFor="surplus_account"
                resolved={defaultAccounts["inventory.surplus_revenue"]}
              />
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-[1fr_6rem_minmax(12rem,auto)_2.5rem] gap-2 text-sm font-medium text-slate-500">
                <span>Item</span>
                <span>Qty Sistem</span>
                <span>Hasil Hitung per Satuan</span>
                <span />
              </div>
              {lines.map((line, i) => {
                const selectedItem = items.find((it) => it.id === line.item_id);
                const unitsForItem = itemUnits.filter((u) => u.item_id === line.item_id);
                return (
                  <div key={i} className="grid grid-cols-[1fr_6rem_minmax(12rem,auto)_2.5rem] gap-2">
                    <Select
                      value={line.item_id}
                      onChange={(e) => updateLine(i, { item_id: e.target.value, qty_actual: "" })}
                    >
                      <option value="">Pilih item...</option>
                      {items.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name} ({item.uom})
                        </option>
                      ))}
                    </Select>
                    <span className="flex items-center font-mono text-sm text-slate-500">
                      {line.item_id ? systemQtyFor(line.item_id) : "-"}
                    </span>
                    {line.item_id ? (
                      <MultiUomQtyInput
                        key={line.item_id}
                        units={unitsForItem}
                        baseUom={selectedItem?.uom ?? ""}
                        onChange={(change) => updateLine(i, { qty_actual: change.baseQty })}
                      />
                    ) : (
                      <span className="flex items-center text-xs text-slate-400">Pilih item dulu</span>
                    )}
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
                );
              })}
              <Button type="button" variant="secondary" onClick={addLine} className="w-fit">
                + Tambah item
              </Button>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4 lg:sticky lg:top-4 lg:col-span-1 lg:self-start">
          <JournalPreviewPanel
            groups={[
              hasShortageLine && [
                {
                  label: "Akun Beban Selisih Persediaan (selisih kurang)",
                  resolved: defaultAccounts["inventory.shortage_expense"],
                },
              ],
              hasSurplusLine && [
                {
                  label: "Akun Pendapatan Selisih Persediaan (selisih lebih)",
                  resolved: defaultAccounts["inventory.surplus_revenue"],
                },
              ],
            ]}
          />

          {formError && <FormError>{formError}</FormError>}

          <div className="flex flex-col gap-2">
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? "Menyimpan..." : "Simpan Opname"}
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
