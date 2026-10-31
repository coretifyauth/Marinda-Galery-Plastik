// Pembayaran yang dibatalkan (payment_cancellations, migration 0060) tidak dihitung lagi sebagai pembayaran -- mirror
// transaction_active_payments() di database. PostgREST mengembalikan relasi 1-1 sebagai objek/null.

export type PaymentCancellation = {
  reason: string;
  money_moved: boolean;
  cancelled_at: string;
};

export type WithCancellation<T = { payment_id: string }> = {
  payment_cancellations?: T | T[] | null;
};

export function paymentCancellation<T>(payment: WithCancellation<T>): T | null {
  const c = payment.payment_cancellations;
  if (Array.isArray(c)) return c[0] ?? null;
  return c ?? null;
}

export function isActivePayment(payment: WithCancellation<unknown>): boolean {
  return paymentCancellation(payment) === null;
}

/** Kolom select untuk baris pembayaran yang ditampilkan di tabel. */
export const PAYMENT_ROW_COLUMNS =
  "id, payment_date, source_ref, amount, payment_cancellations(reason, money_moved, cancelled_at)";

export type PaymentRow = {
  id: string;
  payment_date: string;
  source_ref: string;
  amount: number;
} & WithCancellation<PaymentCancellation>;
