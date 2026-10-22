"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { fetchLinesForNotes } from "@/lib/goods-receipts/queries";
import { hasZeroValueLine, receiptNumber, type GoodsReceiptNote } from "@/lib/goods-receipts/types";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { Button } from "@/components/ui/button";
import { CancelledBadge, CancelledBanner } from "@/components/ui/cancelled";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { DetailRows } from "@/components/ui/detail-rows";
import { Tabs, type TabDef } from "@/components/ui/tabs";
import { LoadingScreen } from "@/components/ui/loading-screen";
import { ReceiptLinesTable } from "@/components/goods-receipts/receipt-lines-table";

type JournalEntryDetail = {
  id: string;
  entry_date: string;
  description: string | null;
  source_ref: string;
  journal_lines: { id: string; debit: number; credit: number; accounts: { code: string; name: string } }[];
};

type RevisionRow = {
  id: string;
  revision_no: number;
  entry_date: string;
  delivery_note_ref: string | null;
  created_at: string;
};

export function GoodsReceiptDetailView({ id }: { id: string }) {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [grn, setGrn] = useState<GoodsReceiptNote | null>(null);
  const [journalEntries, setJournalEntries] = useState<JournalEntryDetail[]>([]);
  const [revisions, setRevisions] = useState<RevisionRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("lines");
  const [roles, setRoles] = useState<string[]>([]);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const load = useCallback(async () => {
    const { data: noteData, error: noteErr } = await supabase
      .from("goods_notes_with_billing_status")
      .select("*")
      .eq("id", id)
      .single();
    if (noteErr || !noteData) {
      setLoadError(noteErr?.message ?? "Barang masuk gak ditemukan.");
      return;
    }
    const note = noteData as unknown as Omit<GoodsReceiptNote, "goods_note_lines">;

    const [lines, baseRes, revRes, cancelRes] = await Promise.all([
      fetchLinesForNotes([id]),
      supabase.from("goods_notes").select("journal_entry_id, transaction_id").eq("id", id).single(),
      supabase
        .from("goods_note_revisions")
        .select("id, revision_no, entry_date, delivery_note_ref, reversal_journal_entry_id, journal_entry_id, created_at")
        .eq("goods_note_id", id)
        .order("revision_no"),
      supabase.from("goods_note_cancellations").select("journal_entry_id").eq("goods_note_id", id).maybeSingle(),
    ]);

    setGrn({ ...note, goods_note_lines: lines.get(id) ?? [] });

    const revs = (revRes.data ?? []) as unknown as (RevisionRow & {
      reversal_journal_entry_id: string | null;
      journal_entry_id: string | null;
    })[];
    setRevisions(revs);

    // Jurnal terkait: jurnal barang masuk, jurnal+pembalik tiap revisi, pembalik pembatalan.
    // Barang masuk lama (bundled): jurnalnya ada di tagihan bawaannya.
    const journalIds = new Set<string>();
    const base = baseRes.data as { journal_entry_id: string | null; transaction_id: string | null } | null;
    if (base?.journal_entry_id) journalIds.add(base.journal_entry_id);
    for (const r of revs) {
      if (r.reversal_journal_entry_id) journalIds.add(r.reversal_journal_entry_id);
      if (r.journal_entry_id) journalIds.add(r.journal_entry_id);
    }
    const cancelJournal = (cancelRes.data as { journal_entry_id: string | null } | null)?.journal_entry_id;
    if (cancelJournal) journalIds.add(cancelJournal);
    if (note.inbound_flow === "bundled" && base?.transaction_id) {
      const { data: bill } = await supabase
        .from("transactions")
        .select("journal_entry_id")
        .eq("id", base.transaction_id)
        .single();
      if (bill?.journal_entry_id) journalIds.add(bill.journal_entry_id as string);
    }

    if (journalIds.size > 0) {
      const { data: entries, error: entriesErr } = await supabase
        .from("journal_entries")
        .select("id, entry_date, description, source_ref, journal_lines(id, debit, credit, accounts(code, name))")
        .in("id", [...journalIds])
        .order("entry_date");
      setJournalEntries((entries ?? []) as unknown as JournalEntryDetail[]);
      setLoadError(entriesErr?.message ?? null);
    } else {
      setJournalEntries([]);
      setLoadError(null);
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

  // Barang masuk alur baru: dibatalkan sendiri (cancel_goods_receipt) selama belum ditagih.
  // Barang masuk lama (bundled): dibatalkan lewat tagihan bawaannya (cancel_ap_bill), seperti sebelumnya.
  async function handleCancel() {
    if (!grn) return;
    const deferred = grn.inbound_flow === "deferred";
    const message = deferred
      ? `Batalkan barang masuk ${receiptNumber(grn)}? Stok barang dikurangi lagi dan jurnalnya dibalik.`
      : `Batalkan barang masuk ${receiptNumber(grn)}? Stok barang akan dikurangi lagi dan tagihan (Rp${(grn.bill_amount ?? 0).toLocaleString("id-ID")}) ikut dibatalkan.`;
    if (!window.confirm(message)) return;

    setCancelError(null);
    setCancelling(true);
    const today = new Date().toISOString().slice(0, 10);
    let error: { message: string } | null;
    if (deferred) {
      ({ error } = await supabase.rpc("cancel_goods_receipt", { p_goods_note_id: grn.id, p_entry_date: today }));
    } else {
      let sourceRef: string;
      try {
        sourceRef = await generateDocumentNumber("journal_entries");
      } catch (err) {
        setCancelling(false);
        setCancelError(err instanceof Error ? err.message : "Gagal generate nomor dokumen");
        return;
      }
      ({ error } = await supabase.rpc("cancel_ap_bill", {
        p_bill_id: grn.bill_id,
        p_entry_date: today,
        p_source_ref: sourceRef,
      }));
    }
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

  if (!grn) {
    return <FormError>{loadError ?? "Barang masuk gak ditemukan."}</FormError>;
  }

  const isCancelled = grn.billing_status === "dibatalkan";
  const isUnbilled = grn.billing_status === "belum_tertagih";
  const canWrite = roles.includes("admin") || roles.includes("accountant");
  const canCancel = canWrite && !isCancelled && (grn.inbound_flow === "bundled" || isUnbilled);

  const detailGroups = [
    {
      title: "Informasi Penerimaan",
      rows: [
        { label: "Tanggal Terima", value: grn.note_date },
        { label: "No. Surat Jalan", value: grn.delivery_note_ref ?? "-" },
        {
          label: "Purchase Order",
          value: grn.order_ref ? (
            <button
              type="button"
              className="text-blue-600 hover:underline"
              onClick={() => router.push(`/purchase-orders/${grn.order_id}`)}
            >
              {grn.order_ref}
            </button>
          ) : (
            <span className="text-slate-400">— (langsung tanpa PO)</span>
          ),
        },
        { label: "Supplier", value: grn.supplier_name ?? "-" },
        { label: "Nilai Barang Masuk", value: `Rp${grn.total_value.toLocaleString("id-ID")}` },
        {
          label: "Tagihan",
          value:
            grn.bill_id && grn.billing_status !== "belum_tertagih" ? (
              <button
                type="button"
                className="text-blue-600 hover:underline"
                onClick={() => router.push(`/ap-bills/${grn.bill_id}`)}
              >
                {grn.bill_ref} — {(grn.bill_amount ?? 0).toLocaleString("id-ID")}
              </button>
            ) : (
              <span className="text-slate-400">Belum ditagih</span>
            ),
        },
      ],
    },
  ];

  const tabs: TabDef[] = [
    { key: "lines", label: "Item Diterima", badge: grn.goods_note_lines.length },
    { key: "jurnal", label: "Jurnal", badge: journalEntries.length },
    ...(revisions.length > 0 ? [{ key: "revisi", label: "Riwayat Revisi", badge: revisions.length }] : []),
  ];

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/goods-receipts" label="Kembali ke Barang Masuk" />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-black">Detail Barang Masuk</h1>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-sm font-mono text-slate-600">
            {receiptNumber(grn)}
          </span>
          {isCancelled && <CancelledBadge />}
          {isUnbilled && (
            <span className="rounded-full bg-red-100 px-2.5 py-1 text-sm font-medium text-red-700">
              Belum tertagih{grn.unbilled_age_days != null && ` · ${grn.unbilled_age_days} hari`}
            </span>
          )}
          {grn.billing_status === "tertagih" && (
            <span className="rounded-full bg-green-50 px-2.5 py-1 text-sm text-green-700">Tertagih</span>
          )}
          {!isCancelled && hasZeroValueLine(grn) && (
            <span className="rounded-full bg-amber-50 px-2.5 py-1 text-sm text-amber-700">Ada baris berharga 0</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {canWrite && isUnbilled && grn.inbound_flow === "deferred" && (
            <>
              <Button variant="toolbar" onClick={() => router.push(`/goods-receipts/${id}/revisi`)}>
                Revisi Harga / Diskon
              </Button>
              <Button
                variant="toolbar-primary"
                onClick={() =>
                  router.push(`/ap-bills/from-goods-receipts?supplier=${grn.counterparty_id ?? ""}&note=${id}`)
                }
              >
                Buat Tagihan
              </Button>
            </>
          )}
          {canCancel && (
            <Button variant="toolbar" onClick={handleCancel} disabled={cancelling}>
              {cancelling ? "Membatalkan..." : "Batalkan Barang Masuk"}
            </Button>
          )}
        </div>
      </div>

      {isCancelled && (
        <CancelledBanner>
          barang masuk ini tidak valid. Stok sudah dikurangi lagi
          {grn.inbound_flow === "bundled" ? " dan tagihannya dibatalkan." : " dan jurnalnya dibalik."}
        </CancelledBanner>
      )}
      {loadError && <FormError>{loadError}</FormError>}
      {cancelError && <FormError>{cancelError}</FormError>}

      <DetailRows groups={detailGroups} />

      <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} />

      {activeTab === "lines" && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <ReceiptLinesTable
            lines={grn.goods_note_lines}
            variant="detail"
            billAmount={grn.inbound_flow === "bundled" ? (grn.bill_amount ?? undefined) : undefined}
          />
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
                    Belum ada jurnal{hasZeroValueLine(grn) ? " (nilai barang masuk 0, jurnal dibuat setelah diberi harga)" : ""}.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === "revisi" && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
                <th className="px-4 py-2">Revisi</th>
                <th className="px-4 py-2">Tanggal</th>
                <th className="px-4 py-2">No. Surat Jalan</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-slate-100">
                <td className="px-4 py-2">1 (asli)</td>
                <td className="whitespace-nowrap px-4 py-2">{grn.note_date}</td>
                <td className="px-4 py-2 text-slate-400">—</td>
              </tr>
              {revisions.map((r) => (
                <tr key={r.id} className="border-b border-slate-100">
                  <td className="px-4 py-2">{r.revision_no}</td>
                  <td className="whitespace-nowrap px-4 py-2">{r.entry_date}</td>
                  <td className="px-4 py-2">{r.delivery_note_ref ?? <span className="text-slate-400">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
