"use client";

import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import { todayLocal } from "@/lib/dates";
import { Modal } from "@/components/ui/modal";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { MoneyMovedField } from "@/components/payments/cancel-payment-modal";

type Preview = {
  bill_ref: string;
  amount: number;
  goods_receipts: { id: string; source_ref: string; total_value: number }[];
  legacy_goods_receipts: number;
  payments: { id: string; source_ref: string; amount: number; payment_date: string }[];
  deposit_applications: { source_ref: string; amount: number }[];
  adjustments: { source_ref: string; amount: number }[];
  blockers: string[];
};

const rp = (n: number) => `Rp${n.toLocaleString("id-ID", { maximumFractionDigits: 2 })}`;

/**
 * Batalkan Tagihan: menampilkan semua yang ikut dibatalkan (barang masuk, pembayaran, uang muka, koreksi) lalu menjalankannya
 * sekaligus lewat cancel_ap_bill_cascade. Kalau ada penghalang, modal menjelaskan alasannya dan jalan keluarnya.
 */
export function CancelBillModal({
  billId,
  open,
  onClose,
  onDone,
}: {
  billId: string;
  open: boolean;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const queryClient = useQueryClient();
  const previewQuery = useQuery({
    queryKey: ["ap_bill_cancellation_preview", billId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("ap_bill_cancellation_preview", { p_bill_id: billId });
      if (error) throw new Error(error.message);
      return data as Preview;
    },
    enabled: open,
    gcTime: 0,
    staleTime: 0,
  });
  const [reason, setReason] = useState("");
  const [moneyMoved, setMoneyMoved] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const preview = previewQuery.data;
  const hasPayments = (preview?.payments.length ?? 0) > 0;
  const blocked = (preview?.blockers.length ?? 0) > 0;

  function close() {
    setReason("");
    setMoneyMoved(null);
    setError(null);
    onClose();
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!reason.trim()) return setError("Alasan wajib diisi");
    if (hasPayments && moneyMoved === null) return setError("Jawab dulu: apakah uangnya benar-benar berpindah?");
    setError(null);
    setSubmitting(true);
    const { error: rpcError } = await supabase.rpc("cancel_ap_bill_cascade", {
      p_bill_id: billId,
      p_entry_date: todayLocal(),
      p_reason: reason,
      p_money_moved: moneyMoved,
    });
    setSubmitting(false);
    if (rpcError) return setError(rpcError.message);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["goods_receipt_notes"] }),
      queryClient.invalidateQueries({ queryKey: ["open_pool_bills"] }),
      queryClient.invalidateQueries({ queryKey: ["ap_bill_pool", billId] }),
      queryClient.invalidateQueries({ queryKey: ["ap_bills"] }),
    ]);
    close();
    await onDone();
  }

  return (
    <Modal open={open} onClose={close} title={`Batalkan Tagihan ${preview?.bill_ref ?? ""}`} maxWidth="max-w-xl">
      {previewQuery.isLoading && <p className="text-sm text-slate-500">Memeriksa tagihan...</p>}
      {previewQuery.error && <FormError>{(previewQuery.error as Error).message}</FormError>}
      {preview && (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {blocked ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <p className="mb-1 font-medium">Tagihan ini belum bisa dibatalkan:</p>
              <ul className="list-disc space-y-1 pl-4">
                {preview.blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </div>
          ) : (
            <>
              <div className="text-sm text-slate-700">
                <p className="mb-2">Yang akan dibatalkan, dengan jurnal pembalik di tanggal hari ini:</p>
                <ul className="list-disc space-y-1 pl-4">
                  {preview.goods_receipts.map((g) => (
                    <li key={g.id}>
                      Barang masuk {g.source_ref} ({rp(g.total_value)}), stok berkurang lagi
                    </li>
                  ))}
                  {preview.legacy_goods_receipts > 0 && <li>Barang masuk bawaan tagihan ini, stok berkurang lagi</li>}
                  {preview.payments.map((p) => (
                    <li key={p.id}>
                      Pembayaran {p.source_ref} ({rp(p.amount)})
                    </li>
                  ))}
                  {preview.deposit_applications.map((d) => (
                    <li key={d.source_ref}>
                      Penerapan uang muka {d.source_ref} ({rp(d.amount)}), uang mukanya bisa dipakai lagi
                    </li>
                  ))}
                  {preview.adjustments.map((a) => (
                    <li key={a.source_ref}>
                      Koreksi tagihan {a.source_ref} ({rp(a.amount)})
                    </li>
                  ))}
                  <li>Tagihan {preview.bill_ref} ({rp(preview.amount)})</li>
                </ul>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cancel_bill_reason">Alasan</Label>
                <Input
                  id="cancel_bill_reason"
                  placeholder="mis. Salah supplier, nota dicatat ulang"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>
              {hasPayments && (
                <MoneyMovedField value={moneyMoved} onChange={setMoneyMoved} moneyMovedLabel="uangnya sudah keluar ke supplier" />
              )}
            </>
          )}
          {error && <FormError>{error}</FormError>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={close}>
              Kembali
            </Button>
            {!blocked && (
              <Button type="submit" disabled={submitting}>
                {submitting ? "Membatalkan..." : "Batalkan Semua"}
              </Button>
            )}
          </div>
        </form>
      )}
    </Modal>
  );
}
