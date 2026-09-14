"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { DetailRows } from "@/components/ui/detail-rows";
import { Tabs, type TabDef } from "@/components/ui/tabs";
import { LoadingScreen } from "@/components/ui/loading-screen";

type JournalEntryDetail = {
  id: string;
  entry_date: string;
  description: string | null;
  source_ref: string;
  journal_lines: { id: string; debit: number; credit: number; accounts: { code: string; name: string } }[];
};

type SaleLine = { id: string; itemName: string; uom: string; qty: number; unitPrice: number; lineAmount: number };

type CategoryLine = { id: string; accountName: string; amount: number; isTax: boolean };

// Sejak migration pos-sales-simplify: pos_sales/pos_sale_lines/pos_sale_extra_credit_lines
// DIHAPUS TOTAL -- gak ada lagi tabel penanda. goods_issue/payment dicari LANGSUNG lewat
// FK yang udah ada (goods_issues.invoice_id, payments.transaction_id), pola sama
// void_pos_transaction. Item dari goods_issue_lines (qty_issued+unit_price baru), kategori
// tambahan+PPN dari transaction_lines -- baris basket item dikeluarkan dari tab "Kategori"
// lewat MEMBERSHIP ke charge_categories (module 'pos'), bukan amount-matching, pola sama
// ar-invoices/[id]/view.tsx (chargeLabelByAccountId).
type PosSaleDetail = {
  id: string; // = transaction_id, dipakai buat void_pos_transaction
  saleDate: string;
  sourceRef: string;
  customerName: string | null;
  cashAccountName: string | null;
  isCancelled: boolean;
  total: number;
  totalCost: number;
  lines: SaleLine[];
  categoryLines: CategoryLine[];
  journalEntries: JournalEntryDetail[];
};

async function loadDetail(id: string): Promise<PosSaleDetail | null> {
  const { data: t, error: tErr } = await supabase
    .from("transactions")
    .select("id, date, source_ref, journal_entry_id, amount, status, counterparties(name)")
    .eq("id", id)
    .eq("type", "OUTBOUND")
    .maybeSingle();
  if (tErr) throw new Error(tErr.message);
  if (!t) return null;
  const transaction = t as unknown as {
    id: string;
    date: string;
    source_ref: string;
    journal_entry_id: string;
    amount: number;
    status: string;
    counterparties: { name: string } | null;
  };

  const [{ data: gi, error: giErr }, { data: pay, error: payErr }] = await Promise.all([
    supabase
      .from("goods_notes")
      .select("id, journal_entry_id, goods_note_lines(id, qty, unit_price, total_cost, items(name, uom))")
      .eq("transaction_id", id)
      .eq("type", "OUTBOUND")
      .maybeSingle(),
    supabase.from("payments").select("id, journal_entry_id").eq("transaction_id", id).eq("type", "OUTBOUND").maybeSingle(),
  ]);
  if (giErr) throw new Error(giErr.message);
  if (payErr) throw new Error(payErr.message);
  if (!gi) return null;

  const goodsIssue = gi as unknown as {
    id: string;
    journal_entry_id: string;
    goods_note_lines: { id: string; qty: number; unit_price: number | null; total_cost: number; items: { name: string; uom: string } | null }[];
  };
  const payment = pay as unknown as { id: string; journal_entry_id: string } | null;

  const journalEntryIds = [transaction.journal_entry_id, goodsIssue.journal_entry_id];
  if (payment) journalEntryIds.push(payment.journal_entry_id);

  const [{ data: categoryLinesRaw }, { data: chargeTypes }, { data: cashDebitLine }, { data: entries }] = await Promise.all([
    supabase.from("transaction_lines").select("id, account_id, amount, is_tax, accounts(name)").eq("transaction_id", id),
    supabase.from("charge_categories").select("account_id").eq("module", "pos"),
    payment
      ? supabase.from("journal_lines").select("account_id, accounts(name)").eq("journal_entry_id", payment.journal_entry_id).gt("debit", 0).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("journal_entries")
      .select("id, entry_date, description, source_ref, journal_lines(id, debit, credit, accounts(code, name))")
      .in("id", journalEntryIds)
      .order("entry_date"),
  ]);

  type CategoryLineRow = { id: string; account_id: string; amount: number; is_tax: boolean; accounts: { name: string } | null };

  const chargeAccountIds = new Set(((chargeTypes ?? []) as { account_id: string }[]).map((c) => c.account_id));

  const lines: SaleLine[] = goodsIssue.goods_note_lines.map((l) => ({
    id: l.id,
    itemName: l.items?.name ?? "-",
    uom: l.items?.uom ?? "",
    qty: l.qty,
    unitPrice: l.unit_price ?? 0,
    lineAmount: (l.unit_price ?? 0) * l.qty,
  }));

  return {
    id: transaction.id,
    saleDate: transaction.date,
    sourceRef: transaction.source_ref,
    customerName: transaction.counterparties?.name ?? null,
    cashAccountName: (cashDebitLine as unknown as { accounts: { name: string } | null } | null)?.accounts?.name ?? null,
    isCancelled: transaction.status === "dibatalkan",
    total: transaction.amount,
    totalCost: goodsIssue.goods_note_lines.reduce((sum, l) => sum + l.total_cost, 0),
    lines,
    categoryLines: ((categoryLinesRaw ?? []) as unknown as CategoryLineRow[])
      .filter((l) => l.is_tax || chargeAccountIds.has(l.account_id))
      .map((l) => ({
        id: l.id,
        accountName: l.accounts?.name ?? "-",
        amount: l.amount,
        isTax: l.is_tax,
      })),
    journalEntries: (entries ?? []) as unknown as JournalEntryDetail[],
  };
}

export function PosSaleDetailView({ id }: { id: string }) {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [sale, setSale] = useState<PosSaleDetail | null>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [activeTab, setActiveTab] = useState("lines");

  const load = useCallback(async () => {
    try {
      const detail = await loadDetail(id);
      if (!detail) {
        setLoadError("POS sale gak ditemukan.");
        setSale(null);
        return;
      }
      setSale(detail);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Gagal memuat POS sale.");
    }
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

  async function handleVoid() {
    if (!sale) return;
    if (!window.confirm(`Batalkan transaksi POS ${sale.sourceRef}?`)) return;

    setCancelError(null);
    setCancelling(true);
    let ref: string;
    try {
      ref = await generateDocumentNumber("journal_entries");
    } catch (err) {
      setCancelling(false);
      setCancelError(err instanceof Error ? err.message : "Gagal generate nomor dokumen");
      return;
    }
    const { error } = await supabase.rpc("void_pos_transaction", {
      p_transaction_id: sale.id,
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
    return <LoadingScreen />;
  }

  if (!sale) {
    return <FormError>{loadError ?? "POS sale gak ditemukan."}</FormError>;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");
  const canVoid = canWrite && !sale.isCancelled;

  const detailGroups = [
    {
      title: "Informasi Transaksi",
      rows: [
        { label: "Pelanggan", value: sale.customerName ?? "Pelanggan Umum (anonim)" },
        { label: "Rujukan Dokumen", value: sale.sourceRef },
        { label: "Tanggal", value: sale.saleDate },
        { label: "Bayar via", value: sale.cashAccountName ?? "—" },
        {
          label: "Status",
          value: sale.isCancelled ? (
            <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs text-red-700">Dibatalkan</span>
          ) : (
            <span className="rounded-full bg-green-50 px-2 py-0.5 text-xs text-green-700">Normal</span>
          ),
        },
      ],
    },
    {
      title: "Ringkasan",
      rows: [
        { label: "Total", value: sale.total.toLocaleString("id-ID") },
        { label: "Total HPP", value: sale.totalCost.toLocaleString("id-ID") },
      ],
    },
  ];

  const tabs: TabDef[] = [
    { key: "lines", label: "Barang Terjual", badge: sale.lines.length },
    { key: "kategori", label: "Kategori Tambahan & PPN", badge: sale.categoryLines.length },
    { key: "jurnal", label: "Jurnal Terkait", badge: sale.journalEntries.length },
  ];

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/pos-sales" label="Kembali ke Penjualan POS" />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-black">Detail Penjualan POS</h1>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-sm font-mono text-slate-600">
            {sale.sourceRef}
          </span>
        </div>
        {canVoid && (
          <Button variant="toolbar" onClick={handleVoid} disabled={cancelling}>
            {cancelling ? "Membatalkan..." : "Batalkan"}
          </Button>
        )}
      </div>

      {loadError && <FormError>{loadError}</FormError>}
      {cancelError && <FormError>{cancelError}</FormError>}

      <DetailRows groups={detailGroups} />

      <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} />

      {activeTab === "lines" && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
                <th className="px-4 py-2">Item</th>
                <th className="px-4 py-2 text-right">Qty</th>
                <th className="px-4 py-2 text-right">Harga Satuan</th>
                <th className="px-4 py-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {sale.lines.map((l) => (
                <tr key={l.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2">{l.itemName}</td>
                  <td className="px-4 py-2 text-right font-mono">
                    {l.qty} {l.uom}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">{l.unitPrice.toLocaleString("id-ID")}</td>
                  <td className="px-4 py-2 text-right font-mono">{l.lineAmount.toLocaleString("id-ID")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-400">
            HPP per baris gak dipecah per item — lihat Total HPP di Ringkasan.
          </p>
        </div>
      )}

      {activeTab === "kategori" && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
                <th className="px-4 py-2">Akun</th>
                <th className="px-4 py-2 text-right">Nominal</th>
                <th className="px-4 py-2">Keterangan</th>
              </tr>
            </thead>
            <tbody>
              {sale.categoryLines.map((l) => (
                <tr key={l.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2">{l.accountName}</td>
                  <td className="px-4 py-2 text-right font-mono">{l.amount.toLocaleString("id-ID")}</td>
                  <td className="px-4 py-2">{l.isTax ? "PPN Keluaran" : "Biaya tambahan"}</td>
                </tr>
              ))}
              {sale.categoryLines.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-6 text-center text-slate-400">
                    Gak ada kategori tambahan/PPN di transaksi ini.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

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
              {sale.journalEntries.map((entry) => (
                <tr key={entry.id} className="border-b border-slate-100 align-top hover:bg-slate-50">
                  <td className="whitespace-nowrap px-4 py-2">{entry.entry_date}</td>
                  <td className="px-4 py-2">{entry.description}</td>
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
              {sale.journalEntries.length === 0 && (
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
    </div>
  );
}
