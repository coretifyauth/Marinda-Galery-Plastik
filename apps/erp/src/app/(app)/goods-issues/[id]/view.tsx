"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { Button } from "@/components/ui/button";
import { CancelledBadge, CancelledBanner } from "@/components/ui/cancelled";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { DetailRows } from "@/components/ui/detail-rows";
import { Tabs, type TabDef } from "@/components/ui/tabs";
import { LoadingScreen } from "@/components/ui/loading-screen";
import { QtyCell } from "@/components/goods-issues/issue-lines-table";
import { grossMargin as calcGrossMargin, splitInvoiceLines } from "@/lib/goods-issues/margin";

type GoodsIssueDetail = {
  id: string;
  transaction_id: string;
  journal_entry_id: string;
  note_date: string;
  source_ref: string;
  created_at: string;
  ar_invoices: {
    source_ref: string;
    amount: number;
    discount_amount: number;
    status: string;
    counterparties: { name: string };
  };
  goods_note_lines: {
    id: string;
    qty: number;
    total_cost: number;
    unit_price: number | null; // cuma keisi jalur langsung (POS) -- jalur Barang Keluar manual NULL
    discount_amount: number;
    manual_discount_amount: number;
    order_lines: { unit_price: number } | null; // harga dari Sales Order
    items: { name: string; uom: string; item_units: { unit_label: string; conversion_factor: number }[] };
  }[];
};

type InvoiceLine = { id: string; account_id: string; amount: number; is_tax: boolean };
type ReturnRow = {
  id: string;
  amount: number;
  return_lines: { total_cost: number; hpp_reversal_journal_entry_id: string | null }[];
};

const rp = (n: number) => `Rp${n.toLocaleString("id-ID", { maximumFractionDigits: 2 })}`;
const pct = (n: number) => `${n.toLocaleString("id-ID", { maximumFractionDigits: 1 })}%`;

function Hint({ children }: { children: ReactNode }) {
  return <div className="mt-0.5 text-xs text-slate-500">{children}</div>;
}

type JournalEntryDetail = {
  id: string;
  entry_date: string;
  description: string | null;
  source_ref: string;
  journal_lines: { id: string; debit: number; credit: number; accounts: { code: string; name: string } }[];
};

export function GoodsIssueDetailView({ id }: { id: string }) {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [issue, setIssue] = useState<GoodsIssueDetail | null>(null);
  const [journalEntries, setJournalEntries] = useState<JournalEntryDetail[]>([]);
  const [invoiceLines, setInvoiceLines] = useState<InvoiceLine[]>([]);
  const [chargeAccountIds, setChargeAccountIds] = useState<Set<string>>(new Set());
  const [returnRows, setReturnRows] = useState<ReturnRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("jurnal");
  const [roles, setRoles] = useState<string[]>([]);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const load = useCallback(async () => {
    const { data: gi, error: giErr } = await supabase
      .from("goods_notes")
      .select(
        "id, transaction_id, journal_entry_id, note_date, source_ref, created_at, ar_invoices:transactions(source_ref, amount, discount_amount, status, counterparties(name)), goods_note_lines(id, qty, total_cost, unit_price, discount_amount, manual_discount_amount, order_lines(unit_price), items(name, uom, item_units(unit_label, conversion_factor)))"
      )
      .eq("id", id)
      .eq("type", "OUTBOUND")
      .single();
    if (giErr || !gi) {
      setLoadError(giErr?.message ?? "Goods issue gak ditemukan.");
      return;
    }
    const loadedIssue = gi as unknown as GoodsIssueDetail;
    setIssue(loadedIssue);

    const [{ data: entries, error: entriesErr }, { data: tl, error: tlErr }, { data: cc }, { data: rets, error: retsErr }] =
      await Promise.all([
        supabase
          .from("journal_entries")
          .select("id, entry_date, description, source_ref, journal_lines(id, debit, credit, accounts(code, name))")
          .eq("id", loadedIssue.journal_entry_id)
          .order("entry_date"),
        supabase
          .from("transaction_lines")
          .select("id, account_id, amount, is_tax")
          .eq("transaction_id", loadedIssue.transaction_id),
        supabase.from("charge_categories").select("account_id").in("module", ["ar", "pos"]),
        supabase
          .from("returns")
          .select("id, amount, return_lines(total_cost, hpp_reversal_journal_entry_id)")
          .eq("transaction_id", loadedIssue.transaction_id)
          .eq("type", "INBOUND"), // ar_returns: INBOUND = barang balik masuk (konvensi sama ar-invoices)
      ]);

    setJournalEntries((entries ?? []) as unknown as JournalEntryDetail[]);
    setInvoiceLines((tl ?? []) as unknown as InvoiceLine[]);
    setChargeAccountIds(new Set(((cc ?? []) as { account_id: string }[]).map((c) => c.account_id)));
    setReturnRows((rets ?? []) as unknown as ReturnRow[]);
    setLoadError(entriesErr?.message ?? tlErr?.message ?? retsErr?.message ?? null);
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

  // Barang keluar dan invoice-nya dibuat 1 RPC, jadi dibatalkan juga lewat 1 RPC (cancel_ar_invoice):
  // jurnal invoice + HPP dibalik, stok dikembalikan, qty SO dibebaskan.
  async function handleCancel() {
    if (!issue) return;
    if (
      !window.confirm(
        `Batalkan barang keluar ${issue.ar_invoices.source_ref}? Stok barang akan dikembalikan dan invoice (Rp${issue.ar_invoices.amount.toLocaleString("id-ID")}) ikut dibatalkan.`
      )
    )
      return;

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
      p_invoice_id: issue.transaction_id,
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

  if (!issue) {
    return <FormError>{loadError ?? "Goods issue gak ditemukan."}</FormError>;
  }

  const totalHpp = issue.goods_note_lines.reduce((sum, l) => sum + l.total_cost, 0);
  const isCancelled = issue.ar_invoices.status === "dibatalkan";
  const canCancel = !isCancelled && (roles.includes("admin") || roles.includes("accountant"));

  // Pecahan invoice dari transaction_lines. "Biaya tambahan" = baris non-pajak yang akunnya ada di katalog
  // charge_categories (module ar/pos) -- heuristik yang sama dengan cetak invoice. Sisanya = penjualan barang (net diskon).
  const { goodsRevenue, extraCharges, ppn } = splitInvoiceLines(invoiceLines, chargeAccountIds);
  const discount = issue.ar_invoices.discount_amount;
  const grossSales = goodsRevenue + discount;

  const { profit: grossProfit, marginPct: grossMargin } = calcGrossMargin(goodsRevenue, totalHpp);

  const returnAmount = returnRows.reduce((s, r) => s + r.amount, 0);
  const returnHpp = returnRows
    .flatMap((r) => r.return_lines)
    .filter((rl) => rl.hpp_reversal_journal_entry_id)
    .reduce((s, rl) => s + rl.total_cost, 0);
  const hasReturn = returnRows.length > 0;
  const netProfit = grossProfit - returnAmount + returnHpp;

  // Per baris: harga cuma tercatat di jalur POS (unit_price) atau Sales Order (order_lines) -- selain itu NULL.
  const lineRows = issue.goods_note_lines.map((l) => {
    const price = l.unit_price ?? l.order_lines?.unit_price ?? null;
    const lineDiscount = l.discount_amount + l.manual_discount_amount;
    const net = price != null ? Math.max(0, price * l.qty - lineDiscount) : null;
    return { ...l, price, lineDiscount, net, profit: net != null ? net - l.total_cost : null };
  });
  const allPriced = lineRows.length > 0 && lineRows.every((l) => l.net != null);
  const somePriced = lineRows.some((l) => l.net != null);
  const priced = lineRows.filter((l) => l.net != null);
  const pricedRevenue = priced.reduce((s, l) => s + (l.net ?? 0), 0);
  const pricedProfit = priced.reduce((s, l) => s + (l.profit ?? 0), 0);
  // Diskon per baris tersimpan walau harga barisnya tidak (jalur Barang Keluar manual), jadi kolomnya berdiri sendiri.
  const hasDiscount = lineRows.some((l) => l.lineDiscount > 0);
  const totalLineDiscount = lineRows.reduce((s, l) => s + l.lineDiscount, 0);
  // Total qty per satuan (satuan berbeda tidak dijumlahkan jadi satu angka).
  const qtyByUom = new Map<string, number>();
  for (const l of lineRows) qtyByUom.set(l.items.uom, (qtyByUom.get(l.items.uom) ?? 0) + l.qty);
  const totalQtyLabel = [...qtyByUom.entries()].map(([uom, q]) => `${Math.round(q * 1000) / 1000} ${uom}`).join(" · ");
  // Banyak kolom tabel baris (dasar: Item, Qty, HPP/Unit, Total HPP) -- dipakai colSpan.
  const lineColCount = 4 + (somePriced ? 4 : 0) + (hasDiscount ? 1 : 0);

  const detailGroups = [
    {
      title: "Informasi Barang Keluar",
      rows: [
        { label: "Pelanggan", value: issue.ar_invoices.counterparties.name },
        { label: "Rujukan Dokumen", value: issue.source_ref },
        { label: "Tanggal", value: issue.note_date },
        {
          label: "Invoice Terkait",
          value: (
            <button
              type="button"
              className="text-blue-600 hover:underline"
              onClick={() => router.push(`/ar-invoices/${issue.transaction_id}`)}
            >
              {issue.ar_invoices.source_ref}
            </button>
          ),
        },
      ],
    },
    {
      title: "Pendapatan",
      rows: [
        ...(discount > 0
          ? [
              { label: "Penjualan Kotor", value: rp(grossSales) },
              { label: "Diskon", value: `− ${rp(discount)}` },
            ]
          : []),
        {
          label: "Penjualan Barang (bersih)",
          value: (
            <>
              <span className="font-semibold">{rp(goodsRevenue)}</span>
              <Hint>Pendapatan dari barang, setelah diskon, tanpa PPN. Ini yang dipakai menghitung laba.</Hint>
            </>
          ),
        },
        ...(extraCharges > 0
          ? [
              {
                label: "Biaya Tambahan",
                value: (
                  <>
                    {rp(extraCharges)}
                    <Hint>Pendapatan non-barang (mis. ongkir). Tidak ikut dihitung ke laba barang.</Hint>
                  </>
                ),
              },
            ]
          : []),
        ...(ppn > 0
          ? [
              {
                label: "PPN Keluaran",
                value: (
                  <>
                    {rp(ppn)}
                    <Hint>Titipan pajak ke negara, bukan pendapatan.</Hint>
                  </>
                ),
              },
            ]
          : []),
        {
          label: "Total Tagihan Invoice",
          value: (
            <>
              {rp(issue.ar_invoices.amount)}
              <Hint>Yang ditagih ke pelanggan (barang + biaya tambahan + PPN).</Hint>
            </>
          ),
        },
      ],
    },
    {
      title: "HPP & Laba Kotor",
      rows: [
        {
          label: "Total HPP",
          value: (
            <>
              {rp(totalHpp)}
              <Hint>Biaya pokok barang keluar, rata-rata tertimbang saat barang keluar.</Hint>
            </>
          ),
        },
        {
          label: "Laba Kotor",
          value: (
            <span className={`font-semibold ${grossProfit < 0 ? "text-red-600" : "text-emerald-700"}`}>
              {rp(grossProfit)}
              {grossMargin != null && ` (margin ${pct(grossMargin)})`}
            </span>
          ),
        },
        ...(hasReturn
          ? [
              {
                label: "Retur Penjualan",
                value: (
                  <>
                    − {rp(returnAmount)}
                    <Hint>Total nominal retur atas invoice ini (angka yang diinput saat retur, bisa termasuk PPN).</Hint>
                  </>
                ),
              },
              {
                label: "HPP Dikembalikan",
                value: (
                  <>
                    + {rp(returnHpp)}
                    <Hint>HPP barang retur yang jurnalnya sudah dibalik.</Hint>
                  </>
                ),
              },
              {
                label: "Laba Kotor Setelah Retur",
                value: (
                  <span className={`font-semibold ${netProfit < 0 ? "text-red-600" : "text-emerald-700"}`}>
                    {rp(netProfit)}
                  </span>
                ),
              },
            ]
          : []),
      ],
    },
  ];

  const tabs: TabDef[] = [
    { key: "jurnal", label: "Jurnal HPP Terkait", badge: journalEntries.length },
    { key: "lines", label: "Barang Keluar", badge: issue.goods_note_lines.length },
  ];

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/goods-issues" label="Kembali ke Barang Keluar" />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-black">Detail Barang Keluar</h1>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-sm font-mono text-slate-600">
            {issue.source_ref}
          </span>
          {isCancelled && <CancelledBadge />}
        </div>
        {canCancel && (
          <Button variant="toolbar" onClick={handleCancel} disabled={cancelling}>
            {cancelling ? "Membatalkan..." : "Batalkan Barang Keluar"}
          </Button>
        )}
      </div>

      {isCancelled && (
        <CancelledBanner>
          barang keluar ini tidak valid. Stok sudah dikembalikan dan invoice-nya dibatalkan.
        </CancelledBanner>
      )}
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

      {activeTab === "lines" && (
      <div className="flex flex-col gap-2">
      {!allPriced && (
        <p className="text-sm text-slate-500">
          {somePriced
            ? "Sebagian baris tidak punya harga tercatat, jadi pendapatan & laba baris itu tidak bisa dihitung."
            : "Barang keluar ini dibuat langsung (bukan dari Sales Order/POS), jadi harga per baris tidak tersimpan — hanya total penjualan barang di atas yang tercatat. HPP per baris tetap akurat."}
        </p>
      )}
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Item</th>
              <th className="px-4 py-2 text-right">Qty</th>
              {somePriced && <th className="px-4 py-2 text-right">Harga/Unit</th>}
              {hasDiscount && <th className="px-4 py-2 text-right">Diskon</th>}
              {somePriced && <th className="px-4 py-2 text-right">Pendapatan</th>}
              <th className="px-4 py-2 text-right">HPP/Unit</th>
              <th className="px-4 py-2 text-right">Total HPP</th>
              {somePriced && <th className="px-4 py-2 text-right">Laba</th>}
              {somePriced && <th className="px-4 py-2 text-right">Margin</th>}
            </tr>
          </thead>
          <tbody>
            {lineRows.map((l) => (
              <tr key={l.id} className="border-b border-slate-100 hover:bg-slate-50">
                <td className="px-4 py-2">{l.items.name}</td>
                <td className="px-4 py-2 text-right font-mono">
                  <QtyCell line={l} />
                </td>
                {somePriced && (
                  <td className="px-4 py-2 text-right font-mono">{l.price != null ? rp(l.price) : "—"}</td>
                )}
                {hasDiscount && (
                  <td className="px-4 py-2 text-right font-mono">
                    {l.lineDiscount > 0 ? `− ${rp(l.lineDiscount)}` : "0"}
                  </td>
                )}
                {somePriced && (
                  <td className="px-4 py-2 text-right font-mono">{l.net != null ? rp(l.net) : "—"}</td>
                )}
                <td className="px-4 py-2 text-right font-mono">{rp(l.total_cost / l.qty)}</td>
                <td className="px-4 py-2 text-right font-mono">{rp(l.total_cost)}</td>
                {somePriced && (
                  <td
                    className={`px-4 py-2 text-right font-mono ${l.profit != null && l.profit < 0 ? "text-red-600" : ""}`}
                  >
                    {l.profit != null ? rp(l.profit) : "—"}
                  </td>
                )}
                {somePriced && (
                  <td className="px-4 py-2 text-right font-mono">
                    {l.profit != null && l.net ? pct((l.profit / l.net) * 100) : "—"}
                  </td>
                )}
              </tr>
            ))}
            {lineRows.length === 0 && (
              <tr>
                <td colSpan={lineColCount} className="px-4 py-6 text-center text-slate-400">
                  Belum ada baris.
                </td>
              </tr>
            )}
          </tbody>
          {lineRows.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
                <td className="px-4 py-2">Total</td>
                <td className="px-4 py-2 text-right font-mono">{totalQtyLabel}</td>
                {somePriced && <td className="px-4 py-2" />}
                {hasDiscount && (
                  <td className="px-4 py-2 text-right font-mono">{`− ${rp(totalLineDiscount)}`}</td>
                )}
                {somePriced && (
                  <td className="px-4 py-2 text-right font-mono">
                    {rp(pricedRevenue)}
                    {!allPriced && "*"}
                  </td>
                )}
                <td className="px-4 py-2" />
                <td className="px-4 py-2 text-right font-mono">{rp(totalHpp)}</td>
                {somePriced && (
                  <td
                    className={`px-4 py-2 text-right font-mono ${pricedProfit < 0 ? "text-red-600" : ""}`}
                  >
                    {rp(pricedProfit)}
                  </td>
                )}
                {somePriced && (
                  <td className="px-4 py-2 text-right font-mono">
                    {pricedRevenue > 0 ? pct((pricedProfit / pricedRevenue) * 100) : "—"}
                  </td>
                )}
              </tr>
              {somePriced && !allPriced && (
                <tr>
                  <td colSpan={lineColCount} className="px-4 py-2 text-xs font-normal text-slate-500">
                    * Pendapatan dan laba hanya menjumlah baris yang punya harga. Qty, diskon, dan HPP mencakup semua baris.
                  </td>
                </tr>
              )}
            </tfoot>
          )}
        </table>
      </div>
      </div>
      )}
    </div>
  );
}
