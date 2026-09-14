"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import type { ApBill } from "@/lib/ap-bills/schema";
import { createPurchaseReplacementSchema } from "@/lib/purchase-replacements/schema";
import type { GoodsReceiptForBill } from "@/lib/ap-credit-notes/schema";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { LockedAccountField } from "@/components/ui/locked-account-field";
import { JournalPreviewPanel } from "@/components/ui/journal-preview-panel";
import { fetchDefaultAccounts, type ResolvedAccount } from "@/lib/default-accounts/schema";
import { LoadingScreen } from "@/components/ui/loading-screen";

type ReplaceLineInput = {
  item_id: string;
  name: string;
  uom: string;
  qty_available: number;
  qty: string;
};

type CreditNoteDetail = {
  id: string;
  return_lines: { item_id: string; qty_returned: number }[];
};

type ReplacementDetail = {
  id: string;
  replacement_lines: { item_id: string; qty_replaced: number }[];
};

export default function ApBillTukarBarangPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [bill, setBill] = useState<ApBill | null>(null);
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});
  const [goodsReceipt, setGoodsReceipt] = useState<GoodsReceiptForBill | null>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [replaceDate, setReplaceDate] = useState("");
  const [replaceLines, setReplaceLines] = useState<ReplaceLineInput[]>([]);
  const [replaceError, setReplaceError] = useState<string | null>(null);
  const [replaceSubmitting, setReplaceSubmitting] = useState(false);

  const load = useCallback(async () => {
    const { data: b, error: billErr } = await supabase
      .from("transactions")
      .select("id, supplier_id:counterparty_id, source_ref, amount, journal_entry_id, counterparties(name)")
      .eq("id", id)
      .eq("type", "INBOUND")
      .single();
    if (billErr || !b) {
      setLoadError(billErr?.message ?? "Bill gak ditemukan.");
      return;
    }
    setBill(b as unknown as ApBill);

    const [defaultAccountsMap, { data: cns, error: cnErr }, { data: reps, error: repErr }, { data: grn }] =
      await Promise.all([
        fetchDefaultAccounts(),
        supabase
          .from("returns")
          .select("id, return_lines(item_id, qty_returned)")
          .eq("transaction_id", id)
          .eq("type", "OUTBOUND"),
        supabase
          .from("replacements")
          .select("id, replacement_lines(item_id, qty_replaced)")
          .eq("transaction_id", id)
          .eq("type", "OUTBOUND"),
        supabase
          .from("goods_notes")
          .select("id, goods_note_lines(item_id, qty, unit_cost, items(name, uom))")
          .eq("transaction_id", id)
          .eq("type", "INBOUND")
          .maybeSingle(),
      ]);

    setDefaultAccounts(defaultAccountsMap);
    setLoadError(cnErr?.message ?? repErr?.message ?? null);
    const loadedGoodsReceipt = (grn ?? null) as unknown as GoodsReceiptForBill | null;
    setGoodsReceipt(loadedGoodsReceipt);

    // Qty per item yang udah "diklaim" dari bill ini, GABUNGAN retur (Opsi A) + tukar barang
    // (Opsi B) -- mirror purchase_returned_qty() di database, cuma ada 1 pool qty_received
    // per item yang bisa diklaim, mau lewat jalur mana pun.
    const claimed = new Map<string, number>();
    for (const cn of (cns ?? []) as unknown as CreditNoteDetail[]) {
      for (const l of cn.return_lines) {
        claimed.set(l.item_id, (claimed.get(l.item_id) ?? 0) + l.qty_returned);
      }
    }
    for (const r of (reps ?? []) as unknown as ReplacementDetail[]) {
      for (const l of r.replacement_lines) {
        claimed.set(l.item_id, (claimed.get(l.item_id) ?? 0) + l.qty_replaced);
      }
    }
    setReplaceLines(
      loadedGoodsReceipt
        ? loadedGoodsReceipt.goods_note_lines
            .map((l) => ({
              item_id: l.item_id,
              name: l.items.name,
              uom: l.items.uom,
              qty_available: l.qty - (claimed.get(l.item_id) ?? 0),
              qty: "",
            }))
            .filter((l) => l.qty_available > 0)
        : []
    );
  }, [id]);

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
      await load();
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, load]);

  function updateReplaceLine(itemId: string, qty: string) {
    setReplaceLines((prev) => prev.map((l) => (l.item_id === itemId ? { ...l, qty } : l)));
  }

  async function handleReplaceSubmit(e: FormEvent) {
    e.preventDefault();
    if (!bill) return;
    setReplaceError(null);

    const activeLines = replaceLines
      .filter((l) => l.qty.trim() !== "")
      .map((l) => ({ item_id: l.item_id, qty: l.qty }));

    if (activeLines.length === 0) {
      setReplaceError("Isi minimal 1 baris qty tukar");
      return;
    }

    const parsed = createPurchaseReplacementSchema.safeParse({
      bill_id: bill.id,
      replacement_date: replaceDate,
      lines: activeLines,
      inventory_account_id: defaultAccounts["inventory.raw_material"]?.id ?? "",
    });
    if (!parsed.success) {
      setReplaceError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setReplaceSubmitting(true);
    let sourceRef: string;
    try {
      sourceRef = await generateDocumentNumber("purchase_replacements");
    } catch (err) {
      setReplaceSubmitting(false);
      setReplaceError(err instanceof Error ? err.message : "Gagal generate nomor dokumen");
      return;
    }
    const { error } = await supabase.rpc("create_replacement", {
      p_type: "OUTBOUND",
      p_transaction_id: parsed.data.bill_id,
      p_replacement_date: parsed.data.replacement_date,
      p_source_ref: sourceRef,
      p_lines: parsed.data.lines,
      p_debit_account_id: parsed.data.inventory_account_id,
      p_credit_account_id: parsed.data.inventory_account_id,
    });
    setReplaceSubmitting(false);
    if (error) {
      setReplaceError(error.message);
      return;
    }

    router.push(`/ap-bills/${id}`);
  }

  if (checkingSession) {
    return <LoadingScreen />;
  }

  if (!bill) {
    return <FormError>{loadError ?? "Bill gak ditemukan."}</FormError>;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href={`/ap-bills/${id}`} label="Kembali ke Detail Tagihan" />

      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-black">Tukar Barang</h1>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-sm font-mono text-slate-600">
            {bill.source_ref}
          </span>
        </div>
        <p className="text-sm text-slate-500">
          Barang rusak keluar, barang baik masuk — murni reklasifikasi stok, gak nyentuh Utang Usaha sama sekali
          (berdiri sendiri, gak lewat retur Opsi A). Utang Usaha bill ini tetap penuh.
        </p>
      </div>

      {!goodsReceipt && (
        <FormError>
          Bill ini gak lewat Barang Masuk (financial-only) — Tukar Barang wajib punya qty fisik, gak bisa dipakai di
          bill ini.
        </FormError>
      )}
      {!canWrite && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-700">
          Kamu belum punya role admin/accountant — submit di bawah kemungkinan bakal ketolak RLS.
        </p>
      )}

      <form onSubmit={handleReplaceSubmit} className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="replace_date">Tanggal</Label>
                <Input
                  id="replace_date"
                  type="date"
                  value={replaceDate}
                  onChange={(e) => setReplaceDate(e.target.value)}
                />
              </div>
              <LockedAccountField
                label="Akun Persediaan (debit barang masuk & kredit barang keluar)"
                htmlFor="replace_inventory_account"
                resolved={defaultAccounts["inventory.raw_material"]}
              />
            </div>

            <div className="mt-4 flex flex-col gap-2">
              <div className="grid grid-cols-[1fr_8rem] gap-2 text-sm font-medium text-slate-500">
                <span>Item Diterima (sisa bisa diklaim)</span>
                <span>Qty Tukar</span>
              </div>
              {replaceLines.map((line) => (
                <div key={line.item_id} className="grid grid-cols-[1fr_8rem] gap-2">
                  <span className="flex items-center text-sm text-slate-700">
                    {line.name} ({line.qty_available} {line.uom})
                  </span>
                  <Input
                    type="number"
                    min="0"
                    max={line.qty_available}
                    placeholder="0"
                    value={line.qty}
                    onChange={(e) => updateReplaceLine(line.item_id, e.target.value)}
                  />
                </div>
              ))}
              {replaceLines.length === 0 && (
                <p className="text-sm text-slate-400">
                  Semua item di bill ini udah diklaim penuh (retur atau tukar barang).
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4 lg:sticky lg:top-4 lg:col-span-1 lg:self-start">
          <JournalPreviewPanel
            groups={[
              [
                {
                  label: "Akun Persediaan (debit barang masuk & kredit barang keluar)",
                  resolved: defaultAccounts["inventory.raw_material"],
                },
              ],
            ]}
          />

          {replaceError && <FormError>{replaceError}</FormError>}

          <div className="flex flex-col gap-2">
            <Button type="submit" disabled={replaceSubmitting || replaceLines.length === 0}>
              {replaceSubmitting ? "Menyimpan..." : "Simpan Tukar Barang"}
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
