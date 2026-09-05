"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { billStatus, type ApBill } from "@/lib/ap-bills/schema";
import {
  createApCreditNoteSchema,
  type GoodsReceiptForBill,
} from "@/lib/ap-credit-notes/schema";
import { createPurchaseReplacementSchema } from "@/lib/purchase-replacements/schema";
import { applyApDepositSchema, depositStatus, type ApDeposit } from "@/lib/ap-deposits/schema";
import { recordApPaymentSchema } from "@/lib/ap-payments/schema";
import { refundApReturnCreditSchema } from "@/lib/ap-return-credits/schema";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { Modal } from "@/components/ui/modal";
import { Tabs, type TabDef } from "@/components/ui/tabs";
import { DetailRows } from "@/components/ui/detail-rows";
import { LockedAccountField } from "@/components/ui/locked-account-field";
import { JournalPreviewPanel } from "@/components/ui/journal-preview-panel";
import { CashMethodField, resolveCashAccount, type CashMethod } from "@/components/ui/cash-method-field";
import { fetchDefaultAccounts, type ResolvedAccount } from "@/lib/default-accounts/schema";

type ReturnLineInput = {
  item_id: string;
  name: string;
  uom: string;
  unit_cost: number;
  qty_available: number;
  qty_returned: string;
};

type ReplaceLineInput = {
  item_id: string;
  name: string;
  uom: string;
  qty_available: number;
  qty: string;
};

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

type CreditNoteDetail = {
  id: string;
  credit_note_date: string;
  source_ref: string;
  amount: number;
  created_at: string;
  purchase_return_lines: {
    item_id: string;
    qty_returned: number;
    total_cost: number;
    items: { name: string; uom: string };
  }[];
  ap_return_credits: {
    id: string;
    amount: number;
    ap_return_credit_refunds: { amount: number }[];
  }[];
};

type ReplacementDetail = {
  id: string;
  replacement_date: string;
  source_ref: string;
  created_at: string;
  purchase_replacement_lines: {
    item_id: string;
    qty_replaced: number;
    total_cost: number;
    items: { name: string; uom: string };
  }[];
};

type DepositApplicationDetail = {
  id: string;
  amount: number;
  source_ref: string;
  journal_entry_id: string;
  ap_deposits: { source_ref: string };
};

const statusStyle: Record<string, string> = {
  lunas: "bg-emerald-50 text-emerald-700",
  sebagian: "bg-amber-50 text-amber-700",
  belum: "bg-slate-100 text-slate-600",
  dibatalkan: "bg-slate-100 text-slate-400 line-through",
};

export function ApBillDetailView({ id }: { id: string }) {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [bill, setBill] = useState<ApBill | null>(null);
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});
  const [billDebitAccounts, setBillDebitAccounts] = useState<ResolvedAccount[]>([]);
  const [inventoryAccountIds, setInventoryAccountIds] = useState<Set<string>>(new Set());
  const [reversedEntryIds, setReversedEntryIds] = useState<Set<string>>(new Set());
  const [journalEntries, setJournalEntries] = useState<JournalEntryDetail[]>([]);
  const [payments, setPayments] = useState<PaymentDetail[]>([]);
  const [creditNotes, setCreditNotes] = useState<CreditNoteDetail[]>([]);
  const [replacements, setReplacements] = useState<ReplacementDetail[]>([]);
  const [goodsReceipt, setGoodsReceipt] = useState<GoodsReceiptForBill | null>(null);
  const [depositApplications, setDepositApplications] = useState<DepositApplicationDetail[]>([]);
  const [supplierDeposits, setSupplierDeposits] = useState<ApDeposit[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("jurnal");

  const [showReturForm, setShowReturForm] = useState(false);
  const [returDate, setReturDate] = useState("");
  const [returAmount, setReturAmount] = useState("");
  const [returCreditAccountId, setReturCreditAccountId] = useState("");
  const [returLines, setReturLines] = useState<ReturnLineInput[]>([]);
  const [returError, setReturError] = useState<string | null>(null);
  const [returSubmitting, setReturSubmitting] = useState(false);

  const [showReplaceForm, setShowReplaceForm] = useState(false);
  const [replaceDate, setReplaceDate] = useState("");
  const [replaceLines, setReplaceLines] = useState<ReplaceLineInput[]>([]);
  const [replaceError, setReplaceError] = useState<string | null>(null);
  const [replaceSubmitting, setReplaceSubmitting] = useState(false);

  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const [showApplyForm, setShowApplyForm] = useState(false);
  const [applyDepositId, setApplyDepositId] = useState("");
  const [applyAmount, setApplyAmount] = useState("");
  const [applyDate, setApplyDate] = useState("");
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applySubmitting, setApplySubmitting] = useState(false);

  const [showPayForm, setShowPayForm] = useState(false);
  const [payDate, setPayDate] = useState("");
  const [payAmount, setPayAmount] = useState("");
  const [payCashMethod, setPayCashMethod] = useState<CashMethod>("TUNAI");
  const [payError, setPayError] = useState<string | null>(null);
  const [paySubmitting, setPaySubmitting] = useState(false);

  const [refundCreditId, setRefundCreditId] = useState<string | null>(null);
  const [refundCreditAmount, setRefundCreditAmount] = useState("");
  const [refundCreditDate, setRefundCreditDate] = useState("");
  const [refundCreditCashMethod, setRefundCreditCashMethod] = useState<CashMethod>("TUNAI");
  const [refundCreditError, setRefundCreditError] = useState<string | null>(null);
  const [refundCreditSubmitting, setRefundCreditSubmitting] = useState(false);

  const load = useCallback(async () => {
    const { data: b, error: billErr } = await supabase
      .from("transactions")
      .select(
        "id, supplier_id:counterparty_id, bill_date:date, due_date, description, source_ref, supplier_document_ref, amount, journal_entry_id, created_at, counterparties(name), ap_payments:payments(amount), ap_credit_notes:credit_notes(amount, ap_return_credits:return_credits(amount)), ap_deposit_applications:deposit_applications(amount)"
      )
      .eq("id", id)
      .eq("type", "OUTBOUND")
      .single();
    if (billErr || !b) {
      setLoadError(billErr?.message ?? "Bill gak ditemukan.");
      return;
    }
    const loadedBill = b as unknown as ApBill;
    setBill(loadedBill);

    const [
      defaultAccountsMap,
      { data: debitLineRows },
      { data: itemAccountRows },
      { data: reversedRows },
      { data: entries, error: entriesErr },
      { data: pays, error: paysErr },
      { data: cns, error: cnErr },
      { data: reps, error: repErr },
      { data: grn },
      { data: depApps, error: depAppErr },
      { data: supDeposits, error: supDepositsErr },
    ] = await Promise.all([
      fetchDefaultAccounts(),
      supabase
        .from("transaction_lines")
        .select("account_id, accounts(code, name)")
        .eq("transaction_id", id)
        .eq("is_tax", false),
      supabase.from("items").select("inventory_account_id"),
      supabase
        .from("journal_entries")
        .select("reverses_entry_id")
        .not("reverses_entry_id", "is", null),
      supabase
        .from("journal_entries")
        .select(
          "id, entry_date, description, source_ref, reverses_entry_id, journal_lines(id, debit, credit, accounts(code, name))"
        )
        .or(`id.eq.${loadedBill.journal_entry_id},reverses_entry_id.eq.${loadedBill.journal_entry_id}`)
        .order("entry_date"),
      supabase
        .from("payments")
        .select("id, payment_date, source_ref, amount")
        .eq("transaction_id", id)
        .order("payment_date"),
      supabase
        .from("credit_notes")
        .select(
          "id, credit_note_date, source_ref, amount, created_at, purchase_return_lines(item_id, qty_returned, total_cost, items(name, uom)), ap_return_credits:return_credits(id, amount, ap_return_credit_refunds:return_credit_refunds(amount))"
        )
        .eq("transaction_id", id)
        .eq("type", "OUTBOUND")
        .order("credit_note_date"),
      supabase
        .from("purchase_replacements")
        .select(
          "id, replacement_date, source_ref, created_at, purchase_replacement_lines(item_id, qty_replaced, total_cost, items(name, uom))"
        )
        .eq("bill_id", id)
        .order("replacement_date"),
      supabase
        .from("goods_receipt_notes")
        .select("id, goods_receipt_lines(item_id, qty_received, unit_cost, items(name, uom))")
        .eq("bill_id", id)
        .maybeSingle(),
      supabase
        .from("deposit_applications")
        .select("id, amount, source_ref, journal_entry_id, ap_deposits:deposits(source_ref)")
        .eq("transaction_id", id),
      supabase
        .from("deposits")
        .select(
          "id, supplier_id:counterparty_id, deposit_date, source_ref, amount, journal_entry_id, created_at, counterparties(name), ap_deposit_applications:deposit_applications(id, amount, source_ref, journal_entry_id, ap_bills:transactions(source_ref)), ap_deposit_refunds:deposit_refunds(id, amount, refund_date, source_ref, journal_entry_id), ap_deposit_forfeitures:deposit_forfeitures(id, amount, forfeiture_date, source_ref, journal_entry_id)"
        )
        .eq("counterparty_id", loadedBill.supplier_id)
        .eq("type", "OUTBOUND")
        .order("deposit_date"),
    ]);

    setDefaultAccounts(defaultAccountsMap);
    const debitLines = (debitLineRows ?? []) as unknown as {
      account_id: string;
      accounts: { code: string; name: string };
    }[];
    const uniqueDebitAccounts = new Map<string, ResolvedAccount>();
    for (const l of debitLines) {
      uniqueDebitAccounts.set(l.account_id, { id: l.account_id, code: l.accounts.code, name: l.accounts.name });
    }
    setBillDebitAccounts(Array.from(uniqueDebitAccounts.values()));
    setInventoryAccountIds(
      new Set(
        ((itemAccountRows ?? []) as { inventory_account_id: string }[]).map((r) => r.inventory_account_id)
      )
    );
    setReversedEntryIds(
      new Set(((reversedRows ?? []) as { reverses_entry_id: string }[]).map((r) => r.reverses_entry_id))
    );
    setJournalEntries((entries ?? []) as unknown as JournalEntryDetail[]);
    setPayments((pays ?? []) as unknown as PaymentDetail[]);
    setCreditNotes((cns ?? []) as unknown as CreditNoteDetail[]);
    setReplacements((reps ?? []) as unknown as ReplacementDetail[]);
    setGoodsReceipt((grn ?? null) as unknown as GoodsReceiptForBill | null);
    setDepositApplications((depApps ?? []) as unknown as DepositApplicationDetail[]);
    setSupplierDeposits((supDeposits ?? []) as unknown as ApDeposit[]);
    setLoadError(
      entriesErr?.message ??
        paysErr?.message ??
        cnErr?.message ??
        repErr?.message ??
        depAppErr?.message ??
        supDepositsErr?.message ??
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
      await load();
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, load]);

  /**
   * Qty per item yang udah "diklaim" dari bill ini, GABUNGAN Opsi A (purchase_return_lines)
   * + Opsi B (purchase_replacement_lines) — mirror purchase_returned_qty() di database
   * (0035, disederhanakan lagi setelah Opsi C dicabut). Fisiknya cuma ada 1 pool
   * qty_received per item yang bisa diklaim, mau lewat jalur mana pun. Dipakai buat cap qty
   * input di kedua form biar gak nembus batas sebelum kena guard server.
   */
  function claimedQtyByItem(): Map<string, number> {
    const map = new Map<string, number>();
    for (const cn of creditNotes) {
      for (const l of cn.purchase_return_lines) {
        map.set(l.item_id, (map.get(l.item_id) ?? 0) + l.qty_returned);
      }
    }
    for (const r of replacements) {
      for (const l of r.purchase_replacement_lines) {
        map.set(l.item_id, (map.get(l.item_id) ?? 0) + l.qty_replaced);
      }
    }
    return map;
  }

  /**
   * Jalur financial-only (gak ada goods receipt) gak boleh nawarin akun Persediaan sebagai
   * akun kredit retur -- retur Persediaan wajib lewat qty fisik (mirror guard di
   * create_ap_credit_note, migration 0019). Jalur fisik (ada goods receipt) sebaliknya MEMANG
   * butuh akun Persediaan, jadi gak difilter.
   */
  function returCreditAccountOptions(): ResolvedAccount[] {
    return goodsReceipt
      ? billDebitAccounts
      : billDebitAccounts.filter((a) => !inventoryAccountIds.has(a.id));
  }

  function openReturForm() {
    setReturError(null);
    setReturDate("");
    setReturAmount("");
    setReturCreditAccountId(returCreditAccountOptions()[0]?.id ?? "");
    const claimed = claimedQtyByItem();
    setReturLines(
      goodsReceipt
        ? goodsReceipt.goods_receipt_lines
            .map((l) => ({
              item_id: l.item_id,
              name: l.items.name,
              uom: l.items.uom,
              unit_cost: l.unit_cost,
              qty_available: l.qty_received - (claimed.get(l.item_id) ?? 0),
              qty_returned: "",
            }))
            .filter((l) => l.qty_available > 0)
        : []
    );
    setShowReturForm(true);
  }

  function updateReturLine(itemId: string, qty: string) {
    setReturLines((prev) => prev.map((l) => (l.item_id === itemId ? { ...l, qty_returned: qty } : l)));
  }

  async function handleReturSubmit(e: FormEvent) {
    e.preventDefault();
    if (!bill) return;
    setReturError(null);

    const activeLines = returLines
      .filter((l) => l.qty_returned.trim() !== "")
      .map((l) => ({ item_id: l.item_id, qty_returned: l.qty_returned }));

    if (goodsReceipt && activeLines.length === 0) {
      setReturError("Bill ini lewat goods receipt — isi minimal 1 baris qty retur");
      return;
    }

    const estimatedAmount = returLines.reduce((sum, l) => {
      const qty = Number(l.qty_returned);
      return l.qty_returned.trim() !== "" && !Number.isNaN(qty) ? sum + qty * l.unit_cost : sum;
    }, 0);

    const parsed = createApCreditNoteSchema.safeParse({
      bill_id: bill.id,
      credit_note_date: returDate,
      amount: goodsReceipt ? estimatedAmount : returAmount,
      payable_account_id: defaultAccounts["ap.payable"]?.id ?? "",
      credit_account_id: returCreditAccountId,
      lines: activeLines,
      return_credit_asset_account_id: defaultAccounts["ap.return_credit_asset"]?.id || undefined,
    });
    if (!parsed.success) {
      setReturError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setReturSubmitting(true);
    let sourceRef: string;
    try {
      sourceRef = await generateDocumentNumber("ap_credit_notes");
    } catch (err) {
      setReturSubmitting(false);
      setReturError(err instanceof Error ? err.message : "Gagal generate nomor dokumen");
      return;
    }
    const { error } = await supabase.rpc("create_ap_credit_note", {
      p_bill_id: parsed.data.bill_id,
      p_credit_note_date: parsed.data.credit_note_date,
      p_source_ref: sourceRef,
      p_amount: parsed.data.amount,
      p_payable_account_id: parsed.data.payable_account_id,
      p_credit_account_id: parsed.data.credit_account_id,
      p_lines: parsed.data.lines.length > 0 ? parsed.data.lines : null,
      p_return_credit_asset_account_id: parsed.data.return_credit_asset_account_id ?? null,
    });
    setReturSubmitting(false);
    if (error) {
      setReturError(error.message);
      return;
    }

    setShowReturForm(false);
    await load();
  }

  function openReplaceForm() {
    setReplaceError(null);
    setReplaceDate("");
    const claimed = claimedQtyByItem();
    setReplaceLines(
      goodsReceipt
        ? goodsReceipt.goods_receipt_lines
            .map((l) => ({
              item_id: l.item_id,
              name: l.items.name,
              uom: l.items.uom,
              qty_available: l.qty_received - (claimed.get(l.item_id) ?? 0),
              qty: "",
            }))
            .filter((l) => l.qty_available > 0)
        : []
    );
    setShowReplaceForm(true);
  }

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
    const { error } = await supabase.rpc("create_purchase_replacement", {
      p_bill_id: parsed.data.bill_id,
      p_replacement_date: parsed.data.replacement_date,
      p_source_ref: sourceRef,
      p_lines: parsed.data.lines,
      p_inventory_account_id: parsed.data.inventory_account_id,
    });
    setReplaceSubmitting(false);
    if (error) {
      setReplaceError(error.message);
      return;
    }

    setShowReplaceForm(false);
    await load();
  }

  async function handleCancel() {
    if (!bill) return;
    if (!window.confirm(`Batalkan bill ${bill.source_ref} (Rp${bill.amount.toLocaleString("id-ID")})?`)) return;

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
    const { error } = await supabase.rpc("cancel_ap_bill", {
      p_bill_id: bill.id,
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

  function openApplyForm() {
    setApplyError(null);
    setApplyDepositId("");
    setApplyAmount("");
    setApplyDate("");
    setShowApplyForm(true);
  }

  async function handleApplySubmit(e: FormEvent) {
    e.preventDefault();
    if (!bill) return;
    setApplyError(null);

    const parsed = applyApDepositSchema.safeParse({
      deposit_id: applyDepositId,
      bill_id: bill.id,
      amount: applyAmount,
      entry_date: applyDate,
      payable_account_id: defaultAccounts["ap.payable"]?.id ?? "",
      deposit_asset_account_id: defaultAccounts["ap.deposit_asset"]?.id ?? "",
    });
    if (!parsed.success) {
      setApplyError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setApplySubmitting(true);
    let sourceRef: string;
    try {
      sourceRef = await generateDocumentNumber("ap_deposit_applications");
    } catch (err) {
      setApplySubmitting(false);
      setApplyError(err instanceof Error ? err.message : "Gagal generate nomor dokumen");
      return;
    }
    const { error } = await supabase.rpc("apply_deposit", {
      p_deposit_id: parsed.data.deposit_id,
      p_transaction_id: parsed.data.bill_id,
      p_amount: parsed.data.amount,
      p_entry_date: parsed.data.entry_date,
      p_source_ref: sourceRef,
      p_control_account_id: parsed.data.payable_account_id,
      p_deposit_account_id: parsed.data.deposit_asset_account_id,
    });
    setApplySubmitting(false);
    if (error) {
      setApplyError(error.message);
      return;
    }

    setShowApplyForm(false);
    await load();
  }

  function openPayForm() {
    setPayError(null);
    setPayDate("");
    setPayAmount("");
    setPayCashMethod("TUNAI");
    setShowPayForm(true);
  }

  async function handlePaySubmit(e: FormEvent) {
    e.preventDefault();
    if (!bill) return;
    setPayError(null);

    const parsed = recordApPaymentSchema.safeParse({
      supplier_id: bill.supplier_id,
      payment_date: payDate,
      amount: payAmount,
      payable_account_id: defaultAccounts["ap.payable"]?.id ?? "",
      cash_account_id: resolveCashAccount(payCashMethod, defaultAccounts)?.id ?? "",
      bill_id: bill.id,
    });
    if (!parsed.success) {
      setPayError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setPaySubmitting(true);
    let sourceRef: string;
    try {
      sourceRef = await generateDocumentNumber("ap_payments");
    } catch (err) {
      setPaySubmitting(false);
      setPayError(err instanceof Error ? err.message : "Gagal generate nomor dokumen");
      return;
    }
    const { error } = await supabase.rpc("record_payment", {
      p_type: "OUTBOUND",
      p_counterparty_id: parsed.data.supplier_id,
      p_payment_date: parsed.data.payment_date,
      p_amount: parsed.data.amount,
      p_source_ref: sourceRef,
      p_cash_account_id: parsed.data.cash_account_id,
      p_control_account_id: parsed.data.payable_account_id,
      p_transaction_id: parsed.data.bill_id,
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
    setRefundCreditCashMethod("TUNAI");
    setRefundCreditId(creditId);
  }

  async function handleRefundCreditSubmit(e: FormEvent) {
    e.preventDefault();
    if (!refundCreditId) return;
    setRefundCreditError(null);

    const parsed = refundApReturnCreditSchema.safeParse({
      credit_id: refundCreditId,
      amount: refundCreditAmount,
      entry_date: refundCreditDate,
      return_credit_asset_account_id: defaultAccounts["ap.return_credit_asset"]?.id ?? "",
      cash_account_id: resolveCashAccount(refundCreditCashMethod, defaultAccounts)?.id ?? "",
    });
    if (!parsed.success) {
      setRefundCreditError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setRefundCreditSubmitting(true);
    let sourceRef: string;
    try {
      sourceRef = await generateDocumentNumber("ap_return_credit_refunds");
    } catch (err) {
      setRefundCreditSubmitting(false);
      setRefundCreditError(err instanceof Error ? err.message : "Gagal generate nomor dokumen");
      return;
    }
    const { error } = await supabase.rpc("refund_return_credit", {
      p_credit_id: parsed.data.credit_id,
      p_amount: parsed.data.amount,
      p_entry_date: parsed.data.entry_date,
      p_source_ref: sourceRef,
      p_return_credit_account_id: parsed.data.return_credit_asset_account_id,
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

  if (!bill) {
    return <FormError>{loadError ?? "Bill gak ditemukan."}</FormError>;
  }

  const isCancelled = reversedEntryIds.has(bill.journal_entry_id);
  const { status, outstanding, allocated, returned, depositApplied } = billStatus(bill, isCancelled);
  const overdue = status !== "lunas" && status !== "dibatalkan" && bill.due_date < new Date().toISOString().slice(0, 10);
  const canWrite = roles.includes("admin") || roles.includes("accountant");
  const canPay = canWrite && !isCancelled && outstanding > 0.005;
  const canRetur = canWrite && !isCancelled;
  const canReplace = canWrite && !isCancelled && goodsReceipt !== null;
  const canCancel = canWrite && !isCancelled && allocated === 0;
  const availableDeposits = supplierDeposits.filter(
    (dep) => depositStatus(dep, reversedEntryIds).remaining > 0.005
  );
  const canApplyDeposit = canWrite && !isCancelled && outstanding > 0 && availableDeposits.length > 0;
  const selectedDeposit = availableDeposits.find((dep) => dep.id === applyDepositId) ?? null;
  const selectedDepositRemaining = selectedDeposit ? depositStatus(selectedDeposit, reversedEntryIds).remaining : 0;

  // Sama persis kayak estimatedAmount di handleReturSubmit -- dihitung ulang di render scope
  // biar JournalPreviewPanel bisa nunjukin jurnal "Piutang Retur Supplier" cuma pas beneran
  // bakal kejadian (retur ngelebihin outstanding), bukan asumsi selalu ada.
  const returEffectiveAmount = goodsReceipt
    ? returLines.reduce((sum, l) => {
        const qty = Number(l.qty_returned);
        return l.qty_returned.trim() !== "" && !Number.isNaN(qty) ? sum + qty * l.unit_cost : sum;
      }, 0)
    : Number(returAmount) || 0;
  const returExcess = Math.max(0, returEffectiveAmount - Math.max(0, outstanding));

  const isFinancialOnly = !goodsReceipt;

  const tabs: TabDef[] = [
    { key: "jurnal", label: "Jurnal", badge: journalEntries.length },
    { key: "pembayaran", label: "Pembayaran", badge: payments.length },
    { key: "dp", label: "DP Diterapkan", badge: depositApplications.length },
    { key: "retur", label: "Retur — Kurangi Utang", badge: creditNotes.length },
    // Tukar Barang wajib qty fisik + goods_receipt_notes (create_purchase_replacement nolak
    // kalau gak ada) -- gak ada gunanya ditampilin buat bill financial-only, submit-nya bakal
    // ketolak RPC. Lihat memory/domain/accounts-payable.md submodule "Retur Barang ke Supplier".
    // Opsi C (Tulis-jadi-Beban / purchase_writeoffs) DICABUT -- barang rusak yang supplier
    // tolak kompensasi sekarang lewat stock_opname generic, bukan RPC khusus AP.
    ...(!isFinancialOnly ? [{ key: "tukar", label: "Tukar Barang", badge: replacements.length }] : []),
  ];

  const detailGroups = [
    {
      title: "Informasi Bill",
      rows: [
        { label: "Supplier", value: bill.counterparties.name },
        { label: "Rujukan Dokumen", value: bill.source_ref },
        { label: "Nomor Nota Supplier", value: bill.supplier_document_ref || "-" },
        { label: "Tanggal Bill", value: bill.bill_date },
        {
          label: "Jatuh Tempo",
          value: (
            <>
              {bill.due_date}
              {overdue && <span className="ml-2 rounded-full bg-red-50 px-2 py-0.5 text-xs text-red-700">Telat</span>}
            </>
          ),
        },
        { label: "Deskripsi", value: bill.description || "-" },
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
        { label: "Jumlah Bill", value: bill.amount.toLocaleString("id-ID") },
        { label: "Terbayar (Kas/Bank)", value: allocated.toLocaleString("id-ID") },
        { label: "DP Diterapkan", value: depositApplied.toLocaleString("id-ID") },
        { label: "Retur", value: returned.toLocaleString("id-ID") },
        { label: "Outstanding", value: outstanding.toLocaleString("id-ID") },
      ],
    },
  ];

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/ap-bills" label="Kembali ke AP Bills" />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-black">AP Bill Details</h1>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-sm font-mono text-slate-600">
            {bill.source_ref}
          </span>
          <span
            className={`rounded-full px-2.5 py-1 text-sm font-medium ${
              isFinancialOnly ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"
            }`}
            title={
              isFinancialOnly
                ? "Gak ada goods_receipt_notes -- bill ini gak punya barang fisik tercatat"
                : "Ada goods_receipt_notes -- bill ini punya barang fisik tercatat"
            }
          >
            {isFinancialOnly ? "Financial-Only" : "Full — Barang Fisik"}
          </span>
        </div>
        {canCancel && (
          <Button variant="toolbar" onClick={handleCancel} disabled={cancelling}>
            {cancelling ? "Membatalkan..." : "Batalkan Bill"}
          </Button>
        )}
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
                      <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700">Reversal</span>
                    )}
                  </td>
                  <td className="px-4 py-2">{entry.source_ref}</td>
                  <td className="px-4 py-2">
                    <ul className="space-y-0.5">
                      {entry.journal_lines.map((line) => (
                        <li key={line.id}>
                          {line.accounts.code} {line.accounts.name} —{" "}
                          {line.debit > 0 ? `D ${line.debit.toLocaleString("id-ID")}` : `K ${line.credit.toLocaleString("id-ID")}`}
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
                    <td className="px-4 py-2">{a.ap_deposits.source_ref}</td>
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
          {canRetur && (
            <div className="flex justify-end">
              <Button variant="toolbar" onClick={openReturForm}>
                Retur — Kurangi Utang
              </Button>
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
                  const isFull = cn.purchase_return_lines.length > 0;
                  return (
                    <tr key={cn.id} className="border-b border-slate-100 align-top hover:bg-slate-50">
                      <td className="whitespace-nowrap px-4 py-2">{cn.credit_note_date}</td>
                      <td className="px-4 py-2">{cn.source_ref}</td>
                      <td className="px-4 py-2">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs ${
                            isFull ? "bg-blue-50 text-blue-700" : "bg-slate-100 text-slate-600"
                          }`}
                        >
                          {isFull ? "Full (stok)" : "Financial-only"}
                        </span>
                      </td>
                      <td className="px-4 py-2">
                        {isFull ? (
                          <ul className="space-y-0.5">
                            {cn.purchase_return_lines.map((l) => (
                              <li key={l.item_id}>
                                {l.items.name} — {l.qty_returned} {l.items.uom} (cost{" "}
                                {l.total_cost.toLocaleString("id-ID")})
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

          {creditNotes.some((cn) => cn.ap_return_credits.length > 0) && (
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
              <div className="border-b border-slate-100 px-4 py-2">
                <span className="text-sm font-medium text-black">Piutang Retur Supplier</span>
              </div>
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
                    <th className="px-4 py-2">Source Retur</th>
                    <th className="px-4 py-2 text-right">Jumlah Awal</th>
                    <th className="px-4 py-2 text-right">Sudah Direfund</th>
                    <th className="px-4 py-2 text-right">Sisa</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {creditNotes.flatMap((cn) =>
                    cn.ap_return_credits.map((rc) => {
                      const used = rc.ap_return_credit_refunds.reduce((sum, r) => sum + r.amount, 0);
                      const remaining = rc.amount - used;
                      return (
                        <tr key={rc.id} className="border-b border-slate-100 hover:bg-slate-50">
                          <td className="px-4 py-2">{cn.source_ref}</td>
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
                    })
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {activeTab === "tukar" && (
        <div className="flex flex-col gap-3">
          {canReplace && (
            <div className="flex justify-end">
              <Button variant="toolbar" onClick={openReplaceForm}>
                Tukar Barang
              </Button>
            </div>
          )}
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
                  <th className="px-4 py-2">Tanggal</th>
                  <th className="px-4 py-2">Source Ref</th>
                  <th className="px-4 py-2">Item Ditukar</th>
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
                        {r.purchase_replacement_lines.map((l) => (
                          <li key={l.item_id}>
                            {l.items.name} — {l.qty_replaced} {l.items.uom}
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td className="px-4 py-2 text-right font-mono">
                      {r.purchase_replacement_lines.reduce((sum, l) => sum + l.total_cost, 0).toLocaleString("id-ID")}
                    </td>
                  </tr>
                ))}
                {replacements.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-center text-slate-400">
                      Belum ada tukar barang.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Modal
        open={showReturForm}
        onClose={() => setShowReturForm(false)}
        title="Retur — Kurangi Utang"
        maxWidth="max-w-2xl"
      >
        <p className="mb-4 text-sm text-slate-600">
          {goodsReceipt
            ? "Bill ini lewat Goods Receipt — isi qty per item yang diretur, stok otomatis berkurang dan Utang Usaha dikurangi sebesar cost fisik barang (bukan angka yang kamu ketik). Kalau bill ini udah lunas, kelebihannya otomatis jadi Piutang Retur Supplier."
            : "Bill ini gak lewat Goods Receipt — retur cuma ngurangin Utang Usaha lewat nominal yang kamu isi, gak ada stok yang disentuh. Kalau bill ini udah lunas, kelebihannya otomatis jadi Piutang Retur Supplier."}
        </p>
        <JournalPreviewPanel
          groups={[
            [
              { label: "Akun Utang Usaha (debit)", resolved: defaultAccounts["ap.payable"], side: "debit" },
              !!returCreditAccountId && {
                label: "Akun Persediaan/Beban (kredit)",
                resolved: returCreditAccountOptions().find((a) => a.id === returCreditAccountId),
                side: "credit",
              },
            ],
            returExcess > 0 && [
              {
                label: "Akun Piutang Retur Supplier (debit) — retur ini ngelebihin outstanding",
                resolved: defaultAccounts["ap.return_credit_asset"],
                side: "debit",
              },
              { label: "Akun Utang Usaha (kredit)", resolved: defaultAccounts["ap.payable"], side: "credit" },
            ],
          ]}
        />
        <form onSubmit={handleReturSubmit} className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="retur_date">Tanggal Retur</Label>
                <Input id="retur_date" type="date" value={returDate} onChange={(e) => setReturDate(e.target.value)} />
              </div>
              {!goodsReceipt && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="retur_amount">Nominal Retur (kurangin Utang Usaha)</Label>
                  <Input
                    id="retur_amount"
                    type="number"
                    min="0"
                    placeholder="0"
                    value={returAmount}
                    onChange={(e) => setReturAmount(e.target.value)}
                  />
                </div>
              )}
              <LockedAccountField
                label="Akun Utang Usaha (debit)"
                htmlFor="retur_payable_account"
                resolved={defaultAccounts["ap.payable"]}
              />
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="retur_credit_account">Akun Persediaan/Beban (kredit)</Label>
                <Select
                  id="retur_credit_account"
                  value={returCreditAccountId}
                  onChange={(e) => setReturCreditAccountId(e.target.value)}
                >
                  <option value="">Pilih akun...</option>
                  {returCreditAccountOptions().map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </Select>
                {returCreditAccountOptions().length === 0 && (
                  <p className="text-xs text-amber-600">
                    {goodsReceipt
                      ? "Gak ketemu baris debit di bill ini — hubungi admin."
                      : "Bill ini cuma didebit ke akun Persediaan, tanpa Goods Receipt — retur Persediaan wajib lewat Goods Receipt (bukti fisik). Hubungi admin kalau perlu retur bill ini."}
                  </p>
                )}
                {returCreditAccountOptions().length > 1 && (
                  <p className="text-xs text-slate-500">
                    Bill ini punya {returCreditAccountOptions().length} kategori debit berbeda — pilih yang mana yang
                    diretur.
                  </p>
                )}
              </div>
              <LockedAccountField
                label="Akun Piutang Retur Supplier (debit, cuma kalau retur ini bikin Utang Usaha jadi minus)"
                htmlFor="retur_return_credit_asset_account"
                resolved={defaultAccounts["ap.return_credit_asset"]}
              />
            </div>

            {goodsReceipt && (
              <div className="flex flex-col gap-2">
                <div className="grid grid-cols-[1fr_8rem] gap-2 text-sm font-medium text-slate-500">
                  <span>Item Diterima (sisa bisa diklaim)</span>
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
                      max={line.qty_available}
                      placeholder="0"
                      value={line.qty_returned}
                      onChange={(e) => updateReturLine(line.item_id, e.target.value)}
                    />
                  </div>
                ))}
                {returLines.length === 0 && (
                  <p className="text-sm text-slate-400">Semua item di bill ini udah diklaim penuh (retur atau tukar barang).</p>
                )}
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

      <Modal
        open={showReplaceForm}
        onClose={() => setShowReplaceForm(false)}
        title="Tukar Barang"
        maxWidth="max-w-2xl"
      >
        <p className="mb-4 text-sm text-slate-600">
          Barang rusak keluar, barang baik masuk — murni reklasifikasi stok, gak nyentuh Utang
          Usaha sama sekali (berdiri sendiri, gak lewat retur Opsi A). Utang Usaha bill ini
          tetap penuh.
        </p>
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
        <form onSubmit={handleReplaceSubmit} className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="replace_date">Tanggal</Label>
              <Input id="replace_date" type="date" value={replaceDate} onChange={(e) => setReplaceDate(e.target.value)} />
            </div>
            <LockedAccountField
              label="Akun Persediaan (debit barang masuk & kredit barang keluar)"
              htmlFor="replace_inventory_account"
              resolved={defaultAccounts["inventory.raw_material"]}
            />
          </div>

          <div className="flex flex-col gap-2">
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
              <p className="text-sm text-slate-400">Semua item di bill ini udah diklaim penuh (retur atau tukar barang).</p>
            )}
          </div>

          {replaceError && <FormError>{replaceError}</FormError>}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setShowReplaceForm(false)}>
              Batal
            </Button>
            <Button type="submit" disabled={replaceSubmitting || replaceLines.length === 0}>
              {replaceSubmitting ? "Menyimpan..." : "Simpan Tukar Barang"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={showApplyForm}
        onClose={() => setShowApplyForm(false)}
        title="Terapkan DP ke Bill Ini"
        maxWidth="max-w-2xl"
      >
        <p className="mb-4 text-sm text-slate-600">
          Reklasifikasi uang muka yang udah dibayar ke supplier ini jadi pengurang utang bill
          ini — bukan pembayaran baru.
        </p>
        <JournalPreviewPanel
          groups={[
            [
              { label: "Akun Utang Usaha (debit)", resolved: defaultAccounts["ap.payable"], side: "debit" },
              {
                label: "Akun Uang Muka Pembelian (kredit)",
                resolved: defaultAccounts["ap.deposit_asset"],
                side: "credit",
              },
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
              label="Akun Utang Usaha (debit)"
              htmlFor="apply_payable_account"
              resolved={defaultAccounts["ap.payable"]}
            />
            <LockedAccountField
              label="Akun Uang Muka Pembelian (kredit)"
              htmlFor="apply_deposit_asset_account"
              resolved={defaultAccounts["ap.deposit_asset"]}
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

      <Modal open={showPayForm} onClose={() => setShowPayForm(false)} title="Catat Pembayaran" maxWidth="max-w-2xl">
        <p className="mb-4 text-sm text-slate-500">
          Payment selalu nutup bill ini spesifik, boleh cicil (kurang dari sisa outstanding), tapi
          gak boleh lebih (overpay ditolak).
        </p>
        <JournalPreviewPanel
          groups={[
            [
              { label: "Akun Utang Usaha (debit)", resolved: defaultAccounts["ap.payable"], side: "debit" },
              {
                label: "Akun Kas/Bank (kredit)",
                resolved: resolveCashAccount(payCashMethod, defaultAccounts),
                side: "credit",
              },
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
            <LockedAccountField
              label="Akun Utang Usaha (debit)"
              htmlFor="pay_payable_account"
              resolved={defaultAccounts["ap.payable"]}
            />
            <CashMethodField
              label="Akun Kas/Bank (kredit)"
              htmlFor="pay_cash_account"
              method={payCashMethod}
              onChange={setPayCashMethod}
              defaultAccounts={defaultAccounts}
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
        title="Refund Tunai Piutang Retur Supplier"
        maxWidth="max-w-2xl"
      >
        <p className="mb-4 text-sm text-slate-600">
          Terima kembali sisa piutang retur ini dari supplier dalam bentuk kas/bank.
        </p>
        <JournalPreviewPanel
          groups={[
            [
              {
                label: "Akun Kas/Bank (debit)",
                resolved: resolveCashAccount(refundCreditCashMethod, defaultAccounts),
                side: "debit",
              },
              {
                label: "Akun Piutang Retur Supplier (kredit)",
                resolved: defaultAccounts["ap.return_credit_asset"],
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
            <CashMethodField
              label="Akun Kas/Bank (debit)"
              htmlFor="refund_credit_cash_account"
              method={refundCreditCashMethod}
              onChange={setRefundCreditCashMethod}
              defaultAccounts={defaultAccounts}
            />
            <LockedAccountField
              label="Akun Piutang Retur Supplier (kredit)"
              htmlFor="refund_credit_asset_account"
              resolved={defaultAccounts["ap.return_credit_asset"]}
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
