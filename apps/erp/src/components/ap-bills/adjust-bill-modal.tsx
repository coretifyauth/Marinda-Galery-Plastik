"use client";

import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import { todayLocal } from "@/lib/dates";
import { Modal } from "@/components/ui/modal";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";

const rp = (n: number) => `Rp${n.toLocaleString("id-ID", { maximumFractionDigits: 2 })}`;

type Direction = "turun" | "naik";

/**
 * Koreksi Tagihan (nota kredit/debit supplier): menurunkan atau menaikkan utang dan barang yang belum diterima sekaligus.
 * Batas penurunan mirror adjust_ap_bill: gak boleh melebihi barang yang belum diterima maupun sisa utang.
 */
export function AdjustBillModal({
  billId,
  open,
  remainingGoods,
  outstanding,
  onClose,
  onDone,
}: {
  billId: string;
  open: boolean;
  remainingGoods: number;
  outstanding: number;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const queryClient = useQueryClient();
  const [direction, setDirection] = useState<Direction>("turun");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(todayLocal);
  const [reason, setReason] = useState("");
  const [documentRef, setDocumentRef] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const maxDown = Math.max(0, Math.min(remainingGoods, outstanding));

  function close() {
    setAmount("");
    setReason("");
    setDocumentRef("");
    setError(null);
    onClose();
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const value = parseFloat(amount);
    if (!(value > 0)) return setError("Nominal harus lebih dari 0");
    if (direction === "turun" && value > maxDown + 0.005) {
      return setError(`Penurunan maksimal ${rp(maxDown)}. Bagian yang sudah dibayar keluar lewat Tutup Sisa Barang jadi uang muka.`);
    }
    if (!date) return setError("Tanggal wajib diisi");
    if (!reason.trim()) return setError("Alasan wajib diisi");
    setError(null);
    setSubmitting(true);
    const { error: rpcError } = await supabase.rpc("adjust_ap_bill", {
      p_bill_id: billId,
      p_amount: direction === "turun" ? -value : value,
      p_adjustment_date: date,
      p_reason: reason,
      p_supplier_document_ref: documentRef || null,
    });
    setSubmitting(false);
    if (rpcError) return setError(rpcError.message);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["ap_bill_pool", billId] }),
      queryClient.invalidateQueries({ queryKey: ["ap_bill_adjustments", billId] }),
      queryClient.invalidateQueries({ queryKey: ["open_pool_bills"] }),
      queryClient.invalidateQueries({ queryKey: ["ap_bills"] }),
    ]);
    close();
    await onDone();
  }

  return (
    <Modal open={open} onClose={close} title="Koreksi Tagihan">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <p className="text-sm text-slate-600">
          Dipakai kalau nilai nota salah atau supplier mengeluarkan nota kredit/debit. Utang dan barang yang belum diterima
          berubah bersama-sama.
        </p>
        <div className="flex flex-wrap gap-4 text-sm text-slate-700">
          <label className="flex items-center gap-2">
            <input type="radio" checked={direction === "turun"} onChange={() => setDirection("turun")} />
            Tagihan turun (maksimal {rp(maxDown)})
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={direction === "naik"} onChange={() => setDirection("naik")} />
            Tagihan naik
          </label>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="adjust_amount">Nominal (Rp)</Label>
            <Input id="adjust_amount" type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="adjust_date">Tanggal</Label>
            <Input id="adjust_date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor="adjust_reason">Alasan</Label>
            <Input
              id="adjust_reason"
              placeholder="mis. Nota sebenarnya Rp8.000.000, salah ketik saat dicatat"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor="adjust_document_ref">Nomor nota kredit/debit supplier (opsional)</Label>
            <Input id="adjust_document_ref" value={documentRef} onChange={(e) => setDocumentRef(e.target.value)} />
          </div>
        </div>
        {error && <FormError>{error}</FormError>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={close}>
            Kembali
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? "Menyimpan..." : "Simpan Koreksi"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
