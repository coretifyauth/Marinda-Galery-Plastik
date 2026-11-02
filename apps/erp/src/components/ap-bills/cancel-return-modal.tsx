"use client";

import { useState, type FormEvent } from "react";
import { supabase } from "@/lib/supabase/client";
import { todayLocal } from "@/lib/dates";
import { Modal } from "@/components/ui/modal";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";

/** Batalkan Retur ke supplier (Opsi A): jurnal retur dibalik, stok kembali, saldo Piutang Retur Supplier ikut dibalik. */
export function CancelReturnModal({
  ret,
  onClose,
  onDone,
}: {
  ret: { id: string; source_ref: string; amount: number; hasStock: boolean; hasCredit: boolean } | null;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function close() {
    setReason("");
    setError(null);
    onClose();
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!ret) return;
    if (!reason.trim()) return setError("Alasan wajib diisi");
    setError(null);
    setSubmitting(true);
    const { error: rpcError } = await supabase.rpc("cancel_ap_return", {
      p_return_id: ret.id,
      p_entry_date: todayLocal(),
      p_reason: reason,
    });
    setSubmitting(false);
    if (rpcError) return setError(rpcError.message);
    close();
    await onDone();
  }

  return (
    <Modal open={ret !== null} onClose={close} title={`Batalkan Retur ${ret?.source_ref ?? ""}`}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1 text-sm text-slate-600">
          <p>Retur Rp{(ret?.amount ?? 0).toLocaleString("id-ID")} dianggap tidak pernah terjadi. Yang ikut berubah:</p>
          <ul className="list-disc pl-5">
            <li>Jurnal retur dibalik, nilainya kembali jadi sisa tagihan.</li>
            {ret?.hasStock && <li>Stok barang yang diretur kembali bertambah, pada nilai yang sama dengan saat keluar.</li>}
            {ret?.hasCredit && <li>Saldo di supplier (kelebihan retur) dari retur ini ikut dibalik.</li>}
          </ul>
          <p>Dokumen retur tetap tersimpan sebagai riwayat dengan tanda dibatalkan.</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="cancel_return_reason">Alasan</Label>
          <Input
            id="cancel_return_reason"
            placeholder="mis. Salah input nama item, bukan barang yang dikembalikan"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        {error && <FormError>{error}</FormError>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={close}>
            Kembali
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? "Membatalkan..." : "Batalkan Retur"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
