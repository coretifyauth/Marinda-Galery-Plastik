"use client";

import { useState, type FormEvent } from "react";
import { supabase } from "@/lib/supabase/client";
import { todayLocal } from "@/lib/dates";
import { Modal } from "@/components/ui/modal";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { MoneyMovedField } from "@/components/payments/cancel-payment-modal";

/** Batalkan Pencairan Tunai saldo retur supplier: jurnal pencairan dibalik, saldo Piutang Retur Supplier kembali. */
export function CancelRefundModal({
  refund,
  onClose,
  onDone,
}: {
  refund: { id: string; source_ref: string; amount: number } | null;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [moneyMoved, setMoneyMoved] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function close() {
    setReason("");
    setMoneyMoved(null);
    setError(null);
    onClose();
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!refund) return;
    if (!reason.trim()) return setError("Alasan wajib diisi");
    if (moneyMoved === null) return setError("Jawab dulu: apakah uangnya benar-benar berpindah?");
    setError(null);
    setSubmitting(true);
    const { error: rpcError } = await supabase.rpc("cancel_return_credit_refund", {
      p_refund_id: refund.id,
      p_entry_date: todayLocal(),
      p_reason: reason,
      p_money_moved: moneyMoved,
    });
    setSubmitting(false);
    if (rpcError) return setError(rpcError.message);
    close();
    await onDone();
  }

  return (
    <Modal open={refund !== null} onClose={close} title={`Batalkan Pencairan ${refund?.source_ref ?? ""}`}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <p className="text-sm text-slate-600">
          Jurnal pencairan Rp{(refund?.amount ?? 0).toLocaleString("id-ID")} dibalik: saldo kas/bank di sistem berkurang dan
          saldo di supplier kembali. Setelah ini retur bisa dibatalkan.
        </p>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="cancel_refund_reason">Alasan</Label>
          <Input
            id="cancel_refund_reason"
            placeholder="mis. Retur salah input, uang yang kembali adalah pengembalian pembayaran tagihan"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <MoneyMovedField
          value={moneyMoved}
          onChange={setMoneyMoved}
          moneyMovedLabel="uangnya sudah masuk dari supplier"
          rerecordText="Catatan kas di sistem akan berbeda dari rekening koran sampai pembayaran tagihan yang dikembalikan itu juga dibatalkan (keduanya saling menutup), atau pencairan yang benar dicatat ulang."
        />
        {error && <FormError>{error}</FormError>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={close}>
            Kembali
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? "Membatalkan..." : "Batalkan Pencairan"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
