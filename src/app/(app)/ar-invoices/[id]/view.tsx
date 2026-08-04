"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { getLeafAccounts, type Account } from "@/lib/accounts/schema";
import { invoiceStatus, type ArInvoice } from "@/lib/ar-invoices/schema";
import {
  createArCreditNoteSchema,
  type GoodsIssueForInvoice,
} from "@/lib/ar-credit-notes/schema";
import { applyArDepositSchema, depositStatus, type ArDeposit } from "@/lib/ar-deposits/schema";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";

type ReturnLineInput = { item_id: string; name: string; uom: string; qty_available: number; qty_returned: string };

type JournalEntryDetail = {
  id: string;
  entry_date: string;
  description: string | null;
  source_ref: string;
  reverses_entry_id: string | null;
  journal_lines: { id: string; debit: number; credit: number; accounts: { code: string; name: string } }[];
};

type PaymentAllocationDetail = {
  id: string;
  amount: number;
  ar_payments: { id: string; payment_date: string; source_ref: string; amount: number };
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
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [reversedEntryIds, setReversedEntryIds] = useState<Set<string>>(new Set());
  const [journalEntries, setJournalEntries] = useState<JournalEntryDetail[]>([]);
  const [allocations, setAllocations] = useState<PaymentAllocationDetail[]>([]);
  const [creditNotes, setCreditNotes] = useState<CreditNoteDetail[]>([]);
  const [depositApplications, setDepositApplications] = useState<DepositApplicationDetail[]>([]);
  const [customerDeposits, setCustomerDeposits] = useState<ArDeposit[]>([]);
  const [goodsIssue, setGoodsIssue] = useState<GoodsIssueForInvoice | null>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const [showApplyForm, setShowApplyForm] = useState(false);
  const [applyDepositId, setApplyDepositId] = useState("");
  const [applyAmount, setApplyAmount] = useState("");
  const [applyDate, setApplyDate] = useState("");
  const [applySourceRef, setApplySourceRef] = useState("");
  const [applyDepositLiabilityAccountId, setApplyDepositLiabilityAccountId] = useState("");
  const [applyReceivableAccountId, setApplyReceivableAccountId] = useState("");
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applySubmitting, setApplySubmitting] = useState(false);

  const [showReturForm, setShowReturForm] = useState(false);
  const [returDate, setReturDate] = useState("");
  const [returSourceRef, setReturSourceRef] = useState("");
  const [returAmount, setReturAmount] = useState("");
  const [returContraAccountId, setReturContraAccountId] = useState("");
  const [returReceivableAccountId, setReturReceivableAccountId] = useState("");
  const [returHppAccountId, setReturHppAccountId] = useState("");
  const [returFinishedGoodAccountId, setReturFinishedGoodAccountId] = useState("");
  const [returLines, setReturLines] = useState<ReturnLineInput[]>([]);
  const [returError, setReturError] = useState<string | null>(null);
  const [returSubmitting, setReturSubmitting] = useState(false);

  const leafAccounts = getLeafAccounts(accounts);

  const load = useCallback(async () => {
    const { data: inv, error: invErr } = await supabase
      .from("ar_invoices")
      .select(
        "id, customer_id, invoice_date, due_date, description, source_ref, amount, journal_entry_id, created_at, customers(name), ar_payment_allocations(amount), ar_credit_notes(amount), ar_deposit_applications(amount)"
      )
      .eq("id", id)
      .single();
    if (invErr || !inv) {
      setLoadError(invErr?.message ?? "Invoice gak ditemukan.");
      return;
    }
    const loadedInvoice = inv as unknown as ArInvoice;
    setInvoice(loadedInvoice);

    const [
      { data: accs },
      { data: reversedRows },
      { data: entries, error: entriesErr },
      { data: allocs, error: allocErr },
      { data: cns, error: cnErr },
      { data: gi },
      { data: depApps, error: depAppErr },
      { data: custDeposits, error: custDepositsErr },
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
        .or(`id.eq.${loadedInvoice.journal_entry_id},reverses_entry_id.eq.${loadedInvoice.journal_entry_id}`)
        .order("entry_date"),
      supabase
        .from("ar_payment_allocations")
        .select("id, amount, ar_payments(id, payment_date, source_ref, amount)")
        .eq("invoice_id", id),
      supabase
        .from("ar_credit_notes")
        .select(
          "id, credit_note_date, source_ref, amount, created_at, inventory_returns(id, return_date, inventory_return_lines(item_id, qty_returned, total_cost, items(name, uom)))"
        )
        .eq("invoice_id", id)
        .order("credit_note_date"),
      supabase
        .from("goods_issues")
        .select("id, goods_issue_lines(item_id, qty_issued, items(name, uom))")
        .eq("invoice_id", id)
        .maybeSingle(),
      supabase
        .from("ar_deposit_applications")
        .select("id, amount, source_ref, journal_entry_id, ar_deposits(source_ref)")
        .eq("invoice_id", id),
      supabase
        .from("ar_deposits")
        .select(
          "id, customer_id, deposit_date, source_ref, amount, journal_entry_id, created_at, customers(name), ar_deposit_applications(id, amount, source_ref, journal_entry_id, ar_invoices(source_ref)), ar_deposit_forfeitures(id, forfeiture_date, source_ref, journal_entry_id)"
        )
        .eq("customer_id", loadedInvoice.customer_id)
        .order("deposit_date"),
    ]);

    setAccounts((accs ?? []) as Account[]);
    const reversedSet = new Set(
      ((reversedRows ?? []) as { reverses_entry_id: string }[]).map((r) => r.reverses_entry_id)
    );
    setReversedEntryIds(reversedSet);
    setJournalEntries((entries ?? []) as unknown as JournalEntryDetail[]);
    setAllocations((allocs ?? []) as unknown as PaymentAllocationDetail[]);
    setCreditNotes((cns ?? []) as unknown as CreditNoteDetail[]);
    setGoodsIssue((gi ?? null) as unknown as GoodsIssueForInvoice | null);
    setDepositApplications((depApps ?? []) as unknown as DepositApplicationDetail[]);
    setCustomerDeposits((custDeposits ?? []) as unknown as ArDeposit[]);
    setLoadError(
      entriesErr?.message ?? allocErr?.message ?? cnErr?.message ?? depAppErr?.message ?? custDepositsErr?.message ?? null
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

  function openReturForm() {
    setReturError(null);
    setReturDate("");
    setReturSourceRef("");
    setReturAmount("");
    setReturContraAccountId("");
    setReturReceivableAccountId("");
    setReturHppAccountId("");
    setReturFinishedGoodAccountId("");
    setReturLines(
      goodsIssue
        ? goodsIssue.goods_issue_lines.map((l) => ({
            item_id: l.item_id,
            name: l.items.name,
            uom: l.items.uom,
            qty_available: l.qty_issued,
            qty_returned: "",
          }))
        : []
    );
    setShowReturForm(true);
  }

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
      source_ref: returSourceRef,
      amount: returAmount,
      contra_revenue_account_id: returContraAccountId,
      receivable_account_id: returReceivableAccountId,
      lines: activeLines,
      hpp_account_id: returHppAccountId || undefined,
      finished_good_account_id: returFinishedGoodAccountId || undefined,
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
    const { error } = await supabase.rpc("create_ar_credit_note", {
      p_invoice_id: parsed.data.invoice_id,
      p_credit_note_date: parsed.data.credit_note_date,
      p_source_ref: parsed.data.source_ref,
      p_amount: parsed.data.amount,
      p_contra_revenue_account_id: parsed.data.contra_revenue_account_id,
      p_receivable_account_id: parsed.data.receivable_account_id,
      p_lines: parsed.data.lines.length > 0 ? parsed.data.lines : null,
      p_hpp_account_id: parsed.data.hpp_account_id ?? null,
      p_finished_good_account_id: parsed.data.finished_good_account_id ?? null,
    });
    setReturSubmitting(false);
    if (error) {
      setReturError(error.message);
      return;
    }

    setShowReturForm(false);
    await load();
  }

  function openApplyForm() {
    setApplyError(null);
    setApplyDepositId("");
    setApplyAmount("");
    setApplyDate("");
    setApplySourceRef("");
    setApplyDepositLiabilityAccountId("");
    setApplyReceivableAccountId("");
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
      source_ref: applySourceRef,
      deposit_liability_account_id: applyDepositLiabilityAccountId,
      receivable_account_id: applyReceivableAccountId,
    });
    if (!parsed.success) {
      setApplyError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setApplySubmitting(true);
    const { error } = await supabase.rpc("apply_ar_deposit", {
      p_deposit_id: parsed.data.deposit_id,
      p_invoice_id: parsed.data.invoice_id,
      p_amount: parsed.data.amount,
      p_entry_date: parsed.data.entry_date,
      p_source_ref: parsed.data.source_ref,
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
    const ref = window.prompt(
      `Batalkan invoice ${invoice.source_ref} (Rp${invoice.amount.toLocaleString("id-ID")})?\nMasukin rujukan dokumen buat entry pembalik:`,
      `Pembatalan ${invoice.source_ref}`
    );
    if (!ref) return;

    setCancelError(null);
    setCancelling(true);
    const { error } = await supabase.rpc("cancel_ar_invoice", {
      p_invoice_id: invoice.id,
      p_entry_date: new Date().toISOString().slice(0, 10),
      p_source_ref: ref,
    });
    setCancelling(false);
    if (error) {
      setCancelError(error.message);
      return;
    }
    await load();
  }

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  if (!invoice) {
    return <FormError>{loadError ?? "Invoice gak ditemukan."}</FormError>;
  }

  const isCancelled = reversedEntryIds.has(invoice.journal_entry_id);
  const { status, outstanding, allocated, returned } = invoiceStatus(invoice, isCancelled);
  const overdue =
    status !== "lunas" && status !== "dibatalkan" && invoice.due_date < new Date().toISOString().slice(0, 10);
  const canWrite = roles.includes("admin") || roles.includes("accountant");
  const canCancel = canWrite && !isCancelled && allocated === 0;
  const canRetur = canWrite && !isCancelled;
  const availableDeposits = customerDeposits.filter(
    (dep) => depositStatus(dep, reversedEntryIds).status === "belum_dipakai"
  );
  const canApplyDeposit = canWrite && !isCancelled && outstanding > 0 && availableDeposits.length > 0;
  const selectedDeposit = availableDeposits.find((dep) => dep.id === applyDepositId) ?? null;
  const selectedDepositRemaining = selectedDeposit ? depositStatus(selectedDeposit, reversedEntryIds).remaining : 0;

  return (
    <div className="flex w-full max-w-5xl flex-1 flex-col gap-6">
      <BackLink href="/ar-invoices" label="Kembali ke AR Invoices" />
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold text-black">
              {invoice.customers.name} — {invoice.source_ref}
            </h1>
            <span className={`rounded-full px-2 py-0.5 text-xs capitalize ${statusStyle[status]}`}>
              {status}
            </span>
            {overdue && (
              <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs text-red-700">Telat</span>
            )}
          </div>
          <p className="text-sm text-slate-500">
            {invoice.invoice_date} · Jatuh tempo {invoice.due_date}
            {invoice.description && ` · ${invoice.description}`}
          </p>
        </div>
        <div className="flex items-start gap-4">
          <div className="text-right">
            <div className="text-xs uppercase text-slate-400">Outstanding</div>
            <div className="font-mono text-lg font-medium text-black">
              {outstanding.toLocaleString("id-ID")}
            </div>
          </div>
          <div className="flex gap-1.5">
            {canApplyDeposit && (
              <Button variant="toolbar" onClick={() => (showApplyForm ? setShowApplyForm(false) : openApplyForm())}>
                {showApplyForm ? "Batal Terapkan DP" : "Terapkan DP"}
              </Button>
            )}
            {canRetur && (
              <Button variant="toolbar" onClick={() => (showReturForm ? setShowReturForm(false) : openReturForm())}>
                {showReturForm ? "Batal Retur" : "Retur"}
              </Button>
            )}
            {canCancel && (
              <Button variant="toolbar" onClick={handleCancel} disabled={cancelling}>
                {cancelling ? "Membatalkan..." : "Batalkan"}
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
            <dt className="text-xs uppercase text-slate-400">Jumlah Invoice</dt>
            <dd className="font-mono text-black">{invoice.amount.toLocaleString("id-ID")}</dd>
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

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-4 py-2">
          <span className="text-sm font-medium text-black">Pembayaran</span>
          <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
            {allocations.length}
          </span>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Tanggal</th>
              <th className="px-4 py-2">Source Ref</th>
              <th className="px-4 py-2 text-right">Total Pembayaran</th>
              <th className="px-4 py-2 text-right">Dialokasikan ke Invoice Ini</th>
            </tr>
          </thead>
          <tbody>
            {allocations.map((a) => (
              <tr key={a.id} className="border-b border-slate-100 hover:bg-slate-50">
                <td className="whitespace-nowrap px-4 py-2">{a.ar_payments.payment_date}</td>
                <td className="px-4 py-2">{a.ar_payments.source_ref}</td>
                <td className="px-4 py-2 text-right font-mono">
                  {a.ar_payments.amount.toLocaleString("id-ID")}
                </td>
                <td className="px-4 py-2 text-right font-mono">{a.amount.toLocaleString("id-ID")}</td>
              </tr>
            ))}
            {allocations.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-slate-400">
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

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-4 py-2">
          <span className="text-sm font-medium text-black">Retur</span>
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

      {showApplyForm && (
        <div className="rounded-xl border border-blue-200 bg-blue-50/40 p-6 shadow-sm">
          <h2 className="mb-4 font-semibold text-black">Terapkan DP ke Invoice Ini</h2>
          <p className="mb-4 text-sm text-slate-600">
            Reklasifikasi uang muka yang udah diterima jadi pengurang piutang invoice ini —
            bukan pembayaran baru.
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
                  placeholder="mis. Nota Kue #001"
                  value={applySourceRef}
                  onChange={(e) => setApplySourceRef(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="apply_deposit_liability_account">Akun Uang Muka Penjualan (debit)</Label>
                <Select
                  id="apply_deposit_liability_account"
                  value={applyDepositLiabilityAccountId}
                  onChange={(e) => setApplyDepositLiabilityAccountId(e.target.value)}
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
                <Label htmlFor="apply_receivable_account">Akun Piutang Usaha (kredit)</Label>
                <Select
                  id="apply_receivable_account"
                  value={applyReceivableAccountId}
                  onChange={(e) => setApplyReceivableAccountId(e.target.value)}
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

      {showReturForm && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/40 p-6 shadow-sm">
          <h2 className="mb-4 font-semibold text-black">Catat Retur</h2>
          <p className="mb-4 text-sm text-slate-600">
            {goodsIssue
              ? "Invoice ini lewat Goods Issue — isi qty per item yang balik, stok & HPP otomatis ke-reverse proporsional."
              : "Invoice ini gak lewat Goods Issue — retur cuma ngurangin piutang (kontra-revenue), gak ada stok yang disentuh."}
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
                  placeholder="mis. Nota retur #001"
                  value={returSourceRef}
                  onChange={(e) => setReturSourceRef(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="retur_amount">Nominal Retur (kurangin piutang)</Label>
                <Input
                  id="retur_amount"
                  type="number"
                  min="0"
                  placeholder="0"
                  value={returAmount}
                  onChange={(e) => setReturAmount(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="retur_contra_account">Akun Retur & Potongan Penjualan (debit)</Label>
                <Select
                  id="retur_contra_account"
                  value={returContraAccountId}
                  onChange={(e) => setReturContraAccountId(e.target.value)}
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
                <Label htmlFor="retur_receivable_account">Akun Piutang Usaha (kredit)</Label>
                <Select
                  id="retur_receivable_account"
                  value={returReceivableAccountId}
                  onChange={(e) => setReturReceivableAccountId(e.target.value)}
                >
                  <option value="">Pilih akun...</option>
                  {leafAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </Select>
              </div>
              {goodsIssue && (
                <>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="retur_hpp_account">Akun HPP (kredit, jurnal reversal)</Label>
                    <Select
                      id="retur_hpp_account"
                      value={returHppAccountId}
                      onChange={(e) => setReturHppAccountId(e.target.value)}
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
                    <Label htmlFor="retur_finished_good_account">Akun Persediaan Barang Jadi (debit)</Label>
                    <Select
                      id="retur_finished_good_account"
                      value={returFinishedGoodAccountId}
                      onChange={(e) => setReturFinishedGoodAccountId(e.target.value)}
                    >
                      <option value="">Pilih akun...</option>
                      {leafAccounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.code} — {a.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                </>
              )}
            </div>

            {goodsIssue && (
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
            )}

            {returError && <FormError>{returError}</FormError>}

            <Button type="submit" disabled={returSubmitting} className="w-fit">
              {returSubmitting ? "Menyimpan..." : "Simpan Retur"}
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
