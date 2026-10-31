"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import { fetchLinesForNotes } from "@/lib/goods-receipts/queries";
import { receiptNumber, type GoodsReceiptNote } from "@/lib/goods-receipts/types";
import { todayLocal } from "@/lib/dates";
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

type RevisionLink = {
  old_goods_note_id: string;
  new_goods_note_id: string;
  reason: string;
  cogs_adjustment: number;
  cogs_journal_entry_id: string | null;
  old_note: { source_ref: string | null };
  new_note: { source_ref: string | null };
};

export function GoodsReceiptDetailView({ id }: { id: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [checkingSession, setCheckingSession] = useState(true);
  const [grn, setGrn] = useState<GoodsReceiptNote | null>(null);
  const [journalEntries, setJournalEntries] = useState<JournalEntryDetail[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("lines");
  const [roles, setRoles] = useState<string[]>([]);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [revision, setRevision] = useState<RevisionLink | null>(null);

  const load = useCallback(async () => {
    const { data: noteData, error: noteErr } = await supabase
      .from("goods_receipts_overview")
      .select("*")
      .eq("id", id)
      .single();
    if (noteErr || !noteData) {
      setLoadError(noteErr?.message ?? "Barang masuk gak ditemukan.");
      return;
    }
    const note = noteData as unknown as Omit<GoodsReceiptNote, "goods_note_lines">;

    const [lines, baseRes, cancelRes, revisionRes] = await Promise.all([
      fetchLinesForNotes([id]),
      supabase.from("goods_notes").select("journal_entry_id, transaction_id").eq("id", id).single(),
      supabase.from("goods_note_cancellations").select("journal_entry_id").eq("goods_note_id", id).maybeSingle(),
      supabase
        .from("goods_receipt_revisions")
        .select(
          "old_goods_note_id, new_goods_note_id, reason, cogs_adjustment, cogs_journal_entry_id, old_note:goods_notes!old_goods_note_id(source_ref), new_note:goods_notes!new_goods_note_id(source_ref)"
        )
        .or(`old_goods_note_id.eq.${id},new_goods_note_id.eq.${id}`)
        .maybeSingle(),
    ]);

    setGrn({ ...note, goods_note_lines: lines.get(id) ?? [] });
    const revisionRow = (revisionRes.data ?? null) as unknown as RevisionLink | null;
    setRevision(revisionRow);

    // Jurnal terkait: jurnal barang masuk + pembalik pembatalan. Barang masuk lama: jurnalnya ada di tagihan bawaannya.
    const journalIds = new Set<string>();
    const base = baseRes.data as { journal_entry_id: string | null; transaction_id: string | null } | null;
    if (base?.journal_entry_id) journalIds.add(base.journal_entry_id);
    const cancelJournal = (cancelRes.data as { journal_entry_id: string | null } | null)?.journal_entry_id;
    if (cancelJournal) journalIds.add(cancelJournal);
    if (revisionRow?.new_goods_note_id === id && revisionRow.cogs_journal_entry_id) journalIds.add(revisionRow.cogs_journal_entry_id);
    if (note.is_legacy && base?.transaction_id) {
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

  // Barang masuk baru: dibatalkan sendiri (cancel_goods_receipt) -- kolam tagihannya kembali. Barang masuk lama (dibuat bareng
  // tagihannya) dibatalkan dari tagihannya, yang juga mengurus pembayaran.
  async function handleCancel() {
    if (!grn) return;
    if (!window.confirm(`Batalkan barang masuk ${receiptNumber(grn)}? Stok barang dikurangi lagi, jurnalnya dibalik, dan nilainya kembali ke barang yang belum diterima dari tagihan ${grn.bill_ref ?? ""}.`)) return;

    setCancelError(null);
    setCancelling(true);
    const { error } = await supabase.rpc("cancel_goods_receipt", { p_goods_note_id: grn.id, p_entry_date: todayLocal() });
    setCancelling(false);
    if (error) {
      setCancelError(error.message);
      return;
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["goods_receipt_notes"] }),
      queryClient.invalidateQueries({ queryKey: ["open_pool_bills"] }),
      queryClient.invalidateQueries({ queryKey: ["ap_bill_pool"] }),
      queryClient.invalidateQueries({ queryKey: ["ap_bills"] }),
    ]);
    await load();
  }

  if (checkingSession) {
    return <LoadingScreen />;
  }

  if (!grn) {
    return <FormError>{loadError ?? "Barang masuk gak ditemukan."}</FormError>;
  }

  const isCancelled = grn.status === "dibatalkan";
  const canWrite = roles.includes("admin") || roles.includes("accountant");
  // Riwayat alur lama yang sudah dibatalkan gak punya tagihan; selain itu bisa dikoreksi/dibatalkan kalau masih aktif.
  const canAct = canWrite && !isCancelled && !!grn.bill_id;

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
          value: grn.bill_id ? (
            <button
              type="button"
              className="text-blue-600 hover:underline"
              onClick={() => router.push(`/ap-bills/${grn.bill_id}`)}
            >
              {grn.bill_ref} — Rp{(grn.bill_amount ?? 0).toLocaleString("id-ID")}
            </button>
          ) : (
            <span className="text-slate-400">— (riwayat alur lama, tanpa tagihan)</span>
          ),
        },
      ],
    },
  ];

  const tabs: TabDef[] = [
    { key: "lines", label: "Item Diterima", badge: grn.goods_note_lines.length },
    { key: "jurnal", label: "Jurnal", badge: journalEntries.length },
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
          {isCancelled ? (
            <CancelledBadge />
          ) : (
            <span className="rounded-full bg-green-50 px-2.5 py-1 text-sm text-green-700">Aktif</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {canAct && grn.is_legacy && (
            <Button variant="toolbar" onClick={() => router.push(`/ap-bills/${grn.bill_id}`)}>
              Batalkan dari Tagihan
            </Button>
          )}
          {canAct && !grn.is_legacy && (
            <>
              <Button variant="toolbar" onClick={() => router.push(`/goods-receipts/${grn.id}/koreksi`)}>
                Koreksi Barang Masuk
              </Button>
              <Button variant="toolbar" onClick={handleCancel} disabled={cancelling}>
                {cancelling ? "Membatalkan..." : "Batalkan Barang Masuk"}
              </Button>
            </>
          )}
        </div>
      </div>

      {isCancelled && (
        <CancelledBanner>
          barang masuk ini tidak valid. Stok sudah dikurangi lagi
          {grn.is_legacy ? " dan tagihannya dibatalkan." : " dan jurnalnya dibalik; nilainya kembali ke barang yang belum diterima dari tagihan."}
        </CancelledBanner>
      )}
      {revision && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
          {revision.old_goods_note_id === grn.id ? (
            <>
              Dokumen ini dikoreksi menjadi{" "}
              <button type="button" className="font-medium underline" onClick={() => router.push(`/goods-receipts/${revision.new_goods_note_id}`)}>
                {revision.new_note.source_ref}
              </button>
              .
            </>
          ) : (
            <>
              Dokumen ini hasil koreksi dari{" "}
              <button type="button" className="font-medium underline" onClick={() => router.push(`/goods-receipts/${revision.old_goods_note_id}`)}>
                {revision.old_note.source_ref}
              </button>
              .
              {revision.cogs_adjustment !== 0 && (
                <> Selisih atas barang yang sudah terjual: HPP {revision.cogs_adjustment > 0 ? "naik" : "turun"} Rp{Math.abs(revision.cogs_adjustment).toLocaleString("id-ID")}.</>
              )}
            </>
          )}{" "}
          Alasan: {revision.reason}
        </div>
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
            billAmount={grn.is_legacy ? (grn.bill_amount ?? undefined) : undefined}
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
