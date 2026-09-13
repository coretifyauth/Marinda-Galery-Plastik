"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { billStatus, type ApBill } from "@/lib/ap-bills/schema";
import type { GoodsReceiptForBill } from "@/lib/ap-credit-notes/schema";
import { depositStatus, type ApDeposit } from "@/lib/ap-deposits/schema";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { Tabs, type TabDef } from "@/components/ui/tabs";
import { DetailRows } from "@/components/ui/detail-rows";
import { LoadingScreen } from "@/components/ui/loading-screen";

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
  return_lines: {
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
  replacement_lines: {
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

  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const load = useCallback(async () => {
    const { data: b, error: billErr } = await supabase
      .from("transactions")
      .select(
        "id, supplier_id:counterparty_id, bill_date:date, due_date, description, source_ref, supplier_document_ref, amount, journal_entry_id, created_at, counterparties(name), ap_payments:payments(amount), ap_returns:returns(amount, ap_return_credits:return_credits(amount)), ap_deposit_applications:deposit_applications(amount)"
      )
      .eq("id", id)
      .eq("type", "INBOUND")
      .single();
    if (billErr || !b) {
      setLoadError(billErr?.message ?? "Bill gak ditemukan.");
      return;
    }
    const loadedBill = b as unknown as ApBill;
    setBill(loadedBill);

    const [
      { data: reversedRows },
      { data: entries, error: entriesErr },
      { data: pays, error: paysErr },
      { data: cns, error: cnErr },
      { data: reps, error: repErr },
      { data: grn },
      { data: depApps, error: depAppErr },
      { data: supDeposits, error: supDepositsErr },
    ] = await Promise.all([
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
        .from("returns")
        .select(
          "id, credit_note_date, source_ref, amount, created_at, return_lines(item_id, qty_returned, total_cost, items(name, uom)), ap_return_credits:return_credits(id, amount, ap_return_credit_refunds:return_credit_refunds(amount))"
        )
        .eq("transaction_id", id)
        .eq("type", "OUTBOUND")
        .order("credit_note_date"),
      supabase
        .from("replacements")
        .select(
          "id, replacement_date, source_ref, created_at, replacement_lines(item_id, qty_replaced, total_cost, items(name, uom))"
        )
        .eq("transaction_id", id)
        .eq("type", "OUTBOUND")
        .order("replacement_date"),
      supabase
        .from("goods_notes")
        .select("id, goods_note_lines(item_id, qty, unit_cost, items(name, uom))")
        .eq("transaction_id", id)
        .eq("type", "INBOUND")
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
        .eq("type", "INBOUND")
        .order("deposit_date"),
    ]);

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

  if (checkingSession) {
    return <LoadingScreen />;
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

  const isFinancialOnly = !goodsReceipt;

  const tabs: TabDef[] = [
    { key: "jurnal", label: "Jurnal", badge: journalEntries.length },
    { key: "pembayaran", label: "Pembayaran", badge: payments.length },
    { key: "dp", label: "DP Diterapkan", badge: depositApplications.length },
    { key: "retur", label: "Retur — Kurangi Utang", badge: creditNotes.length },
    // Tukar Barang wajib qty fisik + goods receipt (create_replacement nolak
    // kalau gak ada) -- gak ada gunanya ditampilin buat bill financial-only, submit-nya bakal
    // ketolak RPC. Lihat docs/domain/accounts-payable.md submodule "Retur Barang ke Supplier".
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
      <BackLink href="/ap-bills" label="Kembali ke Tagihan" />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-black">Detail Tagihan</h1>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-sm font-mono text-slate-600">
            {bill.source_ref}
          </span>
          <span
            className={`rounded-full px-2.5 py-1 text-sm font-medium ${
              isFinancialOnly ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"
            }`}
            title={
              isFinancialOnly
                ? "Gak ada goods receipt -- bill ini gak punya barang fisik tercatat"
                : "Ada goods receipt -- bill ini punya barang fisik tercatat"
            }
          >
            {isFinancialOnly ? "Tanpa Barang Fisik" : "Ada Barang Fisik"}
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
                <th className="px-4 py-2">Rujukan Dokumen</th>
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
                      <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700">Pembalikan</span>
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
              <Button variant="toolbar" onClick={() => router.push(`/ap-bills/${id}/bayar`)}>
                Bayar
              </Button>
            </div>
          )}
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
                  <th className="px-4 py-2">Tanggal</th>
                  <th className="px-4 py-2">Rujukan Dokumen</th>
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
              <Button variant="toolbar" onClick={() => router.push(`/ap-bills/${id}/terapkan-dp`)}>
                Terapkan DP
              </Button>
            </div>
          )}
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
                  <th className="px-4 py-2">Rujukan Dokumen</th>
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
              <Button variant="toolbar" onClick={() => router.push(`/ap-bills/${id}/retur`)}>
                Retur — Kurangi Utang
              </Button>
            </div>
          )}
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
                  <th className="px-4 py-2">Tanggal</th>
                  <th className="px-4 py-2">Rujukan Dokumen</th>
                  <th className="px-4 py-2">Jalur</th>
                  <th className="px-4 py-2">Item Diretur</th>
                  <th className="px-4 py-2 text-right">Nominal</th>
                </tr>
              </thead>
              <tbody>
                {creditNotes.map((cn) => {
                  const isFull = cn.return_lines.length > 0;
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
                          {isFull ? "Ada Barang Fisik" : "Tanpa Barang Fisik"}
                        </span>
                      </td>
                      <td className="px-4 py-2">
                        {isFull ? (
                          <ul className="space-y-0.5">
                            {cn.return_lines.map((l) => (
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
                              <Button
                                variant="toolbar"
                                onClick={() => router.push(`/ap-bills/${id}/refund-piutang-retur/${rc.id}`)}
                              >
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
              <Button variant="toolbar" onClick={() => router.push(`/ap-bills/${id}/tukar-barang`)}>
                Tukar Barang
              </Button>
            </div>
          )}
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
                  <th className="px-4 py-2">Tanggal</th>
                  <th className="px-4 py-2">Rujukan Dokumen</th>
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
                        {r.replacement_lines.map((l) => (
                          <li key={l.item_id}>
                            {l.items.name} — {l.qty_replaced} {l.items.uom}
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td className="px-4 py-2 text-right font-mono">
                      {r.replacement_lines.reduce((sum, l) => sum + l.total_cost, 0).toLocaleString("id-ID")}
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

    </div>
  );
}
