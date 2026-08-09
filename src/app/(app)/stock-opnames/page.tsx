"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { getLeafAccounts, type Account } from "@/lib/accounts/schema";
import type { Item } from "@/lib/items/schema";
import type { InventoryBalance } from "@/lib/inventory/schema";
import { recordStockOpnameSchema, type StockOpname } from "@/lib/stock-opnames/schema";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";

type LineInput = { item_id: string; qty_actual: string };

function emptyLine(): LineInput {
  return { item_id: "", qty_actual: "" };
}

export default function StockOpnamesPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [balances, setBalances] = useState<InventoryBalance[]>([]);
  const [opnames, setOpnames] = useState<StockOpname[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [opnameDate, setOpnameDate] = useState("");
  const [sourceRef, setSourceRef] = useState("");
  const [shortageAccountId, setShortageAccountId] = useState("");
  const [surplusAccountId, setSurplusAccountId] = useState("");
  const [lines, setLines] = useState<LineInput[]>([emptyLine()]);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const leafAccounts = getLeafAccounts(accounts);

  const loadOpnames = useCallback(async () => {
    const { data, error } = await supabase
      .from("stock_opnames")
      .select(
        "id, opname_date, source_ref, created_at, stock_opname_lines(id, item_id, qty_system, qty_actual, unit_cost, journal_entry_id, items(name, uom))"
      )
      .order("opname_date", { ascending: false });
    if (error) {
      setLoadError(error.message);
      return;
    }
    setLoadError(null);
    setOpnames((data ?? []) as unknown as StockOpname[]);
  }, []);

  const loadItems = useCallback(async () => {
    const [{ data }, { data: bal }] = await Promise.all([
      supabase
        .from("items")
        .select("id, name, item_type, uom, inventory_account_id, archived_at")
        .order("name"),
      supabase.from("inventory_balances").select("item_id, qty_on_hand, avg_cost"),
    ]);
    setItems((data ?? []) as Item[]);
    setBalances((bal ?? []) as InventoryBalance[]);
  }, []);

  const loadAccounts = useCallback(async () => {
    const { data } = await supabase
      .from("accounts")
      .select("id, code, name, category, normal_balance, parent_id, archived_at")
      .order("code");
    setAccounts((data ?? []) as Account[]);
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
      await Promise.all([loadItems(), loadAccounts(), loadOpnames()]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadItems, loadAccounts, loadOpnames]);

  function openForm() {
    setFormError(null);
    setOpnameDate("");
    setSourceRef("");
    setShortageAccountId("");
    setSurplusAccountId("");
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

  async function handleCreate(e: FormEvent) {
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
      source_ref: sourceRef,
      shortage_expense_account_id: shortageAccountId,
      surplus_revenue_account_id: surplusAccountId,
      lines: activeLines,
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setSubmitting(true);
    const { error } = await supabase.rpc("record_stock_opname", {
      p_opname_date: parsed.data.opname_date,
      p_source_ref: parsed.data.source_ref,
      p_lines: parsed.data.lines,
      p_shortage_expense_account_id: parsed.data.shortage_expense_account_id,
      p_surplus_revenue_account_id: parsed.data.surplus_revenue_account_id,
    });
    setSubmitting(false);
    if (error) {
      setFormError(error.message);
      return;
    }

    setShowForm(false);
    await Promise.all([loadOpnames(), loadItems()]);
  }

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");

  return (
    <div className="flex w-full max-w-5xl flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">Stock Opname — CV Roti Barokah</h1>
        <p className="text-sm text-slate-500">
          Role kamu:{" "}
          {roles.length > 0 ? roles.join(", ") : "belum ada role — cuma bisa lihat"}
        </p>
      </div>

      {loadError && <FormError>{loadError}</FormError>}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-black">Sesi Opname</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
              {opnames.length}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="toolbar" onClick={() => loadOpnames()}>
              Refresh
            </Button>
            {canWrite && (
              <Button variant="toolbar-primary" onClick={() => (showForm ? setShowForm(false) : openForm())}>
                {showForm ? "Batal" : "+ New"}
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
                  Belum ada sesi opname.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showForm && (
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 font-semibold text-black">Catat Sesi Opname</h2>
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
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="source_ref">Rujukan dokumen (nomor berita acara opname)</Label>
                <Input
                  id="source_ref"
                  placeholder="mis. Opname-2026-09"
                  value={sourceRef}
                  onChange={(e) => setSourceRef(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="shortage_account">Akun Beban Selisih Persediaan (selisih kurang)</Label>
                <Select
                  id="shortage_account"
                  value={shortageAccountId}
                  onChange={(e) => setShortageAccountId(e.target.value)}
                >
                  <option value="">Pilih akun...</option>
                  {leafAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="surplus_account">Akun Pendapatan Selisih Persediaan (selisih lebih)</Label>
                <Select
                  id="surplus_account"
                  value={surplusAccountId}
                  onChange={(e) => setSurplusAccountId(e.target.value)}
                >
                  <option value="">Pilih akun...</option>
                  {leafAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </Select>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-[1fr_8rem_8rem_2.5rem] gap-2 text-sm font-medium text-slate-500">
                <span>Item</span>
                <span>Qty Sistem</span>
                <span>Qty Hasil Hitung</span>
                <span />
              </div>
              {lines.map((line, i) => (
                <div key={i} className="grid grid-cols-[1fr_8rem_8rem_2.5rem] gap-2">
                  <Select value={line.item_id} onChange={(e) => updateLine(i, { item_id: e.target.value })}>
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
                  <Input
                    type="number"
                    min="0"
                    placeholder="0"
                    value={line.qty_actual}
                    onChange={(e) => updateLine(i, { qty_actual: e.target.value })}
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
                + Tambah item
              </Button>
            </div>

            {formError && <FormError>{formError}</FormError>}

            <Button type="submit" disabled={submitting} className="w-fit">
              {submitting ? "Menyimpan..." : "Simpan Opname"}
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
