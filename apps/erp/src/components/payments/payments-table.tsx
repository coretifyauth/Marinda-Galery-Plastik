"use client";

import { paymentCancellation, type PaymentRow } from "@/lib/payments/active";
import { CancelledBadge } from "@/components/ui/cancelled";
import { Button } from "@/components/ui/button";

/** Tabel pembayaran di detail tagihan/invoice: pembayaran yang dibatalkan tetap tampil sebagai riwayat. */
export function PaymentsTable({
  payments,
  canCancel,
  onCancel,
}: {
  payments: PaymentRow[];
  canCancel: boolean;
  onCancel: (payment: PaymentRow) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
            <th className="px-4 py-2">Tanggal</th>
            <th className="px-4 py-2">Rujukan Dokumen</th>
            <th className="px-4 py-2 text-right">Jumlah</th>
            <th className="px-4 py-2" />
          </tr>
        </thead>
        <tbody>
          {payments.map((p) => {
            const cancellation = paymentCancellation(p);
            return (
              <tr key={p.id} className={`border-b border-slate-100 align-top ${cancellation ? "bg-red-50/40" : "hover:bg-slate-50"}`}>
                <td className="whitespace-nowrap px-4 py-2">{p.payment_date}</td>
                <td className="px-4 py-2">
                  {p.source_ref}
                  {cancellation && (
                    <p className="mt-1 text-xs text-slate-500">
                      {cancellation.reason}
                      {cancellation.money_moved && (
                        <span className="ml-1 font-medium text-amber-700">Uangnya benar berpindah: pastikan sudah dicatat ulang.</span>
                      )}
                    </p>
                  )}
                </td>
                <td className={`px-4 py-2 text-right font-mono ${cancellation ? "text-slate-400 line-through" : ""}`}>
                  {p.amount.toLocaleString("id-ID")}
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-right">
                  {cancellation ? (
                    <CancelledBadge />
                  ) : (
                    canCancel && (
                      <Button variant="toolbar" onClick={() => onCancel(p)}>
                        Batalkan
                      </Button>
                    )
                  )}
                </td>
              </tr>
            );
          })}
          {payments.length === 0 && (
            <tr>
              <td colSpan={4} className="px-4 py-6 text-center text-slate-400">
                Belum ada pembayaran.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
