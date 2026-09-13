"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { type ArInvoice } from "@/lib/ar-invoices/schema";
import { type GoodsIssueForInvoice } from "@/lib/ar-credit-notes/schema";
import { createWarrantyReplacementSchema } from "@/lib/ar-warranty-replacements/schema";
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

type ReplacementLineInput = { item_id: string; name: string; uom: string; qty_remaining: number; qty: string };

type CreditNoteDetail = {
  id: string;
  return_lines: { item_id: string; qty_returned: number }[];
};

type ReplacementDetail = {
  id: string;
  replacement_lines: { item_id: string; qty_replaced: number }[];
};

export default function CreateWarrantyReplacementPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [invoice, setInvoice] = useState<ArInvoice | null>(null);
  const [goodsIssue, setGoodsIssue] = useState<GoodsIssueForInvoice | null>(null);
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [replaceDate, setReplaceDate] = useState("");
  const [replaceLines, setReplaceLines] = useState<ReplacementLineInput[]>([]);
  const [replaceError, setReplaceError] = useState<string | null>(null);
  const [replaceSubmitting, setReplaceSubmitting] = useState(false);

  // Ganti Barang sekarang aksi top-level di invoice (bukan per-baris credit note lagi) --
  // sisa yang bisa diganti per item = qty_issued dikurangi SEMUA yang udah diklaim lintas
  // jalur (retur kredit + ganti barang sebelumnya), mirror sales_returned_qty() server-side
  // (memory/scope-debt/ar-retur-mutually-exclusive.md).
  const load = useCallback(async () => {
    const { data: inv, error: invErr } = await supabase
      .from("transactions")
      .select("id, customer_id:counterparty_id, invoice_date:date, due_date, description, source_ref, amount, journal_entry_id, created_at, counterparties(name)")
      .eq("id", id)
      .eq("type", "OUTBOUND")
      .single();
    if (invErr || !inv) {
      setLoadError(invErr?.message ?? "Invoice gak ditemukan.");
      return;
    }
    setInvoice(inv as unknown as ArInvoice);

    const [defAccs, { data: gi }, { data: cns }, { data: reps }] = await Promise.all([
      fetchDefaultAccounts(),
      supabase
        .from("goods_notes")
        .select("id, goods_note_lines(item_id, qty, order_line_id, items(name, uom), order_lines(unit_price))")
        .eq("transaction_id", id)
        .eq("type", "OUTBOUND")
        .maybeSingle(),
      supabase
        .from("returns")
        .select("id, return_lines(item_id, qty_returned)")
        .eq("transaction_id", id)
        .eq("type", "INBOUND"),
      supabase
        .from("replacements")
        .select("id, replacement_lines(item_id, qty_replaced)")
        .eq("transaction_id", id)
        .eq("type", "INBOUND"),
    ]);

    setDefaultAccounts(defAccs);
    const loadedGoodsIssue = (gi ?? null) as unknown as GoodsIssueForInvoice | null;
    setGoodsIssue(loadedGoodsIssue);

    const creditNotes = (cns ?? []) as unknown as CreditNoteDetail[];
    const replacements = (reps ?? []) as unknown as ReplacementDetail[];

    const alreadyClaimed = new Map<string, number>();
    for (const cn of creditNotes) {
      for (const l of cn.return_lines) {
        alreadyClaimed.set(l.item_id, (alreadyClaimed.get(l.item_id) ?? 0) + l.qty_returned);
      }
    }
    for (const r of replacements) {
      for (const l of r.replacement_lines) {
        alreadyClaimed.set(l.item_id, (alreadyClaimed.get(l.item_id) ?? 0) + l.qty_replaced);
      }
    }

    setReplaceDate("");
    setReplaceLines(
      loadedGoodsIssue
        ? loadedGoodsIssue.goods_note_lines
            .map((l) => ({
              item_id: l.item_id,
              name: l.items.name,
              uom: l.items.uom,
              qty_remaining: l.qty - (alreadyClaimed.get(l.item_id) ?? 0),
              qty: "",
            }))
            .filter((l) => l.qty_remaining > 0)
        : []
    );
    setLoadError(null);
  }, [id]);

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
    if (!invoice) return;
    setReplaceError(null);

    const activeLines = replaceLines
      .filter((l) => l.qty.trim() !== "")
      .map((l) => ({ item_id: l.item_id, qty: l.qty }));

    const parsed = createWarrantyReplacementSchema.safeParse({
      invoice_id: invoice.id,
      replacement_date: replaceDate,
      lines: activeLines,
      hpp_account_id: defaultAccounts["inventory.hpp"]?.id ?? "",
      finished_good_account_id: defaultAccounts["inventory.finished_good"]?.id ?? "",
    });
    if (!parsed.success) {
      setReplaceError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setReplaceSubmitting(true);
    let sourceRef: string;
    try {
      sourceRef = await generateDocumentNumber("warranty_replacements");
    } catch (err) {
      setReplaceSubmitting(false);
      setReplaceError(err instanceof Error ? err.message : "Gagal generate nomor dokumen");
      return;
    }
    const { error } = await supabase.rpc("create_replacement", {
      p_type: "INBOUND",
      p_transaction_id: parsed.data.invoice_id,
      p_replacement_date: parsed.data.replacement_date,
      p_source_ref: sourceRef,
      p_lines: parsed.data.lines,
      p_debit_account_id: parsed.data.hpp_account_id,
      p_credit_account_id: parsed.data.finished_good_account_id,
    });
    setReplaceSubmitting(false);
    if (error) {
      setReplaceError(error.message);
      return;
    }

    router.push(`/ar-invoices/${id}`);
  }

  if (checkingSession) {
    return <LoadingScreen />;
  }

  if (!invoice) {
    return <FormError>{loadError ?? "Invoice gak ditemukan."}</FormError>;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");
  // Jurnal HPP/Persediaan cuma kejadian kalau ada qty yang beneran diisi.
  const replaceAnyQty = replaceLines.some((l) => (Number(l.qty) || 0) > 0);

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href={`/ar-invoices/${id}`} label="Kembali ke Detail Invoice" />

      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold text-black">Tukar Barang (Garansi)</h1>
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-sm font-mono text-slate-600">
          {invoice.source_ref}
        </span>
      </div>
      <p className="-mt-4 text-sm text-slate-500">
        Barang pengganti keluar dari stok (dijurnal HPP/Persediaan Barang Jadi) — gak nyentuh
        Piutang Usaha sama sekali, murni tukar barang. Qty yang sama cuma boleh diklaim SATU
        jalur: kalau item ini udah diretur pakai diskon (tab Retur), sisa yang bisa diganti di
        sini otomatis berkurang segitu — gak bisa dua-duanya.
      </p>

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
                label="Akun HPP (debit)"
                htmlFor="replace_hpp_account"
                resolved={defaultAccounts["inventory.hpp"]}
              />
              <LockedAccountField
                label="Akun Persediaan Barang Jadi (kredit)"
                htmlFor="replace_finished_good_account"
                resolved={defaultAccounts["inventory.finished_good"]}
              />
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <p className="mb-3 text-sm font-medium text-black">Item Diganti</p>
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-[1fr_8rem] gap-2 text-sm font-medium text-slate-500">
                <span>Item (sisa bisa diganti)</span>
                <span>Qty Ganti</span>
              </div>
              {replaceLines.map((line) => (
                <div key={line.item_id} className="grid grid-cols-[1fr_8rem] gap-2">
                  <span className="flex items-center text-sm text-slate-700">
                    {line.name} ({line.qty_remaining} {line.uom})
                  </span>
                  <Input
                    type="number"
                    min="0"
                    max={line.qty_remaining}
                    placeholder="0"
                    value={line.qty}
                    onChange={(e) => updateReplaceLine(line.item_id, e.target.value)}
                  />
                </div>
              ))}
              {replaceLines.length === 0 && (
                <p className="text-sm text-slate-400">Semua item terjual di invoice ini udah diretur/diganti penuh.</p>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4 lg:sticky lg:top-4 lg:col-span-1 lg:self-start">
          <JournalPreviewPanel
            groups={[
              replaceAnyQty && [
                { label: "Akun HPP (debit)", resolved: defaultAccounts["inventory.hpp"], side: "debit" },
                {
                  label: "Akun Persediaan Barang Jadi (kredit)",
                  resolved: defaultAccounts["inventory.finished_good"],
                  side: "credit",
                },
              ],
            ]}
          />

          {replaceError && <FormError>{replaceError}</FormError>}

          <div className="flex flex-col gap-2">
            <Button type="submit" disabled={replaceSubmitting || replaceLines.length === 0}>
              {replaceSubmitting ? "Menyimpan..." : "Simpan Penggantian"}
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
