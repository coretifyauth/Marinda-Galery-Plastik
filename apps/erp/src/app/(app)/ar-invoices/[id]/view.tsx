"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { invoiceStatus, type ArInvoice } from "@/lib/ar-invoices/schema";
import {
  createArCreditNoteSchema,
  type GoodsIssueForInvoice,
} from "@/lib/ar-credit-notes/schema";
import { applyArDepositSchema, depositStatus, type ArDeposit } from "@/lib/ar-deposits/schema";
import {
  createWarrantyReplacementSchema,
  type WarrantyReplacement,
} from "@/lib/ar-warranty-replacements/schema";
import { returnCreditRemaining, refundArReturnCreditSchema, type ArReturnCredit } from "@/lib/ar-return-credits/schema";
import { recordArPaymentSchema } from "@/lib/ar-payments/schema";
import type { ArInvoiceChargeType } from "@/lib/ar-invoice-charge-types/schema";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { Modal } from "@/components/ui/modal";
import { DetailRows } from "@/components/ui/detail-rows";
import { Tabs, type TabDef } from "@/components/ui/tabs";
import { LockedAccountField } from "@/components/ui/locked-account-field";
import { JournalPreviewPanel } from "@/components/ui/journal-preview-panel";
import { CashMethodField, resolveCashAccount } from "@/components/ui/cash-method-field";
import { fetchDefaultAccounts, type ResolvedAccount } from "@/lib/default-accounts/schema";
import { buildLetterheadHtml, buildSignatureBlockHtml, escapeHtml, openPrintWindow } from "@/lib/print/print-window";
import { fetchCompanySettings, type CompanySettings } from "@/lib/company-settings/schema";
import { fetchActiveSignatoryLabels } from "@/lib/document-signatories/schema";

type ReturnLineInput = {
  item_id: string;
  name: string;
  uom: string;
  qty_available: number;
  qty_returned: string;
  condition: "RESALABLE" | "DAMAGED";
  unit_price: number | null;
};
type ReplacementLineInput = { item_id: string; name: string; uom: string; qty_remaining: number; qty: string };

type JournalEntryDetail = {
  id: string;
  entry_date: string;
  description: string | null;
  source_ref: string;
  reverses_entry_id: string | null;
  journal_lines: { id: string; debit: number; credit: number; accounts: { code: string; name: string } }[];
};

type PaymentDetail = {
  id: string;
  payment_date: string;
  source_ref: string;
  amount: number;
};

type InvoiceCreditLine = {
  id: string;
  account_id: string;
  amount: number;
  is_tax: boolean;
  accounts: { code: string; name: string };
};

type DepositApplicationDetail = {
  id: string;
  amount: number;
  source_ref: string;
  journal_entry_id: string;
  ar_deposits: { source_ref: string };
};

type CreditNoteDetail = {
  id: string;
  credit_note_date: string;
  source_ref: string;
  amount: number;
  created_at: string;
  inventory_returns: {
    id: string;
    return_date: string;
    inventory_return_lines: {
      item_id: string;
      qty_returned: number;
      total_cost: number;
      condition: "RESALABLE" | "DAMAGED";
      items: { name: string; uom: string };
    }[];
  }[];
};

const statusStyle: Record<string, string> = {
  lunas: "bg-emerald-50 text-emerald-700",
  sebagian: "bg-amber-50 text-amber-700",
  belum: "bg-slate-100 text-slate-600",
  dibatalkan: "bg-slate-100 text-slate-400 line-through",
};

export function ArInvoiceDetailView({ id }: { id: string }) {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [invoice, setInvoice] = useState<ArInvoice | null>(null);
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});
  const [reversedEntryIds, setReversedEntryIds] = useState<Set<string>>(new Set());
  const [journalEntries, setJournalEntries] = useState<JournalEntryDetail[]>([]);
  const [payments, setPayments] = useState<PaymentDetail[]>([]);
  const [creditNotes, setCreditNotes] = useState<CreditNoteDetail[]>([]);
  const [depositApplications, setDepositApplications] = useState<DepositApplicationDetail[]>([]);
  const [customerDeposits, setCustomerDeposits] = useState<ArDeposit[]>([]);
  const [customerReturnCredits, setCustomerReturnCredits] = useState<ArReturnCredit[]>([]);
  const [goodsIssue, setGoodsIssue] = useState<GoodsIssueForInvoice | null>(null);
  const [creditLines, setCreditLines] = useState<InvoiceCreditLine[]>([]);
  const [chargeTypes, setChargeTypes] = useState<ArInvoiceChargeType[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [companySettings, setCompanySettings] = useState<CompanySettings | null>(null);
  const [signatoryLabels, setSignatoryLabels] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("jurnal");

  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const [showApplyForm, setShowApplyForm] = useState(false);
  const [applyDepositId, setApplyDepositId] = useState("");
  const [applyAmount, setApplyAmount] = useState("");
  const [applyDate, setApplyDate] = useState("");
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applySubmitting, setApplySubmitting] = useState(false);

  const [showReturForm, setShowReturForm] = useState(false);
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

  const [replacements, setReplacements] = useState<WarrantyReplacement[]>([]);
  const [showReplaceForm, setShowReplaceForm] = useState(false);
  const [replaceDate, setReplaceDate] = useState("");
  const [replaceLines, setReplaceLines] = useState<ReplacementLineInput[]>([]);
  const [replaceError, setReplaceError] = useState<string | null>(null);
  const [replaceSubmitting, setReplaceSubmitting] = useState(false);

  const [showPayForm, setShowPayForm] = useState(false);
  const [payDate, setPayDate] = useState("");
  const [payAmount, setPayAmount] = useState("");
  const [payMethod, setPayMethod] = useState<"TUNAI" | "BANK">("TUNAI");
  const [payError, setPayError] = useState<string | null>(null);
  const [paySubmitting, setPaySubmitting] = useState(false);

  const [refundCreditId, setRefundCreditId] = useState<string | null>(null);
  const [refundCreditAmount, setRefundCreditAmount] = useState("");
  const [refundCreditDate, setRefundCreditDate] = useState("");
  const [refundCreditMethod, setRefundCreditMethod] = useState<"TUNAI" | "BANK">("TUNAI");
  const [refundCreditError, setRefundCreditError] = useState<string | null>(null);
  const [refundCreditSubmitting, setRefundCreditSubmitting] = useState(false);

  const load = useCallback(async () => {
    const { data: inv, error: invErr } = await supabase
      .from("transactions")
      .select(
        "id, customer_id:counterparty_id, invoice_date:date, due_date, description, source_ref, amount, journal_entry_id, created_at, counterparties(name), ar_payments:payments(amount), ar_credit_notes:credit_notes(amount, ar_return_credits(amount), warranty_replacements(discount_reversed_amount, return_credit_settled_amount)), ar_deposit_applications(amount)"
      )
      .eq("id", id)
      .eq("type", "INBOUND")
      .single();
    if (invErr || !inv) {
      setLoadError(invErr?.message ?? "Invoice gak ditemukan.");
      return;
    }
    const loadedInvoice = inv as unknown as ArInvoice;
    setInvoice(loadedInvoice);

    const [
      defAccs,
      { data: reversedRows },
      { data: entries, error: entriesErr },
      { data: pay, error: payErr },
      { data: cns, error: cnErr },
      { data: reps, error: repErr },
      { data: gi },
      { data: creditLineRows },
      { data: chargeTypeRows },
      { data: depApps, error: depAppErr },
      { data: custDeposits, error: custDepositsErr },
      { data: custReturnCredits, error: custReturnCreditsErr },
    ] = await Promise.all([
      fetchDefaultAccounts(),
      supabase
        .from("journal_entries")
        .select("reverses_entry_id")
        .not("reverses_entry_id", "is", null),
      supabase
        .from("journal_entries")
        .select(
          "id, entry_date, description, source_ref, reverses_entry_id, journal_lines(id, debit, credit, accounts(code, name))"
        )
        .or(`id.eq.${loadedInvoice.journal_entry_id},reverses_entry_id.eq.${loadedInvoice.journal_entry_id}`)
        .order("entry_date"),
      supabase
        .from("payments")
        .select("id, payment_date, source_ref, amount")
        .eq("transaction_id", id)
        .order("payment_date"),
      supabase
        .from("credit_notes")
        .select(
          "id, credit_note_date, source_ref, amount, created_at, inventory_returns(id, return_date, inventory_return_lines(item_id, qty_returned, total_cost, condition, items(name, uom)))"
        )
        .eq("transaction_id", id)
        .eq("type", "INBOUND")
        .order("credit_note_date"),
      supabase
        .from("warranty_replacements")
        .select(
          "id, invoice_id, replacement_date, source_ref, created_at, warranty_replacement_lines(item_id, qty_replaced, total_cost, items(name, uom))"
        )
        .eq("invoice_id", id)
        .order("replacement_date"),
      supabase
        .from("goods_issues")
        .select(
          "id, goods_issue_lines(item_id, qty_issued, order_line_id, items(name, uom), order_lines(unit_price))"
        )
        .eq("invoice_id", id)
        .maybeSingle(),
      supabase
        .from("transaction_lines")
        .select("id, account_id, amount, is_tax, accounts(code, name)")
        .eq("transaction_id", id)
        .order("is_tax"),
      supabase.from("ar_invoice_charge_types").select("id, name, account_id, archived_at, accounts(code, name)"),
      supabase
        .from("ar_deposit_applications")
        .select("id, amount, source_ref, journal_entry_id, ar_deposits(source_ref)")
        .eq("invoice_id", id),
      supabase
        .from("ar_deposits")
        .select(
          "id, customer_id, deposit_date, source_ref, amount, journal_entry_id, created_at, counterparties(name), ar_deposit_applications(id, amount, source_ref, journal_entry_id, ar_invoices:transactions(source_ref)), ar_deposit_refunds(id, amount, refund_date, source_ref, journal_entry_id), ar_deposit_forfeitures(id, amount, forfeiture_date, source_ref, journal_entry_id)"
        )
        .eq("customer_id", loadedInvoice.customer_id)
        .order("deposit_date"),
      supabase
        .from("ar_return_credits")
        .select(
          "id, customer_id, credit_note_id, amount, journal_entry_id, created_at, counterparties(name), ar_credit_notes:credit_notes(source_ref, credit_note_date, warranty_replacements(return_credit_settled_amount)), ar_return_credit_refunds(id, amount, source_ref, journal_entry_id, created_at)"
        )
        .eq("customer_id", loadedInvoice.customer_id)
        .order("created_at"),
    ]);

    setDefaultAccounts(defAccs);
    const reversedSet = new Set(
      ((reversedRows ?? []) as { reverses_entry_id: string }[]).map((r) => r.reverses_entry_id)
    );
    setReversedEntryIds(reversedSet);
    setJournalEntries((entries ?? []) as unknown as JournalEntryDetail[]);
    setPayments((pay ?? []) as unknown as PaymentDetail[]);
    setCreditNotes((cns ?? []) as unknown as CreditNoteDetail[]);
    setCreditLines((creditLineRows ?? []) as unknown as InvoiceCreditLine[]);
    setChargeTypes((chargeTypeRows ?? []) as unknown as ArInvoiceChargeType[]);
    setReplacements((reps ?? []) as unknown as WarrantyReplacement[]);
    setGoodsIssue((gi ?? null) as unknown as GoodsIssueForInvoice | null);
    setDepositApplications((depApps ?? []) as unknown as DepositApplicationDetail[]);
    setCustomerDeposits((custDeposits ?? []) as unknown as ArDeposit[]);
    setCustomerReturnCredits((custReturnCredits ?? []) as unknown as ArReturnCredit[]);
    setLoadError(
      entriesErr?.message ??
        payErr?.message ??
        cnErr?.message ??
        repErr?.message ??
        depAppErr?.message ??
        custDepositsErr?.message ??
        custReturnCreditsErr?.message ??
        null
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
        .from("user_roles")
        .select("role_name")
        .eq("user_id", session.user.id);
      if (!active) return;
      setRoles(((roleRows ?? []) as { role_name: string }[]).map((r) => r.role_name));
      const [company, labels] = await Promise.all([fetchCompanySettings(), fetchActiveSignatoryLabels()]);
      if (!active) return;
      setCompanySettings(company);
      setSignatoryLabels(labels);
      await load();
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, load]);

  function openReturForm() {
    setReturError(null);
    setReturDate("");
    setReturAmount("");
    setReturLines(
      goodsIssue
        ? goodsIssue.goods_issue_lines.map((l) => ({
            item_id: l.item_id,
            name: l.items.name,
            uom: l.items.uom,
            qty_available: l.qty_issued,
            qty_returned: "",
            condition: "RESALABLE" as const,
            unit_price: l.order_lines?.unit_price ?? null,
          }))
        : []
    );
    setShowReturForm(true);
  }

  function updateReturLine(itemId: string, qty: string) {
    setReturLines((prev) => prev.map((l) => (l.item_id === itemId ? { ...l, qty_returned: qty } : l)));
  }

  function updateReturLineCondition(itemId: string, condition: "RESALABLE" | "DAMAGED") {
    setReturLines((prev) => prev.map((l) => (l.item_id === itemId ? { ...l, condition } : l)));
  }

  async function handleReturSubmit(e: FormEvent) {
    e.preventDefault();
    if (!invoice) return;
    setReturError(null);

    const activeLines = returLines
      .filter((l) => l.qty_returned.trim() !== "")
      .map((l) => ({ item_id: l.item_id, qty_returned: l.qty_returned, condition: l.condition }));

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
      loss_expense_account_id: defaultAccounts["inventory.damage_loss_expense"]?.id || undefined,
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
    const { error } = await supabase.rpc("create_ar_credit_note", {
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
      p_loss_expense_account_id: parsed.data.loss_expense_account_id ?? null,
    });
    setReturSubmitting(false);
    if (error) {
      setReturError(error.message);
      return;
    }

    setShowReturForm(false);
    await load();
  }

  // Ganti Barang sekarang aksi top-level di invoice (bukan per-baris credit note lagi) --
  // sisa yang bisa diganti per item = qty_issued dikurangi SEMUA yang udah diklaim lintas
  // jalur (retur kredit + ganti barang sebelumnya), mirror sales_returned_qty() server-side
  // (memory/scope-debt/ar-retur-mutually-exclusive.md).
  function openReplaceForm() {
    if (!goodsIssue) return;

    const alreadyClaimed = new Map<string, number>();
    for (const cn of creditNotes) {
      for (const ret of cn.inventory_returns) {
        for (const l of ret.inventory_return_lines) {
          alreadyClaimed.set(l.item_id, (alreadyClaimed.get(l.item_id) ?? 0) + l.qty_returned);
        }
      }
    }
    for (const r of replacements) {
      for (const l of r.warranty_replacement_lines) {
        alreadyClaimed.set(l.item_id, (alreadyClaimed.get(l.item_id) ?? 0) + l.qty_replaced);
      }
    }

    setReplaceError(null);
    setReplaceDate("");
    setReplaceLines(
      goodsIssue.goods_issue_lines
        .map((l) => ({
          item_id: l.item_id,
          name: l.items.name,
          uom: l.items.uom,
          qty_remaining: l.qty_issued - (alreadyClaimed.get(l.item_id) ?? 0),
          qty: "",
        }))
        .filter((l) => l.qty_remaining > 0)
    );
    setShowReplaceForm(true);
  }

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
    const { error } = await supabase.rpc("create_warranty_replacement", {
      p_invoice_id: parsed.data.invoice_id,
      p_replacement_date: parsed.data.replacement_date,
      p_source_ref: sourceRef,
      p_lines: parsed.data.lines,
      p_hpp_account_id: parsed.data.hpp_account_id,
      p_finished_good_account_id: parsed.data.finished_good_account_id,
    });
    setReplaceSubmitting(false);
    if (error) {
      setReplaceError(error.message);
      return;
    }

    setShowReplaceForm(false);
    await load();
  }

  function openApplyForm() {
    setApplyError(null);
    setApplyDepositId("");
    setApplyAmount("");
    setApplyDate("");
    setShowApplyForm(true);
  }

  async function handleApplySubmit(e: FormEvent) {
    e.preventDefault();
    if (!invoice) return;
    setApplyError(null);

    const parsed = applyArDepositSchema.safeParse({
      deposit_id: applyDepositId,
      invoice_id: invoice.id,
      amount: applyAmount,
      entry_date: applyDate,
      deposit_liability_account_id: defaultAccounts["ar.deposit_liability"]?.id ?? "",
      receivable_account_id: defaultAccounts["ar.receivable"]?.id ?? "",
    });
    if (!parsed.success) {
      setApplyError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setApplySubmitting(true);
    let sourceRef: string;
    try {
      sourceRef = await generateDocumentNumber("ar_deposit_applications");
    } catch (err) {
      setApplySubmitting(false);
      setApplyError(err instanceof Error ? err.message : "Gagal generate nomor dokumen");
      return;
    }
    const { error } = await supabase.rpc("apply_ar_deposit", {
      p_deposit_id: parsed.data.deposit_id,
      p_invoice_id: parsed.data.invoice_id,
      p_amount: parsed.data.amount,
      p_entry_date: parsed.data.entry_date,
      p_source_ref: sourceRef,
      p_deposit_liability_account_id: parsed.data.deposit_liability_account_id,
      p_receivable_account_id: parsed.data.receivable_account_id,
    });
    setApplySubmitting(false);
    if (error) {
      setApplyError(error.message);
      return;
    }

    setShowApplyForm(false);
    await load();
  }

  async function handleCancel() {
    if (!invoice) return;
    if (!window.confirm(`Batalkan invoice ${invoice.source_ref} (Rp${invoice.amount.toLocaleString("id-ID")})?`)) return;

    setCancelError(null);
    setCancelling(true);
    let sourceRef: string;
    try {
      sourceRef = await generateDocumentNumber("journal_entries");
    } catch (err) {
      setCancelling(false);
      setCancelError(err instanceof Error ? err.message : "Gagal generate nomor dokumen");
      return;
    }
    const { error } = await supabase.rpc("cancel_ar_invoice", {
      p_invoice_id: invoice.id,
      p_entry_date: new Date().toISOString().slice(0, 10),
      p_source_ref: sourceRef,
    });
    setCancelling(false);
    if (error) {
      setCancelError(error.message);
      return;
    }
    await load();
  }

  function openPayForm() {
    setPayError(null);
    setPayDate("");
    setPayAmount("");
    setPayMethod("TUNAI");
    setShowPayForm(true);
  }

  async function handlePaySubmit(e: FormEvent) {
    e.preventDefault();
    if (!invoice) return;
    setPayError(null);

    const parsed = recordArPaymentSchema.safeParse({
      customer_id: invoice.customer_id,
      payment_date: payDate,
      amount: payAmount,
      cash_account_id: resolveCashAccount(payMethod, defaultAccounts)?.id ?? "",
      receivable_account_id: defaultAccounts["ar.receivable"]?.id ?? "",
      invoice_id: invoice.id,
    });
    if (!parsed.success) {
      setPayError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setPaySubmitting(true);
    let sourceRef: string;
    try {
      sourceRef = await generateDocumentNumber("ar_payments");
    } catch (err) {
      setPaySubmitting(false);
      setPayError(err instanceof Error ? err.message : "Gagal generate nomor dokumen");
      return;
    }
    const { error } = await supabase.rpc("record_payment", {
      p_type: "INBOUND",
      p_counterparty_id: parsed.data.customer_id,
      p_payment_date: parsed.data.payment_date,
      p_amount: parsed.data.amount,
      p_source_ref: sourceRef,
      p_cash_account_id: parsed.data.cash_account_id,
      p_control_account_id: parsed.data.receivable_account_id,
      p_transaction_id: parsed.data.invoice_id,
    });
    setPaySubmitting(false);
    if (error) {
      setPayError(error.message);
      return;
    }

    setShowPayForm(false);
    await load();
  }

  function openRefundCreditForm(creditId: string) {
    setRefundCreditError(null);
    setRefundCreditAmount("");
    setRefundCreditDate("");
    setRefundCreditMethod("TUNAI");
    setRefundCreditId(creditId);
  }

  async function handleRefundCreditSubmit(e: FormEvent) {
    e.preventDefault();
    if (!refundCreditId) return;
    setRefundCreditError(null);

    const parsed = refundArReturnCreditSchema.safeParse({
      credit_id: refundCreditId,
      amount: refundCreditAmount,
      entry_date: refundCreditDate,
      return_credit_liability_account_id: defaultAccounts["ar.return_credit_liability"]?.id ?? "",
      cash_account_id: resolveCashAccount(refundCreditMethod, defaultAccounts)?.id ?? "",
    });
    if (!parsed.success) {
      setRefundCreditError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setRefundCreditSubmitting(true);
    let sourceRef: string;
    try {
      sourceRef = await generateDocumentNumber("ar_return_credit_refunds");
    } catch (err) {
      setRefundCreditSubmitting(false);
      setRefundCreditError(err instanceof Error ? err.message : "Gagal generate nomor dokumen");
      return;
    }
    const { error } = await supabase.rpc("refund_ar_return_credit", {
      p_credit_id: parsed.data.credit_id,
      p_amount: parsed.data.amount,
      p_entry_date: parsed.data.entry_date,
      p_source_ref: sourceRef,
      p_return_credit_liability_account_id: parsed.data.return_credit_liability_account_id,
      p_cash_account_id: parsed.data.cash_account_id,
    });
    setRefundCreditSubmitting(false);
    if (error) {
      setRefundCreditError(error.message);
      return;
    }

    setRefundCreditId(null);
    await load();
  }

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  if (!invoice) {
    return <FormError>{loadError ?? "Invoice gak ditemukan."}</FormError>;
  }

  const isCancelled = reversedEntryIds.has(invoice.journal_entry_id);
  const { status, outstanding, allocated, returned, depositApplied } = invoiceStatus(invoice, isCancelled);
  const overdue =
    status !== "lunas" && status !== "dibatalkan" && invoice.due_date < new Date().toISOString().slice(0, 10);
  const canWrite = roles.includes("admin") || roles.includes("accountant");
  const canCancel = canWrite && !isCancelled && allocated === 0;
  const canPay = canWrite && !isCancelled && outstanding > 0.005;
  const canRetur = canWrite && !isCancelled;
  const invoiceReturnCredits = customerReturnCredits.filter((rc) =>
    creditNotes.some((cn) => cn.id === rc.credit_note_id)
  );
  const availableDeposits = customerDeposits.filter(
    (dep) => depositStatus(dep, reversedEntryIds).remaining > 0.005
  );
  const canApplyDeposit = canWrite && !isCancelled && outstanding > 0 && availableDeposits.length > 0;
  const selectedDeposit = availableDeposits.find((dep) => dep.id === applyDepositId) ?? null;
  const selectedDepositRemaining = selectedDeposit ? depositStatus(selectedDeposit, reversedEntryIds).remaining : 0;
  // Ganti Barang independen dari credit note sekarang (mirror create_purchase_replacement AP) --
  // cuma butuh goods_issue ada (invoice financial-only gak punya barang fisik buat ditukar).
  const canReplace = canWrite && !isCancelled && !!goodsIssue;
  // Jurnal HPP/Persediaan cuma kejadian kalau ada qty yang beneran diisi.
  const replaceAnyQty = replaceLines.some((l) => (Number(l.qty) || 0) > 0);

  // Sama pola kayak returExcess di ap-bills/[id]/view.tsx -- excess cuma kejadian kalau
  // nominal retur ngelebihin outstanding invoice saat ini.
  const returExcess = Math.max(0, effectiveReturAmount - Math.max(0, outstanding));
  const returHasResalable = returLines.some(
    (l) => l.condition === "RESALABLE" && (Number(l.qty_returned) || 0) > 0
  );
  const returHasDamaged = returLines.some(
    (l) => l.condition === "DAMAGED" && (Number(l.qty_returned) || 0) > 0
  );

  // Cetak selalu render dari state yang barusan di-`load()` -- gak ada snapshot tersimpan,
  // jadi cetak ulang kapan pun otomatis nunjukkan kondisi terkini (retur/write-off/pembatalan
  // yang terjadi setelah cetakan pertama), bukan angka beku waktu pertama dicetak. Kop surat
  // (company_settings) + blok tanda tangan (document_signatories) dibaca live juga.
  function handlePrint() {
    if (!invoice) return;

    // Harga per item cuma ada kalau line-nya fulfillment Sales Order (satu-satunya tempat
    // unit_price ketracking) -- jalur jual langsung gak punya harga per item di mana pun,
    // invoice-nya cuma nyimpen total lump-sum per kategori. Kalau gak ada satu pun line yang
    // punya harga, tabel item cukup qty (jangan pura-pura ada kolom harga kosong).
    const hasItemPrice = !!goodsIssue?.goods_issue_lines.some((l) => l.order_lines);
    const itemRows = goodsIssue
      ? goodsIssue.goods_issue_lines
          .map((l) => {
            const unitPrice = l.order_lines?.unit_price;
            const subtotal = unitPrice != null ? unitPrice * l.qty_issued : null;
            return hasItemPrice
              ? `<tr>
                  <td>${escapeHtml(l.items.name)}</td>
                  <td class="num">${l.qty_issued} ${escapeHtml(l.items.uom)}</td>
                  <td class="num">${unitPrice != null ? `Rp${unitPrice.toLocaleString("id-ID")}` : "-"}</td>
                  <td class="num">${subtotal != null ? `Rp${subtotal.toLocaleString("id-ID")}` : "-"}</td>
                </tr>`
              : `<tr><td>${escapeHtml(l.items.name)}</td><td class="num">${l.qty_issued} ${escapeHtml(l.items.uom)}</td></tr>`;
          })
          .join("")
      : "";
    const itemSection = goodsIssue
      ? `<table><thead><tr>
          <th>Barang</th><th class="num">Qty Dikirim</th>
          ${hasItemPrice ? `<th class="num">Harga/Unit</th><th class="num">Subtotal</th>` : ""}
        </tr></thead><tbody>${itemRows}</tbody></table>`
      : `<p class="meta">Invoice financial-only — gak ada rincian barang fisik tercatat.</p>`;

    const watermark = status === "dibatalkan" ? `<div class="watermark">Dibatalkan</div>` : "";

    // Rincian ar_invoice_credit_lines (kategori pendapatan tambahan + PPN Keluaran, migration
    // 0025_compound_transactional_entries_schema.sql). Baris pendapatan UTAMA (akun ar.revenue,
    // dipilih otomatis lewat LockedAccountField, bukan katalog) sengaja DIKELUARKAN dari breakdown
    // ini -- sudah terwakili tabel barang + "Jumlah Invoice", nampilinnya lagi di sini cuma
    // ngulang. Yang ditampilkan cuma baris yang beneran "tambahan": PPN, dan kategori yang
    // match ke katalog ar_invoice_charge_types -- dilabeli pakai NAMA KATEGORI (customer-facing,
    // diisi admin di Settings), BUKAN nama akun COA internal (bug 2026-08-15: sempat nampilin
    // "Pendapatan Penjualan Grosir"/"Pendapatan Lain-lain" -- nama akun buku besar, bukan sesuatu
    // yang customer perlu tahu).
    const chargeLabelByAccountId = new Map(chargeTypes.map((ct) => [ct.account_id, ct.name]));
    const extraLineRows = creditLines
      .filter((cl) => cl.is_tax || chargeLabelByAccountId.has(cl.account_id))
      .map(
        (cl) =>
          `<tr><td>${cl.is_tax ? "PPN Keluaran" : escapeHtml(chargeLabelByAccountId.get(cl.account_id)!)}</td><td class="num">Rp${cl.amount.toLocaleString("id-ID")}</td></tr>`
      )
      .join("");

    // Baris ringkasan yang berasal dari relasi objek lain (pembayaran/DP/retur) cuma
    // ditampilkan kalau nilainya beneran ada (>0) -- invoice yang belum pernah kena
    // retur gak perlu nunjukkan baris "Retur: Rp0" di kertas.
    const summaryRows = [
      { label: "Jumlah Invoice", value: invoice.amount },
      allocated > 0.005 && { label: "Terbayar (Kas/Bank)", value: allocated },
      depositApplied > 0.005 && { label: "DP Diterapkan", value: depositApplied },
      returned > 0.005 && { label: "Retur", value: returned },
    ]
      .filter((row): row is { label: string; value: number } => !!row)
      .map((row) => `<tr><td>${row.label}</td><td class="num">Rp${row.value.toLocaleString("id-ID")}</td></tr>`)
      .join("");

    const body = `
      ${buildLetterheadHtml(companySettings)}
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;">
        <div>
          <h1>Invoice</h1>
          <div class="meta">${escapeHtml(invoice.source_ref)}</div>
        </div>
      </div>
      ${watermark}
      <table>
        <tbody>
          <tr><td class="meta">Customer</td><td>${escapeHtml(invoice.counterparties.name)}</td></tr>
          <tr><td class="meta">Tanggal Invoice</td><td>${escapeHtml(invoice.invoice_date)}</td></tr>
          <tr><td class="meta">Jatuh Tempo</td><td>${escapeHtml(invoice.due_date)}</td></tr>
          ${invoice.description ? `<tr><td class="meta">Deskripsi</td><td>${escapeHtml(invoice.description)}</td></tr>` : ""}
        </tbody>
      </table>
      <div style="margin-top:20px;">${itemSection}</div>
      <table style="margin-top:20px;">
        <tbody>
          ${extraLineRows}
          ${summaryRows}
          <tr class="total-row"><td>Outstanding</td><td class="num">Rp${outstanding.toLocaleString("id-ID")}</td></tr>
        </tbody>
      </table>
      ${buildSignatureBlockHtml(signatoryLabels)}
    `;

    if (!openPrintWindow(`Invoice ${invoice.source_ref}`, body)) {
      setLoadError("Popup diblokir browser — izinkan popup buat halaman ini, lalu coba lagi.");
    }
  }

  const detailGroups = [
    {
      title: "Informasi Invoice",
      rows: [
        { label: "Customer", value: invoice.counterparties.name },
        { label: "Rujukan Dokumen", value: invoice.source_ref },
        { label: "Tanggal Invoice", value: invoice.invoice_date },
        {
          label: "Jatuh Tempo",
          value: (
            <>
              {invoice.due_date}
              {overdue && <span className="ml-2 rounded-full bg-red-50 px-2 py-0.5 text-xs text-red-700">Telat</span>}
            </>
          ),
        },
        { label: "Deskripsi", value: invoice.description || "-" },
        {
          label: "Status",
          value: (
            <span className={`rounded-full px-2 py-0.5 text-xs capitalize ${statusStyle[status]}`}>{status}</span>
          ),
        },
      ],
    },
    {
      title: "Ringkasan",
      rows: [
        { label: "Jumlah Invoice", value: invoice.amount.toLocaleString("id-ID") },
        { label: "Terbayar (Kas/Bank)", value: allocated.toLocaleString("id-ID") },
        { label: "DP Diterapkan", value: depositApplied.toLocaleString("id-ID") },
        { label: "Retur", value: returned.toLocaleString("id-ID") },
        { label: "Outstanding", value: outstanding.toLocaleString("id-ID") },
      ],
    },
  ];

  const isFinancialOnly = !goodsIssue;

  const tabs: TabDef[] = [
    { key: "jurnal", label: "Jurnal", badge: journalEntries.length },
    { key: "pembayaran", label: "Pembayaran", badge: payments.length },
    { key: "dp", label: "DP Diterapkan", badge: depositApplications.length },
    { key: "retur", label: "Retur", badge: creditNotes.length },
    // Penggantian Barang (warranty replacement) wajib nunjuk credit note yang punya retur fisik
    // (inventory_returns), yang cuma mungkin ada kalau invoice ini punya goods_issue -- create_warranty_replacement
    // nolak kalau retur-nya financial-only. Gak ada gunanya ditampilin buat invoice financial-only.
    ...(!isFinancialOnly ? [{ key: "replacements", label: "Penggantian Barang", badge: replacements.length }] : []),
  ];

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/ar-invoices" label="Kembali ke AR Invoices" />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-black">AR Invoice Details</h1>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-sm font-mono text-slate-600">
            {invoice.source_ref}
          </span>
          <span
            className={`rounded-full px-2.5 py-1 text-sm font-medium ${
              isFinancialOnly ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"
            }`}
            title={
              isFinancialOnly
                ? "Gak ada goods_issue -- invoice ini gak punya barang fisik tercatat"
                : "Ada goods_issue -- invoice ini punya barang fisik tercatat"
            }
          >
            {isFinancialOnly ? "Financial-Only" : "Full — Barang Fisik"}
          </span>
        </div>
        <div className="flex gap-2">
          <Button variant="toolbar" onClick={handlePrint}>
            Cetak
          </Button>
          {canCancel && (
            <Button variant="toolbar" onClick={handleCancel} disabled={cancelling}>
              {cancelling ? "Membatalkan..." : "Batalkan"}
            </Button>
          )}
        </div>
      </div>

      {loadError && <FormError>{loadError}</FormError>}
      {cancelError && <FormError>{cancelError}</FormError>}

      <DetailRows groups={detailGroups} />

      <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} />

      {activeTab === "jurnal" && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
                <th className="px-4 py-2">Tanggal</th>
                <th className="px-4 py-2">Deskripsi</th>
                <th className="px-4 py-2">Source Ref</th>
                <th className="px-4 py-2">Baris</th>
              </tr>
            </thead>
            <tbody>
              {journalEntries.map((entry) => (
                <tr key={entry.id} className="border-b border-slate-100 align-top hover:bg-slate-50">
                  <td className="whitespace-nowrap px-4 py-2">{entry.entry_date}</td>
                  <td className="px-4 py-2">
                    {entry.description}
                    {entry.reverses_entry_id && (
                      <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700">
                        Reversal
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">{entry.source_ref}</td>
                  <td className="px-4 py-2">
                    <ul className="space-y-0.5">
                      {entry.journal_lines.map((line) => (
                        <li key={line.id}>
                          {line.accounts.code} {line.accounts.name} —{" "}
                          {line.debit > 0
                            ? `D ${line.debit.toLocaleString("id-ID")}`
                            : `K ${line.credit.toLocaleString("id-ID")}`}
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ))}
              {journalEntries.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-slate-400">
                    Belum ada jurnal.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === "pembayaran" && (
        <div className="flex flex-col gap-3">
          {canPay && (
            <div className="flex justify-end">
              <Button variant="toolbar" onClick={openPayForm}>
                Bayar
              </Button>
            </div>
          )}
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
                  <th className="px-4 py-2">Tanggal</th>
                  <th className="px-4 py-2">Source Ref</th>
                  <th className="px-4 py-2 text-right">Jumlah</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="whitespace-nowrap px-4 py-2">{p.payment_date}</td>
                    <td className="px-4 py-2">{p.source_ref}</td>
                    <td className="px-4 py-2 text-right font-mono">{p.amount.toLocaleString("id-ID")}</td>
                  </tr>
                ))}
                {payments.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-4 py-6 text-center text-slate-400">
                      Belum ada pembayaran.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === "dp" && (
        <div className="flex flex-col gap-3">
          {canApplyDeposit && (
            <div className="flex justify-end">
              <Button variant="toolbar" onClick={openApplyForm}>
                Terapkan DP
              </Button>
            </div>
          )}
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
                  <th className="px-4 py-2">Source Ref</th>
                  <th className="px-4 py-2">Dari Deposit</th>
                  <th className="px-4 py-2 text-right">Nominal</th>
                </tr>
              </thead>
              <tbody>
                {depositApplications.map((a) => (
                  <tr key={a.id} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="px-4 py-2">{a.source_ref}</td>
                    <td className="px-4 py-2">{a.ar_deposits.source_ref}</td>
                    <td className="px-4 py-2 text-right font-mono">{a.amount.toLocaleString("id-ID")}</td>
                  </tr>
                ))}
                {depositApplications.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-4 py-6 text-center text-slate-400">
                      Belum ada DP yang diterapkan.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === "retur" && (
        <div className="flex flex-col gap-3">
          {(canRetur || canReplace) && (
            <div className="flex justify-end gap-2">
              {canReplace && (
                <Button variant="toolbar" onClick={openReplaceForm}>
                  Ganti Barang
                </Button>
              )}
              {canRetur && (
                <Button variant="toolbar" onClick={openReturForm}>
                  Retur
                </Button>
              )}
            </div>
          )}
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
                  <th className="px-4 py-2">Tanggal</th>
                  <th className="px-4 py-2">Source Ref</th>
                  <th className="px-4 py-2">Jalur</th>
                  <th className="px-4 py-2">Item Diretur</th>
                  <th className="px-4 py-2 text-right">Nominal</th>
                </tr>
              </thead>
              <tbody>
                {creditNotes.map((cn) => {
                  const invReturn = cn.inventory_returns[0];
                  return (
                    <tr key={cn.id} className="border-b border-slate-100 align-top hover:bg-slate-50">
                      <td className="whitespace-nowrap px-4 py-2">{cn.credit_note_date}</td>
                      <td className="px-4 py-2">{cn.source_ref}</td>
                      <td className="px-4 py-2">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs ${
                            invReturn ? "bg-blue-50 text-blue-700" : "bg-slate-100 text-slate-600"
                          }`}
                        >
                          {invReturn ? "Full (stok+HPP)" : "Financial-only"}
                        </span>
                      </td>
                      <td className="px-4 py-2">
                        {invReturn ? (
                          <ul className="space-y-0.5">
                            {invReturn.inventory_return_lines.map((l) => (
                              <li key={l.item_id}>
                                {l.items.name} — {l.qty_returned} {l.items.uom} (cost{" "}
                                {l.total_cost.toLocaleString("id-ID")})
                                {l.condition === "DAMAGED" && (
                                  <span className="ml-1 rounded-full bg-red-50 px-2 py-0.5 text-xs text-red-700">
                                    Rusak
                                  </span>
                                )}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right font-mono">{cn.amount.toLocaleString("id-ID")}</td>
                    </tr>
                  );
                })}
                {creditNotes.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-slate-400">
                      Belum ada retur.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {invoiceReturnCredits.length > 0 && (
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
              <div className="border-b border-slate-100 px-4 py-2">
                <span className="text-sm font-medium text-black">Saldo Kredit Retur Customer</span>
              </div>
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
                    <th className="px-4 py-2">Source Retur</th>
                    <th className="px-4 py-2 text-right">Jumlah Awal</th>
                    <th className="px-4 py-2 text-right">Sudah Diselesaikan</th>
                    <th className="px-4 py-2 text-right">Sisa</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {invoiceReturnCredits.map((rc) => {
                    const { used, remaining } = returnCreditRemaining(rc);
                    return (
                      <tr key={rc.id} className="border-b border-slate-100 hover:bg-slate-50">
                        <td className="px-4 py-2">{rc.ar_credit_notes.source_ref}</td>
                        <td className="px-4 py-2 text-right font-mono">{rc.amount.toLocaleString("id-ID")}</td>
                        <td className="px-4 py-2 text-right font-mono">{used.toLocaleString("id-ID")}</td>
                        <td className="px-4 py-2 text-right font-mono font-medium">
                          {remaining.toLocaleString("id-ID")}
                        </td>
                        <td className="px-4 py-2 text-right">
                          {canWrite && remaining > 0.005 && (
                            <Button variant="toolbar" onClick={() => openRefundCreditForm(rc.id)}>
                              Refund Tunai
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {activeTab === "replacements" && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
                <th className="px-4 py-2">Tanggal</th>
                <th className="px-4 py-2">Source Ref</th>
                <th className="px-4 py-2">Item Diganti</th>
                <th className="px-4 py-2 text-right">Cost</th>
              </tr>
            </thead>
            <tbody>
              {replacements.map((r) => (
                <tr key={r.id} className="border-b border-slate-100 align-top hover:bg-slate-50">
                  <td className="whitespace-nowrap px-4 py-2">{r.replacement_date}</td>
                  <td className="px-4 py-2">{r.source_ref}</td>
                  <td className="px-4 py-2">
                    <ul className="space-y-0.5">
                      {r.warranty_replacement_lines.map((l) => (
                        <li key={l.item_id}>
                          {l.items.name} — {l.qty_replaced} {l.items.uom}
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    {r.warranty_replacement_lines
                      .reduce((sum, l) => sum + l.total_cost, 0)
                      .toLocaleString("id-ID")}
                  </td>
                </tr>
              ))}
              {replacements.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-slate-400">
                    Belum ada penggantian barang.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={showReplaceForm}
        onClose={() => setShowReplaceForm(false)}
        title="Tukar Barang (Garansi)"
        maxWidth="max-w-2xl"
      >
        <p className="mb-4 text-sm text-slate-600">
          Barang pengganti keluar dari stok (dijurnal HPP/Persediaan Barang Jadi) — gak nyentuh
          Piutang Usaha sama sekali, murni tukar barang. Qty yang sama cuma boleh diklaim SATU
          jalur: kalau item ini udah diretur pakai diskon (tab Retur), sisa yang bisa diganti di
          sini otomatis berkurang segitu — gak bisa dua-duanya.
        </p>
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
        <form onSubmit={handleReplaceSubmit} className="flex flex-col gap-4">
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

          {replaceError && <FormError>{replaceError}</FormError>}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setShowReplaceForm(false)}>
              Batal
            </Button>
            <Button type="submit" disabled={replaceSubmitting || replaceLines.length === 0}>
              {replaceSubmitting ? "Menyimpan..." : "Simpan Penggantian"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={showApplyForm}
        onClose={() => setShowApplyForm(false)}
        title="Terapkan DP ke Invoice Ini"
        maxWidth="max-w-2xl"
      >
        <p className="mb-4 text-sm text-slate-600">
          Reklasifikasi uang muka yang udah diterima jadi pengurang piutang invoice ini —
          bukan pembayaran baru.
        </p>
        <JournalPreviewPanel
          groups={[
            [
              {
                label: "Akun Uang Muka Penjualan (debit)",
                resolved: defaultAccounts["ar.deposit_liability"],
                side: "debit",
              },
              { label: "Akun Piutang Usaha (kredit)", resolved: defaultAccounts["ar.receivable"], side: "credit" },
            ],
          ]}
        />
        <form onSubmit={handleApplySubmit} className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="apply_deposit">Deposit</Label>
              <Select
                id="apply_deposit"
                value={applyDepositId}
                onChange={(e) => {
                  setApplyDepositId(e.target.value);
                  const dep = availableDeposits.find((d) => d.id === e.target.value);
                  if (dep) {
                    const remaining = depositStatus(dep, reversedEntryIds).remaining;
                    setApplyAmount(String(Math.min(remaining, outstanding)));
                  }
                }}
              >
                <option value="">Pilih deposit...</option>
                {availableDeposits.map((dep) => {
                  const remaining = depositStatus(dep, reversedEntryIds).remaining;
                  return (
                    <option key={dep.id} value={dep.id}>
                      {dep.source_ref} (sisa {remaining.toLocaleString("id-ID")})
                    </option>
                  );
                })}
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="apply_amount">
                Nominal Diterapkan {selectedDeposit && `(maks ${Math.min(selectedDepositRemaining, outstanding).toLocaleString("id-ID")})`}
              </Label>
              <Input
                id="apply_amount"
                type="number"
                min="0"
                placeholder="0"
                value={applyAmount}
                onChange={(e) => setApplyAmount(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="apply_date">Tanggal</Label>
              <Input id="apply_date" type="date" value={applyDate} onChange={(e) => setApplyDate(e.target.value)} />
            </div>
            <LockedAccountField
              label="Akun Uang Muka Penjualan (debit)"
              htmlFor="apply_deposit_liability_account"
              resolved={defaultAccounts["ar.deposit_liability"]}
            />
            <LockedAccountField
              label="Akun Piutang Usaha (kredit)"
              htmlFor="apply_receivable_account"
              resolved={defaultAccounts["ar.receivable"]}
            />
          </div>

          {applyError && <FormError>{applyError}</FormError>}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setShowApplyForm(false)}>
              Batal
            </Button>
            <Button type="submit" disabled={applySubmitting}>
              {applySubmitting ? "Menyimpan..." : "Terapkan DP"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal open={showReturForm} onClose={() => setShowReturForm(false)} title="Catat Retur" maxWidth="max-w-2xl">
        <p className="mb-4 text-sm text-slate-600">
          {goodsIssue
            ? "Invoice ini lewat Goods Issue — isi qty per item yang balik, stok & HPP otomatis ke-reverse proporsional."
            : "Invoice ini gak lewat Goods Issue — retur cuma ngurangin piutang (kontra-revenue), gak ada stok yang disentuh."}
        </p>
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
                label: "Akun Saldo Kredit Retur Customer (kredit) — retur ini ngelebihin outstanding",
                resolved: defaultAccounts["ar.return_credit_liability"],
                side: "credit",
              },
            ],
            goodsIssue && (returHasResalable || returHasDamaged) && [
              returHasResalable && {
                label: "Akun Persediaan Barang Jadi (debit, baris Layak Jual)",
                resolved: defaultAccounts["inventory.finished_good"],
                side: "debit",
              },
              returHasDamaged && {
                label: "Akun Beban Kerugian Barang Rusak (debit, baris Rusak)",
                resolved: defaultAccounts["inventory.damage_loss_expense"],
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
        <form onSubmit={handleReturSubmit} className="flex flex-col gap-4">
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
                label="Akun Saldo Kredit Retur Customer (kredit, cuma kalau retur ini bikin outstanding minus)"
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
                    label="Akun Persediaan Barang Jadi (debit, baris Layak Jual)"
                    htmlFor="retur_finished_good_account"
                    resolved={defaultAccounts["inventory.finished_good"]}
                  />
                  <LockedAccountField
                    label="Akun Beban Kerugian Barang Rusak (debit, baris Rusak)"
                    htmlFor="retur_loss_expense_account"
                    resolved={defaultAccounts["inventory.damage_loss_expense"]}
                  />
                </>
              )}
            </div>

            {goodsIssue && (
              <div className="flex flex-col gap-2">
                <div className="grid grid-cols-[1fr_8rem_10rem] gap-2 text-sm font-medium text-slate-500">
                  <span>Item Terjual (qty asli)</span>
                  <span>Qty Retur</span>
                  <span>Kondisi</span>
                </div>
                {returLines.map((line) => (
                  <div key={line.item_id} className="grid grid-cols-[1fr_8rem_10rem] gap-2">
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
                    <Select
                      value={line.condition}
                      onChange={(e) =>
                        updateReturLineCondition(line.item_id, e.target.value as "RESALABLE" | "DAMAGED")
                      }
                    >
                      <option value="RESALABLE">Layak Jual</option>
                      <option value="DAMAGED">Rusak</option>
                    </Select>
                  </div>
                ))}
              </div>
            )}

            {returError && <FormError>{returError}</FormError>}

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="secondary" onClick={() => setShowReturForm(false)}>
                Batal
              </Button>
              <Button type="submit" disabled={returSubmitting}>
                {returSubmitting ? "Menyimpan..." : "Simpan Retur"}
              </Button>
            </div>
        </form>
      </Modal>

      <Modal open={showPayForm} onClose={() => setShowPayForm(false)} title="Catat Pembayaran" maxWidth="max-w-2xl">
        <p className="mb-4 text-sm text-slate-500">
          Payment selalu nutup invoice ini spesifik, boleh cicil (kurang dari sisa outstanding),
          tapi gak boleh lebih (overpay ditolak).
        </p>
        <JournalPreviewPanel
          groups={[
            [
              {
                label: "Akun Kas/Bank (debit)",
                resolved: resolveCashAccount(payMethod, defaultAccounts),
                side: "debit",
              },
              { label: "Akun Piutang Usaha (kredit)", resolved: defaultAccounts["ar.receivable"], side: "credit" },
            ],
          ]}
        />
        <form onSubmit={handlePaySubmit} className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pay_date">Tanggal</Label>
              <Input id="pay_date" type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pay_amount">
                Jumlah dibayar (boleh cicil, maks {outstanding.toLocaleString("id-ID")})
              </Label>
              <Input
                id="pay_amount"
                type="number"
                min="0"
                placeholder="0"
                value={payAmount}
                onChange={(e) => setPayAmount(e.target.value)}
              />
            </div>
            <CashMethodField
              label="Akun Kas/Bank (debit)"
              htmlFor="pay_cash_account"
              method={payMethod}
              onChange={setPayMethod}
              defaultAccounts={defaultAccounts}
            />
            <LockedAccountField
              label="Akun Piutang Usaha (kredit)"
              htmlFor="pay_receivable_account"
              resolved={defaultAccounts["ar.receivable"]}
            />
          </div>

          {payError && <FormError>{payError}</FormError>}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setShowPayForm(false)}>
              Batal
            </Button>
            <Button type="submit" disabled={paySubmitting}>
              {paySubmitting ? "Menyimpan..." : "Simpan Pembayaran"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={!!refundCreditId}
        onClose={() => setRefundCreditId(null)}
        title="Refund Tunai Saldo Kredit Retur"
        maxWidth="max-w-2xl"
      >
        <p className="mb-4 text-sm text-slate-600">
          Kembalikan sisa saldo kredit retur ini ke customer dalam bentuk kas/bank.
        </p>
        <JournalPreviewPanel
          groups={[
            [
              {
                label: "Akun Saldo Kredit Retur Customer (debit)",
                resolved: defaultAccounts["ar.return_credit_liability"],
                side: "debit",
              },
              {
                label: "Akun Kas/Bank (kredit)",
                resolved: resolveCashAccount(refundCreditMethod, defaultAccounts),
                side: "credit",
              },
            ],
          ]}
        />
        <form onSubmit={handleRefundCreditSubmit} className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="refund_credit_amount">Nominal Refund</Label>
              <Input
                id="refund_credit_amount"
                type="number"
                min="0"
                placeholder="0"
                value={refundCreditAmount}
                onChange={(e) => setRefundCreditAmount(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="refund_credit_date">Tanggal</Label>
              <Input
                id="refund_credit_date"
                type="date"
                value={refundCreditDate}
                onChange={(e) => setRefundCreditDate(e.target.value)}
              />
            </div>
            <LockedAccountField
              label="Akun Saldo Kredit Retur Customer (debit)"
              htmlFor="refund_credit_liability_account"
              resolved={defaultAccounts["ar.return_credit_liability"]}
            />
            <CashMethodField
              label="Akun Kas/Bank (kredit)"
              htmlFor="refund_credit_cash_account"
              method={refundCreditMethod}
              onChange={setRefundCreditMethod}
              defaultAccounts={defaultAccounts}
            />
          </div>

          {refundCreditError && <FormError>{refundCreditError}</FormError>}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setRefundCreditId(null)}>
              Batal
            </Button>
            <Button type="submit" disabled={refundCreditSubmitting}>
              {refundCreditSubmitting ? "Menyimpan..." : "Refund"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
