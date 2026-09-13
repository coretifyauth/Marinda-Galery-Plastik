"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { invoiceStatus, type ArInvoice } from "@/lib/ar-invoices/schema";
import { type GoodsIssueForInvoice } from "@/lib/ar-credit-notes/schema";
import { depositStatus, type ArDeposit } from "@/lib/ar-deposits/schema";
import { type WarrantyReplacement } from "@/lib/ar-warranty-replacements/schema";
import { returnCreditRemaining, type ArReturnCredit } from "@/lib/ar-return-credits/schema";
import type { ChargeCategoryWithAccount } from "@/lib/charge-lines/schema";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { DetailRows } from "@/components/ui/detail-rows";
import { Tabs, type TabDef } from "@/components/ui/tabs";
import { buildLetterheadHtml, buildSignatureBlockHtml, escapeHtml, openPrintWindow } from "@/lib/print/print-window";
import { fetchCompanySettings, type CompanySettings } from "@/lib/company-settings/schema";
import { fetchActiveSignatoryLabels } from "@/lib/document-signatories/schema";
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
  return_lines: {
    item_id: string;
    qty_returned: number;
    total_cost: number;
    items: { name: string; uom: string };
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
  const [reversedEntryIds, setReversedEntryIds] = useState<Set<string>>(new Set());
  const [journalEntries, setJournalEntries] = useState<JournalEntryDetail[]>([]);
  const [payments, setPayments] = useState<PaymentDetail[]>([]);
  const [creditNotes, setCreditNotes] = useState<CreditNoteDetail[]>([]);
  const [depositApplications, setDepositApplications] = useState<DepositApplicationDetail[]>([]);
  const [customerDeposits, setCustomerDeposits] = useState<ArDeposit[]>([]);
  const [customerReturnCredits, setCustomerReturnCredits] = useState<ArReturnCredit[]>([]);
  const [goodsIssue, setGoodsIssue] = useState<GoodsIssueForInvoice | null>(null);
  const [creditLines, setCreditLines] = useState<InvoiceCreditLine[]>([]);
  const [chargeTypes, setChargeTypes] = useState<ChargeCategoryWithAccount[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [companySettings, setCompanySettings] = useState<CompanySettings | null>(null);
  const [signatoryLabels, setSignatoryLabels] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("jurnal");

  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const [replacements, setReplacements] = useState<WarrantyReplacement[]>([]);

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

    const [
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
        .from("returns")
        .select(
          "id, credit_note_date, source_ref, amount, created_at, return_lines(item_id, qty_returned, total_cost, items(name, uom))"
        )
        .eq("transaction_id", id)
        .eq("type", "INBOUND")
        .order("credit_note_date"),
      supabase
        .from("replacements")
        .select(
          "id, invoice_id:transaction_id, replacement_date, source_ref, created_at, replacement_lines(item_id, qty_replaced, total_cost, items(name, uom))"
        )
        .eq("transaction_id", id)
        .eq("type", "INBOUND")
        .order("replacement_date"),
      supabase
        .from("goods_notes")
        .select(
          "id, goods_note_lines(item_id, qty, order_line_id, items(name, uom), order_lines(unit_price))"
        )
        .eq("transaction_id", id)
        .eq("type", "OUTBOUND")
        .maybeSingle(),
      supabase
        .from("transaction_lines")
        .select("id, account_id, amount, is_tax, accounts(code, name)")
        .eq("transaction_id", id)
        .order("is_tax"),
      supabase.from("charge_categories").select("id, name, account_id, archived_at, accounts(code, name)").eq("module", "ar"),
      supabase
        .from("deposit_applications")
        .select("id, amount, source_ref, journal_entry_id, ar_deposits:deposits(source_ref)")
        .eq("transaction_id", id),
      supabase
        .from("deposits")
        .select(
          "id, customer_id:counterparty_id, deposit_date, source_ref, amount, journal_entry_id, created_at, counterparties(name), ar_deposit_applications:deposit_applications(id, amount, source_ref, journal_entry_id, ar_invoices:transactions(source_ref)), ar_deposit_refunds:deposit_refunds(id, amount, refund_date, source_ref, journal_entry_id), ar_deposit_forfeitures:deposit_forfeitures(id, amount, forfeiture_date, source_ref, journal_entry_id)"
        )
        .eq("counterparty_id", loadedInvoice.customer_id)
        .eq("type", "OUTBOUND")
        .order("deposit_date"),
      supabase
        .from("return_credits")
        .select(
          "id, customer_id:counterparty_id, return_id, amount, journal_entry_id, created_at, counterparties(name), ar_returns:returns(source_ref, credit_note_date), ar_return_credit_refunds:return_credit_refunds(id, amount, source_ref, journal_entry_id, created_at)"
        )
        .eq("counterparty_id", loadedInvoice.customer_id)
        .eq("type", "INBOUND")
        .order("created_at"),
    ]);

    const reversedSet = new Set(
      ((reversedRows ?? []) as { reverses_entry_id: string }[]).map((r) => r.reverses_entry_id)
    );
    setReversedEntryIds(reversedSet);
    setJournalEntries((entries ?? []) as unknown as JournalEntryDetail[]);
    setPayments((pay ?? []) as unknown as PaymentDetail[]);
    setCreditNotes((cns ?? []) as unknown as CreditNoteDetail[]);
    setCreditLines((creditLineRows ?? []) as unknown as InvoiceCreditLine[]);
    setChargeTypes((chargeTypeRows ?? []) as unknown as ChargeCategoryWithAccount[]);
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

  if (checkingSession) {
    return <LoadingScreen />;
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
    creditNotes.some((cn) => cn.id === rc.return_id)
  );
  const availableDeposits = customerDeposits.filter(
    (dep) => depositStatus(dep, reversedEntryIds).remaining > 0.005
  );
  const canApplyDeposit = canWrite && !isCancelled && outstanding > 0 && availableDeposits.length > 0;
  // Ganti Barang independen dari credit note sekarang (mirror create_replacement type=OUTBOUND AP) --
  // cuma butuh goods_issue ada (invoice financial-only gak punya barang fisik buat ditukar).
  const canReplace = canWrite && !isCancelled && !!goodsIssue;

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
    const hasItemPrice = !!goodsIssue?.goods_note_lines.some((l) => l.order_lines);
    const itemRows = goodsIssue
      ? goodsIssue.goods_note_lines
          .map((l) => {
            const unitPrice = l.order_lines?.unit_price;
            const subtotal = unitPrice != null ? unitPrice * l.qty : null;
            return hasItemPrice
              ? `<tr>
                  <td>${escapeHtml(l.items.name)}</td>
                  <td class="num">${l.qty} ${escapeHtml(l.items.uom)}</td>
                  <td class="num">${unitPrice != null ? `Rp${unitPrice.toLocaleString("id-ID")}` : "-"}</td>
                  <td class="num">${subtotal != null ? `Rp${subtotal.toLocaleString("id-ID")}` : "-"}</td>
                </tr>`
              : `<tr><td>${escapeHtml(l.items.name)}</td><td class="num">${l.qty} ${escapeHtml(l.items.uom)}</td></tr>`;
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
    // match ke katalog charge_categories (module ar) -- dilabeli pakai NAMA KATEGORI (customer-facing,
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
          <tr><td class="meta">Pelanggan</td><td>${escapeHtml(invoice.counterparties.name)}</td></tr>
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
        { label: "Pelanggan", value: invoice.counterparties.name },
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
    // Penggantian Barang (replacement type=INBOUND) wajib ada goods_issue di invoice ini --
    // create_replacement nolak kalau invoice-nya financial-only (gak ada barang fisik keluar).
    // Gak ada gunanya ditampilin buat invoice financial-only.
    ...(!isFinancialOnly ? [{ key: "replacements", label: "Penggantian Barang", badge: replacements.length }] : []),
  ];

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/ar-invoices" label="Kembali ke Invoice" />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-black">Detail Invoice</h1>
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
            {isFinancialOnly ? "Tanpa Barang Fisik" : "Ada Barang Fisik"}
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
                      <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700">
                        Pembalikan
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
              <Button variant="toolbar" onClick={() => router.push(`/ar-invoices/${id}/bayar`)}>
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
              <Button variant="toolbar" onClick={() => router.push(`/ar-invoices/${id}/terapkan-dp`)}>
                Terapkan DP
              </Button>
            </div>
          )}
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
                  <th className="px-4 py-2">Rujukan Dokumen</th>
                  <th className="px-4 py-2">Dari Uang Muka</th>
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
                <Button variant="toolbar" onClick={() => router.push(`/ar-invoices/${id}/tukar-barang`)}>
                  Ganti Barang
                </Button>
              )}
              {canRetur && (
                <Button variant="toolbar" onClick={() => router.push(`/ar-invoices/${id}/retur`)}>
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
                  <th className="px-4 py-2">Rujukan Dokumen</th>
                  <th className="px-4 py-2">Jalur</th>
                  <th className="px-4 py-2">Item Diretur</th>
                  <th className="px-4 py-2 text-right">Nominal</th>
                </tr>
              </thead>
              <tbody>
                {creditNotes.map((cn) => {
                  const hasStockReturn = cn.return_lines.length > 0;
                  return (
                    <tr key={cn.id} className="border-b border-slate-100 align-top hover:bg-slate-50">
                      <td className="whitespace-nowrap px-4 py-2">{cn.credit_note_date}</td>
                      <td className="px-4 py-2">{cn.source_ref}</td>
                      <td className="px-4 py-2">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs ${
                            hasStockReturn ? "bg-blue-50 text-blue-700" : "bg-slate-100 text-slate-600"
                          }`}
                        >
                          {hasStockReturn ? "Ada Barang Fisik (stok+HPP)" : "Tanpa Barang Fisik"}
                        </span>
                      </td>
                      <td className="px-4 py-2">
                        {hasStockReturn ? (
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

          {invoiceReturnCredits.length > 0 && (
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
              <div className="border-b border-slate-100 px-4 py-2">
                <span className="text-sm font-medium text-black">Saldo Kredit Retur Pelanggan</span>
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
                        <td className="px-4 py-2">{rc.ar_returns.source_ref}</td>
                        <td className="px-4 py-2 text-right font-mono">{rc.amount.toLocaleString("id-ID")}</td>
                        <td className="px-4 py-2 text-right font-mono">{used.toLocaleString("id-ID")}</td>
                        <td className="px-4 py-2 text-right font-mono font-medium">
                          {remaining.toLocaleString("id-ID")}
                        </td>
                        <td className="px-4 py-2 text-right">
                          {canWrite && remaining > 0.005 && (
                            <Button
                              variant="toolbar"
                              onClick={() => router.push(`/ar-invoices/${id}/refund-kredit/${rc.id}`)}
                            >
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
                <th className="px-4 py-2">Rujukan Dokumen</th>
                <th className="px-4 py-2">Item Diganti</th>
                <th className="px-4 py-2 text-right">Biaya</th>
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
                    {r.replacement_lines
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
    </div>
  );
}
