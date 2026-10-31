"use client";

import { useState, type FormEvent } from "react";
import { supabase } from "@/lib/supabase/client";
import { todayLocal } from "@/lib/dates";
import { Modal } from "@/components/ui/modal";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";

/** Pertanyaan yang sama dipakai Batalkan Pembayaran dan Batalkan Tagihan: pembatalan cuma membalik catatan, bukan uangnya. */
export function MoneyMovedField({
  value,
  onChange,
  moneyMovedLabel,
}: {
  value: boolean | null;
  onChange: (value: boolean) => void;
  moneyMovedLabel: string;
}) {
  return (
    <fieldset className="flex flex-col gap-2 text-sm text-slate-700">
      <legend className="mb-1 font-medium text-black">Apakah uangnya benar-benar berpindah?</legend>
      <label className="flex items-start gap-2">
        <input type="radio" className="mt-1" checked={value === true} onChange={() => onChange(true)} />
        <span>Ya, {moneyMovedLabel}. Setelah ini wajib catat ulang pembayaran yang benar supaya saldo kas/bank cocok.</span>
      </label>
      <label className="flex items-start gap-2">
        <input type="radio" className="mt-1" checked={value === false} onChange={() => onChange(false)} />
        <span>Tidak, uangnya tidak pernah berpindah. Cuma salah catat.</span>
      </label>
    </fieldset>
  );
}

export function CancelPaymentModal({
  payment,
  moneyMovedLabel,
  onClose,
  onDone,
}: {
  payment: { id: string; source_ref: string; amount: number } | null;
  moneyMovedLabel: string;
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
    if (!payment) return;
    if (!reason.trim()) return setError("Alasan wajib diisi");
    if (moneyMoved === null) return setError("Jawab dulu: apakah uangnya benar-benar berpindah?");
    setError(null);
    setSubmitting(true);
    const { error: rpcError } = await supabase.rpc("cancel_payment", {
      p_payment_id: payment.id,
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
    <Modal open={payment !== null} onClose={close} title={`Batalkan Pembayaran ${payment?.source_ref ?? ""}`}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <p className="text-sm text-slate-600">
          Jurnal pembayaran Rp{(payment?.amount ?? 0).toLocaleString("id-ID")} dibalik dan nilainya kembali jadi sisa
          tagihan. Catatan lama tetap tersimpan sebagai riwayat.
        </p>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="cancel_payment_reason">Alasan</Label>
          <Input
            id="cancel_payment_reason"
            placeholder="mis. Salah pilih tagihan, seharusnya untuk nota SP-0452"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <MoneyMovedField value={moneyMoved} onChange={setMoneyMoved} moneyMovedLabel={moneyMovedLabel} />
        {error && <FormError>{error}</FormError>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={close}>
            Kembali
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? "Membatalkan..." : "Batalkan Pembayaran"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
