// Retur ke supplier yang dibatalkan (return_cancellations, migration 0061) tidak dihitung lagi -- mirror return_is_active()
// di database. PostgREST mengembalikan relasi 1-1 sebagai objek/null (bukan array), sama seperti payment_cancellations.

export type ReturnCancellation = {
  reason: string;
  cancelled_at: string;
};

export type WithReturnCancellation<T = { return_id: string }> = {
  return_cancellations?: T | T[] | null;
};

export function returnCancellation<T>(ret: WithReturnCancellation<T>): T | null {
  const c = ret.return_cancellations;
  if (Array.isArray(c)) return c[0] ?? null;
  return c ?? null;
}

export function isActiveReturn(ret: WithReturnCancellation<unknown>): boolean {
  return returnCancellation(ret) === null;
}

// Pencairan tunai saldo retur supplier yang dibatalkan (return_credit_refund_cancellations, migration 0062) tidak dihitung
// lagi sebagai uang yang sudah kembali -- mirror return_credit_refund_is_active() di database.
export type RefundCancellation = {
  reason: string;
  money_moved: boolean;
  cancelled_at: string;
};

export type WithRefundCancellation<T = { refund_id: string }> = {
  return_credit_refund_cancellations?: T | T[] | null;
};

export function refundCancellation<T>(refund: WithRefundCancellation<T>): T | null {
  const c = refund.return_credit_refund_cancellations;
  if (Array.isArray(c)) return c[0] ?? null;
  return c ?? null;
}

export function isActiveRefund(refund: WithRefundCancellation<unknown>): boolean {
  return refundCancellation(refund) === null;
}
