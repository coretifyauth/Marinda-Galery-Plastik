"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import type { Item } from "@/lib/items/schema";
import type { ItemUnit } from "@/lib/item-units/schema";
import type { InventoryBalance } from "@/lib/inventory/schema";
import { recordStockOpnameSchema, type RecordStockOpnameInput } from "@/lib/stock-opnames/schema";
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS, useStockOpnames } from "@/lib/stock-opnames/queries";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { Modal } from "@/components/ui/modal";
import { LockedAccountField } from "@/components/ui/locked-account-field";
import { JournalPreviewPanel } from "@/components/ui/journal-preview-panel";
import { fetchDefaultAccounts, type ResolvedAccount } from "@/lib/default-accounts/schema";
import { MultiUomQtyInput } from "@/components/ui/multi-uom-qty-input";
import { Pagination } from "@/components/ui/pagination";

type LineInput = { item_id: string; qty_actual: string };

function emptyLine(): LineInput {
  return { item_id: "", qty_actual: "" };
}

// Input kecil buat baris filter di header tabel -- pola sama kayak journal-entries/page.tsx.
const compactFilterInputClass =
  "w-full rounded border border-slate-200 bg-white px-1.5 py-1 text-xs font-normal normal-case text-slate-700 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-1 focus:ring-blue-600/40";

export default function StockOpnamesPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [checkingSession, setCheckingSession] = useState(true);
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});
  const [items, setItems] = useState<Item[]>([]);
  const [itemUnits, setItemUnits] = useState<ItemUnit[]>([]);
  const [balances, setBalances] = useState<InventoryBalance[]>([]);
  const [roles, setRoles] = useState<string[]>([]);

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [refSearchInput, setRefSearchInput] = useState("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const debouncedRefSearch = useDebouncedValue(refSearchInput, 300);

  const [opnameDate, setOpnameDate] = useState("");
  const [lines, setLines] = useState<LineInput[]>([emptyLine()]);
  const [formError, setFormError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  // Filter berubah -> balik ke halaman 1 (pola "adjust state during render", bukan useEffect --
  // lihat journal-entries/page.tsx).
  const filterKey = `${dateFrom}|${dateTo}|${debouncedRefSearch}|${pageSize}`;
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey);
  if (filterKey !== prevFilterKey) {
    setPrevFilterKey(filterKey);
    setPage(0);
  }

  const filters = {
    dateFrom,
    dateTo,
    sourceRefSearch: debouncedRefSearch,
    page,
    pageSize,
  };
  const opnamesQuery = useStockOpnames(filters);
  const opnames = opnamesQuery.data?.rows ?? [];
  const total = opnamesQuery.data?.total ?? 0;

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

  function openForm() {
    setFormError(null);
    setOpnameDate("");
    setLines([emptyLine()]);
    setShowForm(true);
  }

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
      const { error } = await supabase.rpc("record_stock_opname", {
        p_opname_date: input.opname_date,
        p_source_ref: sourceRef,
        p_lines: input.lines,
        p_shortage_expense_account_id: input.shortage_expense_account_id,
        p_surplus_revenue_account_id: input.surplus_revenue_account_id,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      setShowForm(false);
      queryClient.invalidateQueries({ queryKey: ["stock_opnames"] });
      loadItems();
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
    return <p className="text-sm text-slate-500">Memuat...</p>;
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
      <div>
        <h1 className="text-xl font-semibold text-black">Stock Opname</h1>
        <p className="text-sm text-slate-500">
          Role kamu:{" "}
          {roles.length > 0 ? roles.join(", ") : "belum ada role — cuma bisa lihat"}
        </p>
      </div>

      {opnamesQuery.error && (
        <FormError>{(opnamesQuery.error as Error).message}</FormError>
      )}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-black">Sesi Opname</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
              {total}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="toolbar" onClick={() => opnamesQuery.refetch()}>
              Refresh
            </Button>
            {canWrite && (
              <Button variant="toolbar-primary" onClick={() => openForm()}>
                + New
              </Button>
            )}
          </div>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Tanggal</th>
              <th className="px-4 py-2">Rujukan</th>
              <th className="px-4 py-2">Item Ada Selisih</th>
            </tr>
            <tr className="border-b border-slate-200 bg-slate-50/50">
              <th className="px-4 py-1.5">
                <div className="flex gap-1">
                  <input
                    type="date"
                    aria-label="Dari tanggal"
                    value={dateFrom}
                    onChange={(e) => setDateFrom(e.target.value)}
                    className={compactFilterInputClass}
                  />
                  <input
                    type="date"
                    aria-label="Sampai tanggal"
                    value={dateTo}
                    onChange={(e) => setDateTo(e.target.value)}
                    className={compactFilterInputClass}
                  />
                </div>
              </th>
              <th className="px-4 py-1.5">
                <input
                  type="text"
                  placeholder="Cari rujukan..."
                  value={refSearchInput}
                  onChange={(e) => setRefSearchInput(e.target.value)}
                  className={compactFilterInputClass}
                />
              </th>
              <th className="px-4 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {opnames.map((o) => (
              <tr
                key={o.id}
                className="cursor-pointer border-b border-slate-100 align-top hover:bg-slate-50"
                onClick={() => router.push(`/stock-opnames/${o.id}`)}
              >
                <td className="whitespace-nowrap px-4 py-2">{o.opname_date}</td>
                <td className="px-4 py-2">{o.source_ref}</td>
                <td className="px-4 py-2">
                  <ul className="space-y-0.5">
                    {o.stock_opname_lines.map((l) => {
                      const variance = l.qty_actual - l.qty_system;
                      return (
                        <li key={l.id}>
                          {l.items.name} — sistem {l.qty_system} {l.items.uom}, fisik {l.qty_actual}{" "}
                          {l.items.uom}{" "}
                          <span className={variance < 0 ? "text-red-600" : "text-emerald-600"}>
                            ({variance > 0 ? "+" : ""}
                            {variance} {l.items.uom})
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </td>
              </tr>
            ))}
            {opnames.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-slate-400">
                  {opnamesQuery.isLoading ? "Memuat..." : "Belum ada sesi opname."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={setPage}
          pageSizeOptions={PAGE_SIZE_OPTIONS}
          onPageSizeChange={setPageSize}
        />
      </div>

      <Modal open={showForm} onClose={() => setShowForm(false)} title="Catat Sesi Opname" maxWidth="max-w-3xl">
        {!canWrite && (
          <p className="mb-4 text-sm text-amber-600">
            Kamu belum punya role admin/accountant — submit di bawah kemungkinan bakal
            ketolak RLS.
          </p>
        )}
        <p className="mb-4 text-sm text-slate-600">
          Isi hasil hitung fisik per item. Item yang hasil hitungnya sama dengan catatan
          sistem otomatis dilewati — gak perlu dihapus dari daftar, cukup biarin kosong atau
          isi sama persis.
        </p>
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
        <form onSubmit={handleCreate} className="flex flex-col gap-4">
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

            {formError && <FormError>{formError}</FormError>}

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="secondary" onClick={() => setShowForm(false)}>
                Batal
              </Button>
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? "Menyimpan..." : "Simpan Opname"}
              </Button>
            </div>
        </form>
      </Modal>
    </div>
  );
}
