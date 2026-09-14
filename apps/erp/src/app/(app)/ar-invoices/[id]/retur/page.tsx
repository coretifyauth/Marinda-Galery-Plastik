"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { invoiceStatus, type ArInvoice } from "@/lib/ar-invoices/schema";
import { createArCreditNoteSchema, type GoodsIssueForInvoice } from "@/lib/ar-credit-notes/schema";
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

type ReturnLineInput = {
  item_id: string;
  name: string;
  uom: string;
  qty_available: number;
  qty_returned: string;
  unit_price: number | null;
};

export default function CreateArCreditNotePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [invoice, setInvoice] = useState<ArInvoice | null>(null);
  const [goodsIssue, setGoodsIssue] = useState<GoodsIssueForInvoice | null>(null);
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});
  const [reversedEntryIds, setReversedEntryIds] = useState<Set<string>>(new Set());
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [returDate, setReturDate] = useState("");
  const [returAmount, setReturAmount] = useState("");
  const [returLines, setReturLines] = useState<ReturnLineInput[]>([]);
  const [returError, setReturError] = useState<string | null>(null);
  const [returSubmitting, setReturSubmitting] = useState(false);

  // Nominal retur otomatis dihitung dari qty x harga jual per item (order_lines.unit_price),
  // cuma valid kalau SEMUA baris yang qty-nya diisi punya harga itu -- item dari jalur jual
  // langsung (walk-in, gak lewat Sales Order) gak punya harga per item di mana pun (lihat
  // docs/domain/print-templates.md "Harga Per Item"), jadi baris kayak gitu tetap wajib input manual.
  const returActiveLines = returLines.filter((l) => (Number(l.qty_returned) || 0) > 0);
  const returAutoCalcEligible =
    !!goodsIssue && returActiveLines.length > 0 && returActiveLines.every((l) => l.unit_price != null);
  const returAutoAmount = returAutoCalcEligible
    ? returActiveLines.reduce((sum, l) => sum + (l.unit_price ?? 0) * (Number(l.qty_returned) || 0), 0)
    : null;
  const effectiveReturAmount = returAutoCalcEligible ? returAutoAmount ?? 0 : Number(returAmount) || 0;

  const load = useCallback(async () => {
    const { data: inv, error: invErr } = await supabase
      .from("transactions")
      .select(
        "id, customer_id:counterparty_id, invoice_date:date, due_date, description, source_ref, amount, journal_entry_id, created_at, counterparties(name), ar_payments:payments(amount), ar_returns:returns(amount, ar_return_credits:return_credits(amount)), ar_deposit_applications:deposit_applications(amount)"
      )
      .eq("id", id)
      .eq("type", "OUTBOUND")
      .single();
    if (invErr || !inv) {
      setLoadError(invErr?.message ?? "Invoice gak ditemukan.");
      return;
    }
    const loadedInvoice = inv as unknown as ArInvoice;
    setInvoice(loadedInvoice);

    const [defAccs, { data: reversedRows }, { data: gi }] = await Promise.all([
      fetchDefaultAccounts(),
      supabase.from("journal_entries").select("reverses_entry_id").not("reverses_entry_id", "is", null),
      supabase
        .from("goods_notes")
        .select("id, goods_note_lines(item_id, qty, order_line_id, items(name, uom), order_lines(unit_price))")
        .eq("transaction_id", id)
        .eq("type", "OUTBOUND")
        .maybeSingle(),
    ]);

    setDefaultAccounts(defAccs);
    setReversedEntryIds(
      new Set(((reversedRows ?? []) as { reverses_entry_id: string }[]).map((r) => r.reverses_entry_id))
    );
    const loadedGoodsIssue = (gi ?? null) as unknown as GoodsIssueForInvoice | null;
    setGoodsIssue(loadedGoodsIssue);

    setReturDate("");
    setReturAmount("");
    setReturLines(
      loadedGoodsIssue
        ? loadedGoodsIssue.goods_note_lines.map((l) => ({
            item_id: l.item_id,
            name: l.items.name,
            uom: l.items.uom,
            qty_available: l.qty,
            qty_returned: "",
            unit_price: l.order_lines?.unit_price ?? null,
          }))
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

  function updateReturLine(itemId: string, qty: string) {
    setReturLines((prev) => prev.map((l) => (l.item_id === itemId ? { ...l, qty_returned: qty } : l)));
  }

  async function handleReturSubmit(e: FormEvent) {
    e.preventDefault();
    if (!invoice) return;
    setReturError(null);

    const activeLines = returLines
      .filter((l) => l.qty_returned.trim() !== "")
      .map((l) => ({ item_id: l.item_id, qty_returned: l.qty_returned }));

    const parsed = createArCreditNoteSchema.safeParse({
      invoice_id: invoice.id,
      credit_note_date: returDate,
      amount: effectiveReturAmount,
      contra_revenue_account_id: defaultAccounts["ar.contra_revenue"]?.id ?? "",
      receivable_account_id: defaultAccounts["ar.receivable"]?.id ?? "",
      lines: activeLines,
      hpp_account_id: defaultAccounts["inventory.hpp"]?.id || undefined,
      finished_good_account_id: defaultAccounts["inventory.finished_good"]?.id || undefined,
      return_credit_liability_account_id: defaultAccounts["ar.return_credit_liability"]?.id || undefined,
    });
    if (!parsed.success) {
      setReturError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }
    if (goodsIssue && activeLines.length === 0) {
      setReturError("Invoice ini lewat goods issue — isi minimal 1 baris qty retur");
      return;
    }

    setReturSubmitting(true);
    let sourceRef: string;
    try {
      sourceRef = await generateDocumentNumber("ar_credit_notes");
    } catch (err) {
      setReturSubmitting(false);
      setReturError(err instanceof Error ? err.message : "Gagal generate nomor dokumen");
      return;
    }
    const { error } = await supabase.rpc("create_ar_return", {
      p_invoice_id: parsed.data.invoice_id,
      p_credit_note_date: parsed.data.credit_note_date,
      p_source_ref: sourceRef,
      p_amount: parsed.data.amount,
      p_contra_revenue_account_id: parsed.data.contra_revenue_account_id,
      p_receivable_account_id: parsed.data.receivable_account_id,
      p_lines: parsed.data.lines.length > 0 ? parsed.data.lines : null,
      p_hpp_account_id: parsed.data.hpp_account_id ?? null,
      p_finished_good_account_id: parsed.data.finished_good_account_id ?? null,
      p_return_credit_liability_account_id: parsed.data.return_credit_liability_account_id ?? null,
    });
    setReturSubmitting(false);
    if (error) {
      setReturError(error.message);
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

  const isCancelled = reversedEntryIds.has(invoice.journal_entry_id);
  const { outstanding } = invoiceStatus(invoice, isCancelled);
  const canWrite = roles.includes("admin") || roles.includes("accountant");

  // Sama pola kayak returExcess di ap-bills/[id]/view.tsx -- excess cuma kejadian kalau
  // nominal retur ngelebihin outstanding invoice saat ini.
  const returExcess = Math.max(0, effectiveReturAmount - Math.max(0, outstanding));
  const returHasQty = returLines.some((l) => (Number(l.qty_returned) || 0) > 0);

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href={`/ar-invoices/${id}`} label="Kembali ke Detail Invoice" />

      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold text-black">Catat Retur</h1>
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-sm font-mono text-slate-600">
          {invoice.source_ref}
        </span>
      </div>
      <p className="-mt-4 text-sm text-slate-500">
        {goodsIssue
          ? "Invoice ini lewat Barang Keluar — isi qty per item yang balik, stok & HPP otomatis ke-reverse proporsional."
          : "Invoice ini gak lewat Barang Keluar — retur cuma ngurangin piutang (kontra-revenue), gak ada stok yang disentuh."}
      </p>

      {!canWrite && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-700">
          Kamu belum punya role admin/accountant — submit di bawah kemungkinan bakal ketolak RLS.
        </p>
      )}

      <form onSubmit={handleReturSubmit} className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="retur_date">Tanggal Retur</Label>
                <Input id="retur_date" type="date" value={returDate} onChange={(e) => setReturDate(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="retur_amount">
                  Nominal Retur (kurangin piutang)
                  {returAutoCalcEligible && " — otomatis dari qty x harga jual"}
                </Label>
                <Input
                  id="retur_amount"
                  type="number"
                  min="0"
                  placeholder="0"
                  value={returAutoCalcEligible ? effectiveReturAmount : returAmount}
                  disabled={returAutoCalcEligible}
                  onChange={(e) => setReturAmount(e.target.value)}
                />
                {goodsIssue && !returAutoCalcEligible && returActiveLines.length > 0 && (
                  <p className="text-xs text-slate-500">
                    Ada item retur yang gak punya harga jual tercatat (bukan dari Sales Order) — isi nominal manual.
                  </p>
                )}
              </div>
              <LockedAccountField
                label="Akun Retur & Potongan Penjualan (debit)"
                htmlFor="retur_contra_account"
                resolved={defaultAccounts["ar.contra_revenue"]}
              />
              <LockedAccountField
                label="Akun Piutang Usaha (kredit)"
                htmlFor="retur_receivable_account"
                resolved={defaultAccounts["ar.receivable"]}
              />
              <LockedAccountField
                label="Akun Saldo Kredit Retur Pelanggan (kredit, cuma kalau retur ini bikin outstanding minus)"
                htmlFor="retur_credit_liability_account"
                resolved={defaultAccounts["ar.return_credit_liability"]}
              />
              {goodsIssue && (
                <>
                  <LockedAccountField
                    label="Akun HPP (kredit, jurnal reversal)"
                    htmlFor="retur_hpp_account"
                    resolved={defaultAccounts["inventory.hpp"]}
                  />
                  <LockedAccountField
                    label="Akun Persediaan Barang Jadi (debit, reversal HPP)"
                    htmlFor="retur_finished_good_account"
                    resolved={defaultAccounts["inventory.finished_good"]}
                  />
                </>
              )}
            </div>
          </div>

          {goodsIssue && (
            <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
              <p className="mb-3 text-sm font-medium text-black">Item Diretur</p>
              <div className="flex flex-col gap-2">
                <div className="grid grid-cols-[1fr_8rem] gap-2 text-sm font-medium text-slate-500">
                  <span>Item Terjual (qty asli)</span>
                  <span>Qty Retur</span>
                </div>
                {returLines.map((line) => (
                  <div key={line.item_id} className="grid grid-cols-[1fr_8rem] gap-2">
                    <span className="flex items-center text-sm text-slate-700">
                      {line.name} ({line.qty_available} {line.uom})
                    </span>
                    <Input
                      type="number"
                      min="0"
                      placeholder="0"
                      value={line.qty_returned}
                      onChange={(e) => updateReturLine(line.item_id, e.target.value)}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-4 lg:sticky lg:top-4 lg:col-span-1 lg:self-start">
          <JournalPreviewPanel
            groups={[
              [
                {
                  label: "Akun Retur & Potongan Penjualan (debit)",
                  resolved: defaultAccounts["ar.contra_revenue"],
                  side: "debit",
                },
                { label: "Akun Piutang Usaha (kredit)", resolved: defaultAccounts["ar.receivable"], side: "credit" },
              ],
              returExcess > 0 && [
                {
                  label: "Akun Piutang Usaha (debit) — retur ini ngelebihin outstanding",
                  resolved: defaultAccounts["ar.receivable"],
                  side: "debit",
                },
                {
                  label: "Akun Saldo Kredit Retur Pelanggan (kredit) — retur ini ngelebihin outstanding",
                  resolved: defaultAccounts["ar.return_credit_liability"],
                  side: "credit",
                },
              ],
              goodsIssue && returHasQty && [
                {
                  label: "Akun Persediaan Barang Jadi (debit, reversal HPP)",
                  resolved: defaultAccounts["inventory.finished_good"],
                  side: "debit",
                },
                {
                  label: "Akun HPP (kredit, jurnal reversal)",
                  resolved: defaultAccounts["inventory.hpp"],
                  side: "credit",
                },
              ],
            ]}
          />

          {returError && <FormError>{returError}</FormError>}

          <div className="flex flex-col gap-2">
            <Button type="submit" disabled={returSubmitting}>
              {returSubmitting ? "Menyimpan..." : "Simpan Retur"}
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
