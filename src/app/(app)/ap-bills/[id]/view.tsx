"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { getLeafAccounts, type Account } from "@/lib/accounts/schema";
import { billStatus, type ApBill } from "@/lib/ap-bills/schema";
import {
  createApCreditNoteSchema,
  type GoodsReceiptForBill,
} from "@/lib/ap-credit-notes/schema";
import { createPurchaseReplacementSchema } from "@/lib/purchase-replacements/schema";
import { createPurchaseWriteoffSchema } from "@/lib/purchase-writeoffs/schema";
import { applyApDepositSchema, depositStatus, type ApDeposit } from "@/lib/ap-deposits/schema";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";

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

type WriteoffLineInput = {
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

type WriteoffDetail = {
  id: string;
  writeoff_date: string;
  source_ref: string;
  created_at: string;
  purchase_writeoff_lines: {
    item_id: string;
    qty_written_off: number;
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
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [reversedEntryIds, setReversedEntryIds] = useState<Set<string>>(new Set());
  const [journalEntries, setJournalEntries] = useState<JournalEntryDetail[]>([]);
  const [payments, setPayments] = useState<PaymentDetail[]>([]);
  const [creditNotes, setCreditNotes] = useState<CreditNoteDetail[]>([]);
  const [replacements, setReplacements] = useState<ReplacementDetail[]>([]);
  const [writeoffs, setWriteoffs] = useState<WriteoffDetail[]>([]);
  const [goodsReceipt, setGoodsReceipt] = useState<GoodsReceiptForBill | null>(null);
  const [depositApplications, setDepositApplications] = useState<DepositApplicationDetail[]>([]);
  const [supplierDeposits, setSupplierDeposits] = useState<ApDeposit[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [showReturForm, setShowReturForm] = useState(false);
  const [returDate, setReturDate] = useState("");
  const [returSourceRef, setReturSourceRef] = useState("");
  const [returAmount, setReturAmount] = useState("");
  const [returPayableAccountId, setReturPayableAccountId] = useState("");
  const [returCreditAccountId, setReturCreditAccountId] = useState("");
  const [returReturnCreditAssetAccountId, setReturReturnCreditAssetAccountId] = useState("");
  const [returLines, setReturLines] = useState<ReturnLineInput[]>([]);
  const [returError, setReturError] = useState<string | null>(null);
  const [returSubmitting, setReturSubmitting] = useState(false);

  const [showReplaceForm, setShowReplaceForm] = useState(false);
  const [replaceDate, setReplaceDate] = useState("");
  const [replaceSourceRef, setReplaceSourceRef] = useState("");
  const [replaceInventoryAccountId, setReplaceInventoryAccountId] = useState("");
  const [replaceLines, setReplaceLines] = useState<ReplaceLineInput[]>([]);
  const [replaceError, setReplaceError] = useState<string | null>(null);
  const [replaceSubmitting, setReplaceSubmitting] = useState(false);

  const [showWriteoffForm, setShowWriteoffForm] = useState(false);
  const [writeoffDate, setWriteoffDate] = useState("");
  const [writeoffSourceRef, setWriteoffSourceRef] = useState("");
  const [writeoffLossExpenseAccountId, setWriteoffLossExpenseAccountId] = useState("");
  const [writeoffInventoryAccountId, setWriteoffInventoryAccountId] = useState("");
  const [writeoffLines, setWriteoffLines] = useState<WriteoffLineInput[]>([]);
  const [writeoffError, setWriteoffError] = useState<string | null>(null);
  const [writeoffSubmitting, setWriteoffSubmitting] = useState(false);

  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const [showApplyForm, setShowApplyForm] = useState(false);
  const [applyDepositId, setApplyDepositId] = useState("");
  const [applyAmount, setApplyAmount] = useState("");
  const [applyDate, setApplyDate] = useState("");
  const [applySourceRef, setApplySourceRef] = useState("");
  const [applyPayableAccountId, setApplyPayableAccountId] = useState("");
  const [applyDepositAssetAccountId, setApplyDepositAssetAccountId] = useState("");
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applySubmitting, setApplySubmitting] = useState(false);

  const leafAccounts = getLeafAccounts(accounts);

  const load = useCallback(async () => {
    const { data: b, error: billErr } = await supabase
      .from("ap_bills")
      .select(
        "id, supplier_id, bill_date, due_date, description, source_ref, amount, journal_entry_id, created_at, suppliers(name), ap_payments(amount), ap_credit_notes(amount)"
      )
      .eq("id", id)
      .single();
    if (billErr || !b) {
      setLoadError(billErr?.message ?? "Bill gak ditemukan.");
      return;
    }
    const loadedBill = b as unknown as ApBill;
    setBill(loadedBill);

    const [
      { data: accs },
      { data: reversedRows },
      { data: entries, error: entriesErr },
      { data: pays, error: paysErr },
      { data: cns, error: cnErr },
      { data: reps, error: repErr },
      { data: wos, error: woErr },
      { data: grn },
      { data: depApps, error: depAppErr },
      { data: supDeposits, error: supDepositsErr },
    ] = await Promise.all([
      supabase
        .from("accounts")
        .select("id, code, name, category, normal_balance, parent_id, archived_at")
        .order("code"),
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
        .from("ap_payments")
        .select("id, payment_date, source_ref, amount")
        .eq("bill_id", id)
        .order("payment_date"),
      supabase
        .from("ap_credit_notes")
        .select(
          "id, credit_note_date, source_ref, amount, created_at, purchase_return_lines(item_id, qty_returned, total_cost, items(name, uom))"
        )
        .eq("bill_id", id)
        .order("credit_note_date"),
      supabase
        .from("purchase_replacements")
        .select(
          "id, replacement_date, source_ref, created_at, purchase_replacement_lines(item_id, qty_replaced, total_cost, items(name, uom))"
        )
        .eq("bill_id", id)
        .order("replacement_date"),
      supabase
        .from("purchase_writeoffs")
        .select(
          "id, writeoff_date, source_ref, created_at, purchase_writeoff_lines(item_id, qty_written_off, total_cost, items(name, uom))"
        )
        .eq("bill_id", id)
        .order("writeoff_date"),
      supabase
        .from("goods_receipt_notes")
        .select("id, goods_receipt_lines(item_id, qty_received, unit_cost, items(name, uom))")
        .eq("bill_id", id)
        .maybeSingle(),
      supabase
        .from("ap_deposit_applications")
        .select("id, amount, source_ref, journal_entry_id, ap_deposits(source_ref)")
        .eq("bill_id", id),
      supabase
        .from("ap_deposits")
        .select(
          "id, supplier_id, deposit_date, source_ref, amount, journal_entry_id, created_at, suppliers(name), ap_deposit_applications(id, amount, source_ref, journal_entry_id, ap_bills(source_ref)), ap_deposit_refunds(id, amount, refund_date, source_ref, journal_entry_id), ap_deposit_forfeitures(id, amount, forfeiture_date, source_ref, journal_entry_id)"
        )
        .eq("supplier_id", loadedBill.supplier_id)
        .order("deposit_date"),
    ]);

    setAccounts((accs ?? []) as Account[]);
    setReversedEntryIds(
      new Set(((reversedRows ?? []) as { reverses_entry_id: string }[]).map((r) => r.reverses_entry_id))
    );
    setJournalEntries((entries ?? []) as unknown as JournalEntryDetail[]);
    setPayments((pays ?? []) as unknown as PaymentDetail[]);
    setCreditNotes((cns ?? []) as unknown as CreditNoteDetail[]);
    setReplacements((reps ?? []) as unknown as ReplacementDetail[]);
    setWriteoffs((wos ?? []) as unknown as WriteoffDetail[]);
    setGoodsReceipt((grn ?? null) as unknown as GoodsReceiptForBill | null);
    setDepositApplications((depApps ?? []) as unknown as DepositApplicationDetail[]);
    setSupplierDeposits((supDeposits ?? []) as unknown as ApDeposit[]);
    setLoadError(
      entriesErr?.message ??
        paysErr?.message ??
        cnErr?.message ??
        repErr?.message ??
        woErr?.message ??
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
   * + Opsi B (purchase_replacement_lines) + Opsi C (purchase_writeoff_lines) — mirror
   * purchase_returned_qty() di database (0035 + diperluas 0016). Fisiknya cuma ada 1 pool
   * qty_received per item yang bisa diklaim, mau lewat jalur mana pun. Dipakai buat cap qty
   * input di ketiga form biar gak nembus batas sebelum kena guard server.
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
    for (const w of writeoffs) {
      for (const l of w.purchase_writeoff_lines) {
        map.set(l.item_id, (map.get(l.item_id) ?? 0) + l.qty_written_off);
      }
    }
    return map;
  }

  function openReturForm() {
    setReturError(null);
    setReturDate("");
    setReturSourceRef("");
    setReturAmount("");
    setReturPayableAccountId("");
    setReturCreditAccountId("");
    setReturReturnCreditAssetAccountId("");
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
      source_ref: returSourceRef,
      amount: goodsReceipt ? estimatedAmount : returAmount,
      payable_account_id: returPayableAccountId,
      credit_account_id: returCreditAccountId,
      lines: activeLines,
      return_credit_asset_account_id: returReturnCreditAssetAccountId || undefined,
    });
    if (!parsed.success) {
      setReturError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setReturSubmitting(true);
    const { error } = await supabase.rpc("create_ap_credit_note", {
      p_bill_id: parsed.data.bill_id,
      p_credit_note_date: parsed.data.credit_note_date,
      p_source_ref: parsed.data.source_ref,
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
    setReplaceSourceRef("");
    setReplaceInventoryAccountId("");
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
      source_ref: replaceSourceRef,
      lines: activeLines,
      inventory_account_id: replaceInventoryAccountId,
    });
    if (!parsed.success) {
      setReplaceError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setReplaceSubmitting(true);
    const { error } = await supabase.rpc("create_purchase_replacement", {
      p_bill_id: parsed.data.bill_id,
      p_replacement_date: parsed.data.replacement_date,
      p_source_ref: parsed.data.source_ref,
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

  function openWriteoffForm() {
    setWriteoffError(null);
    setWriteoffDate("");
    setWriteoffSourceRef("");
    setWriteoffLossExpenseAccountId("");
    setWriteoffInventoryAccountId("");
    const claimed = claimedQtyByItem();
    setWriteoffLines(
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
    setShowWriteoffForm(true);
  }

  function updateWriteoffLine(itemId: string, qty: string) {
    setWriteoffLines((prev) => prev.map((l) => (l.item_id === itemId ? { ...l, qty } : l)));
  }

  async function handleWriteoffSubmit(e: FormEvent) {
    e.preventDefault();
    if (!bill) return;
    setWriteoffError(null);

    const activeLines = writeoffLines
      .filter((l) => l.qty.trim() !== "")
      .map((l) => ({ item_id: l.item_id, qty: l.qty }));

    if (activeLines.length === 0) {
      setWriteoffError("Isi minimal 1 baris qty write-off");
      return;
    }

    const parsed = createPurchaseWriteoffSchema.safeParse({
      bill_id: bill.id,
      writeoff_date: writeoffDate,
      source_ref: writeoffSourceRef,
      lines: activeLines,
      loss_expense_account_id: writeoffLossExpenseAccountId,
      inventory_account_id: writeoffInventoryAccountId,
    });
    if (!parsed.success) {
      setWriteoffError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setWriteoffSubmitting(true);
    const { error } = await supabase.rpc("create_purchase_writeoff", {
      p_bill_id: parsed.data.bill_id,
      p_writeoff_date: parsed.data.writeoff_date,
      p_source_ref: parsed.data.source_ref,
      p_lines: parsed.data.lines,
      p_loss_expense_account_id: parsed.data.loss_expense_account_id,
      p_inventory_account_id: parsed.data.inventory_account_id,
    });
    setWriteoffSubmitting(false);
    if (error) {
      setWriteoffError(error.message);
      return;
    }

    setShowWriteoffForm(false);
    await load();
  }

  async function handleCancel() {
    if (!bill) return;
    const reasonRef = window.prompt(
      `Batalkan bill ${bill.source_ref} (Rp${bill.amount.toLocaleString("id-ID")})?\nMasukin rujukan dokumen buat entry pembalik:`,
      `Pembatalan ${bill.source_ref}`
    );
    if (!reasonRef) return;

    setCancelError(null);
    setCancelling(true);
    const { error } = await supabase.rpc("cancel_ap_bill", {
      p_bill_id: bill.id,
      p_entry_date: new Date().toISOString().slice(0, 10),
      p_source_ref: reasonRef,
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
    setApplySourceRef("");
    setApplyPayableAccountId("");
    setApplyDepositAssetAccountId("");
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
      source_ref: applySourceRef,
      payable_account_id: applyPayableAccountId,
      deposit_asset_account_id: applyDepositAssetAccountId,
    });
    if (!parsed.success) {
      setApplyError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setApplySubmitting(true);
    const { error } = await supabase.rpc("apply_ap_deposit", {
      p_deposit_id: parsed.data.deposit_id,
      p_bill_id: parsed.data.bill_id,
      p_amount: parsed.data.amount,
      p_entry_date: parsed.data.entry_date,
      p_source_ref: parsed.data.source_ref,
      p_payable_account_id: parsed.data.payable_account_id,
      p_deposit_asset_account_id: parsed.data.deposit_asset_account_id,
    });
    setApplySubmitting(false);
    if (error) {
      setApplyError(error.message);
      return;
    }

    setShowApplyForm(false);
    await load();
  }

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  if (!bill) {
    return <FormError>{loadError ?? "Bill gak ditemukan."}</FormError>;
  }

  const isCancelled = reversedEntryIds.has(bill.journal_entry_id);
  const { status, outstanding, allocated, returned } = billStatus(bill, isCancelled);
  const overdue = status !== "lunas" && status !== "dibatalkan" && bill.due_date < new Date().toISOString().slice(0, 10);
  const canWrite = roles.includes("admin") || roles.includes("accountant");
  const canRetur = canWrite && !isCancelled;
  const canReplace = canWrite && !isCancelled && goodsReceipt !== null;
  const canWriteoff = canWrite && !isCancelled && goodsReceipt !== null;
  const canCancel = canWrite && !isCancelled && allocated === 0;
  const availableDeposits = supplierDeposits.filter(
    (dep) => depositStatus(dep, reversedEntryIds).remaining > 0.005
  );
  const canApplyDeposit = canWrite && !isCancelled && outstanding > 0 && availableDeposits.length > 0;
  const selectedDeposit = availableDeposits.find((dep) => dep.id === applyDepositId) ?? null;
  const selectedDepositRemaining = selectedDeposit ? depositStatus(selectedDeposit, reversedEntryIds).remaining : 0;

  return (
    <div className="flex w-full max-w-5xl flex-1 flex-col gap-6">
      <BackLink href="/ap-bills" label="Kembali ke AP Bills" />
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold text-black">
              {bill.suppliers.name} — {bill.source_ref}
            </h1>
            <span className={`rounded-full px-2 py-0.5 text-xs capitalize ${statusStyle[status]}`}>{status}</span>
            {overdue && <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs text-red-700">Telat</span>}
          </div>
          <p className="text-sm text-slate-500">
            {bill.bill_date} · Jatuh tempo {bill.due_date}
            {bill.description && ` · ${bill.description}`}
          </p>
        </div>
        <div className="flex items-start gap-4">
          <div className="text-right">
            <div className="text-xs uppercase text-slate-400">Outstanding</div>
            <div className="font-mono text-lg font-medium text-black">{outstanding.toLocaleString("id-ID")}</div>
          </div>
          <div className="flex gap-1.5">
            {canRetur && (
              <Button variant="toolbar" onClick={() => (showReturForm ? setShowReturForm(false) : openReturForm())}>
                {showReturForm ? "Batal Retur" : "Retur — Kurangi Utang"}
              </Button>
            )}
            {canReplace && (
              <Button
                variant="toolbar"
                onClick={() => (showReplaceForm ? setShowReplaceForm(false) : openReplaceForm())}
              >
                {showReplaceForm ? "Batal Tukar Barang" : "Tukar Barang"}
              </Button>
            )}
            {canWriteoff && (
              <Button
                variant="toolbar"
                onClick={() => (showWriteoffForm ? setShowWriteoffForm(false) : openWriteoffForm())}
              >
                {showWriteoffForm ? "Batal Tulis-jadi-Beban" : "Tulis-jadi-Beban"}
              </Button>
            )}
            {canApplyDeposit && (
              <Button variant="toolbar" onClick={() => (showApplyForm ? setShowApplyForm(false) : openApplyForm())}>
                {showApplyForm ? "Batal Terapkan DP" : "Terapkan DP"}
              </Button>
            )}
            {canCancel && (
              <Button variant="toolbar" onClick={handleCancel} disabled={cancelling}>
                {cancelling ? "Membatalkan..." : "Batalkan Bill"}
              </Button>
            )}
          </div>
        </div>
      </div>

      {loadError && <FormError>{loadError}</FormError>}
      {cancelError && <FormError>{cancelError}</FormError>}

      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs uppercase text-slate-400">Jumlah Bill</dt>
            <dd className="font-mono text-black">{bill.amount.toLocaleString("id-ID")}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-400">Terbayar</dt>
            <dd className="font-mono text-black">{allocated.toLocaleString("id-ID")}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-400">Retur</dt>
            <dd className="font-mono text-black">{returned.toLocaleString("id-ID")}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-400">Outstanding</dt>
            <dd className="font-mono font-medium text-black">{outstanding.toLocaleString("id-ID")}</dd>
          </div>
        </dl>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-4 py-2">
          <span className="text-sm font-medium text-black">Jurnal Terkait</span>
          <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
            {journalEntries.length}
          </span>
        </div>
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

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-4 py-2">
          <span className="text-sm font-medium text-black">Pembayaran</span>
          <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
            {payments.length}
          </span>
        </div>
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

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-4 py-2">
          <span className="text-sm font-medium text-black">DP Diterapkan</span>
          <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
            {depositApplications.length}
          </span>
        </div>
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

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-4 py-2">
          <span className="text-sm font-medium text-black">Retur (Kurangi Utang)</span>
          <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
            {creditNotes.length}
          </span>
        </div>
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
                            {l.items.name} — {l.qty_returned} {l.items.uom} (cost {l.total_cost.toLocaleString("id-ID")})
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

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-4 py-2">
          <span className="text-sm font-medium text-black">Tukar Barang</span>
          <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
            {replacements.length}
          </span>
        </div>
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

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-4 py-2">
          <span className="text-sm font-medium text-black">Tulis-jadi-Beban (Kerugian Barang Rusak)</span>
          <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
            {writeoffs.length}
          </span>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Tanggal</th>
              <th className="px-4 py-2">Source Ref</th>
              <th className="px-4 py-2">Item Ditulis-jadi-Beban</th>
              <th className="px-4 py-2 text-right">Cost</th>
            </tr>
          </thead>
          <tbody>
            {writeoffs.map((w) => (
              <tr key={w.id} className="border-b border-slate-100 align-top hover:bg-slate-50">
                <td className="whitespace-nowrap px-4 py-2">{w.writeoff_date}</td>
                <td className="px-4 py-2">{w.source_ref}</td>
                <td className="px-4 py-2">
                  <ul className="space-y-0.5">
                    {w.purchase_writeoff_lines.map((l) => (
                      <li key={l.item_id}>
                        {l.items.name} — {l.qty_written_off} {l.items.uom}
                      </li>
                    ))}
                  </ul>
                </td>
                <td className="px-4 py-2 text-right font-mono">
                  {w.purchase_writeoff_lines.reduce((sum, l) => sum + l.total_cost, 0).toLocaleString("id-ID")}
                </td>
              </tr>
            ))}
            {writeoffs.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-slate-400">
                  Belum ada write-off.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showReturForm && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/40 p-6 shadow-sm">
          <h2 className="mb-4 font-semibold text-black">Retur — Kurangi Utang</h2>
          <p className="mb-4 text-sm text-slate-600">
            {goodsReceipt
              ? "Bill ini lewat Goods Receipt — isi qty per item yang diretur, stok otomatis berkurang dan Utang Usaha dikurangi sebesar cost fisik barang (bukan angka yang kamu ketik). Kalau bill ini udah lunas, kelebihannya otomatis jadi Piutang Retur Supplier."
              : "Bill ini gak lewat Goods Receipt — retur cuma ngurangin Utang Usaha lewat nominal yang kamu isi, gak ada stok yang disentuh. Kalau bill ini udah lunas, kelebihannya otomatis jadi Piutang Retur Supplier."}
          </p>
          <form onSubmit={handleReturSubmit} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="retur_date">Tanggal Retur</Label>
                <Input id="retur_date" type="date" value={returDate} onChange={(e) => setReturDate(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="retur_source_ref">Rujukan dokumen</Label>
                <Input
                  id="retur_source_ref"
                  placeholder="mis. Retur-001"
                  value={returSourceRef}
                  onChange={(e) => setReturSourceRef(e.target.value)}
                />
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
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="retur_payable_account">Akun Utang Usaha (debit)</Label>
                <Select
                  id="retur_payable_account"
                  value={returPayableAccountId}
                  onChange={(e) => setReturPayableAccountId(e.target.value)}
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
                <Label htmlFor="retur_credit_account">Akun Persediaan/Beban (kredit)</Label>
                <Select
                  id="retur_credit_account"
                  value={returCreditAccountId}
                  onChange={(e) => setReturCreditAccountId(e.target.value)}
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
                <Label htmlFor="retur_return_credit_asset_account">
                  Akun Piutang Retur Supplier (debit, cuma kalau retur ini bikin Utang Usaha jadi minus)
                </Label>
                <Select
                  id="retur_return_credit_asset_account"
                  value={returReturnCreditAssetAccountId}
                  onChange={(e) => setReturReturnCreditAssetAccountId(e.target.value)}
                >
                  <option value="">Pilih akun (opsional)...</option>
                  {leafAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </Select>
              </div>
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
                  <p className="text-sm text-slate-400">Semua item di bill ini udah diklaim penuh (retur, tukar barang, atau write-off).</p>
                )}
              </div>
            )}

            {returError && <FormError>{returError}</FormError>}

            <Button type="submit" disabled={returSubmitting} className="w-fit">
              {returSubmitting ? "Menyimpan..." : "Simpan Retur"}
            </Button>
          </form>
        </div>
      )}

      {showReplaceForm && (
        <div className="rounded-xl border border-purple-200 bg-purple-50/40 p-6 shadow-sm">
          <h2 className="mb-4 font-semibold text-black">Tukar Barang</h2>
          <p className="mb-4 text-sm text-slate-600">
            Barang rusak keluar, barang baik masuk — murni reklasifikasi stok, gak nyentuh Utang
            Usaha sama sekali (berdiri sendiri, gak lewat retur Opsi A). Utang Usaha bill ini
            tetap penuh.
          </p>
          <form onSubmit={handleReplaceSubmit} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="replace_date">Tanggal</Label>
                <Input id="replace_date" type="date" value={replaceDate} onChange={(e) => setReplaceDate(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="replace_source_ref">Rujukan dokumen</Label>
                <Input
                  id="replace_source_ref"
                  placeholder="mis. Tukar-001"
                  value={replaceSourceRef}
                  onChange={(e) => setReplaceSourceRef(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="replace_inventory_account">Akun Persediaan (debit barang masuk & kredit barang keluar)</Label>
                <Select
                  id="replace_inventory_account"
                  value={replaceInventoryAccountId}
                  onChange={(e) => setReplaceInventoryAccountId(e.target.value)}
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
                <p className="text-sm text-slate-400">Semua item di bill ini udah diklaim penuh (retur, tukar barang, atau write-off).</p>
              )}
            </div>

            {replaceError && <FormError>{replaceError}</FormError>}

            <Button type="submit" disabled={replaceSubmitting || replaceLines.length === 0} className="w-fit">
              {replaceSubmitting ? "Menyimpan..." : "Simpan Tukar Barang"}
            </Button>
          </form>
        </div>
      )}

      {showWriteoffForm && (
        <div className="rounded-xl border border-red-200 bg-red-50/40 p-6 shadow-sm">
          <h2 className="mb-4 font-semibold text-black">Tulis-jadi-Beban (Kerugian Barang Rusak)</h2>
          <p className="mb-4 text-sm text-slate-600">
            Supplier nolak kompensasi sama sekali — gak kurangin Utang Usaha, gak kirim
            pengganti. Barang rusak ini murni kerugian yang ditanggung sendiri, diakui sebagai
            Beban Kerugian Barang Rusak. Utang Usaha bill ini tetap penuh.
          </p>
          <form onSubmit={handleWriteoffSubmit} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="writeoff_date">Tanggal</Label>
                <Input
                  id="writeoff_date"
                  type="date"
                  value={writeoffDate}
                  onChange={(e) => setWriteoffDate(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="writeoff_source_ref">Rujukan dokumen</Label>
                <Input
                  id="writeoff_source_ref"
                  placeholder="mis. WriteOff-001"
                  value={writeoffSourceRef}
                  onChange={(e) => setWriteoffSourceRef(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="writeoff_loss_expense_account">Akun Beban Kerugian Barang Rusak (debit)</Label>
                <Select
                  id="writeoff_loss_expense_account"
                  value={writeoffLossExpenseAccountId}
                  onChange={(e) => setWriteoffLossExpenseAccountId(e.target.value)}
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
                <Label htmlFor="writeoff_inventory_account">Akun Persediaan (kredit)</Label>
                <Select
                  id="writeoff_inventory_account"
                  value={writeoffInventoryAccountId}
                  onChange={(e) => setWriteoffInventoryAccountId(e.target.value)}
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
              <div className="grid grid-cols-[1fr_8rem] gap-2 text-sm font-medium text-slate-500">
                <span>Item Diterima (sisa bisa diklaim)</span>
                <span>Qty Write-off</span>
              </div>
              {writeoffLines.map((line) => (
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
                    onChange={(e) => updateWriteoffLine(line.item_id, e.target.value)}
                  />
                </div>
              ))}
              {writeoffLines.length === 0 && (
                <p className="text-sm text-slate-400">Semua item di bill ini udah diklaim penuh (retur, tukar barang, atau write-off).</p>
              )}
            </div>

            {writeoffError && <FormError>{writeoffError}</FormError>}

            <Button type="submit" disabled={writeoffSubmitting || writeoffLines.length === 0} className="w-fit">
              {writeoffSubmitting ? "Menyimpan..." : "Simpan Write-off"}
            </Button>
          </form>
        </div>
      )}

      {showApplyForm && (
        <div className="rounded-xl border border-blue-200 bg-blue-50/40 p-6 shadow-sm">
          <h2 className="mb-4 font-semibold text-black">Terapkan DP ke Bill Ini</h2>
          <p className="mb-4 text-sm text-slate-600">
            Reklasifikasi uang muka yang udah dibayar ke supplier ini jadi pengurang utang bill
            ini — bukan pembayaran baru.
          </p>
          <form onSubmit={handleApplySubmit} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
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
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="apply_source_ref">Rujukan dokumen</Label>
                <Input
                  id="apply_source_ref"
                  placeholder="mis. Nota Bahan Baku #001"
                  value={applySourceRef}
                  onChange={(e) => setApplySourceRef(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="apply_payable_account">Akun Utang Usaha (debit)</Label>
                <Select
                  id="apply_payable_account"
                  value={applyPayableAccountId}
                  onChange={(e) => setApplyPayableAccountId(e.target.value)}
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
                <Label htmlFor="apply_deposit_asset_account">Akun Uang Muka Pembelian (kredit)</Label>
                <Select
                  id="apply_deposit_asset_account"
                  value={applyDepositAssetAccountId}
                  onChange={(e) => setApplyDepositAssetAccountId(e.target.value)}
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

            {applyError && <FormError>{applyError}</FormError>}

            <Button type="submit" disabled={applySubmitting} className="w-fit">
              {applySubmitting ? "Menyimpan..." : "Terapkan DP"}
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
