"use client";

import type { ApBillPool } from "@/lib/ap-bills/pool";

const rp = (n: number) => `Rp${n.toLocaleString("id-ID")}`;

/**
 * Pilihan tagihan barang tempat barang masuk dibuat (kolam yang masih punya sisa). Barang masuk selalu dibuat dari
 * tepat satu tagihan; nilai bersih semua barang masuknya gak boleh melebihi kolam tagihan itu.
 */
export function PoolBillSelect({
  id,
  bills,
  value,
  onChange,
  loading,
  disabled,
}: {
  id?: string;
  bills: ApBillPool[];
  value: string;
  onChange: (billId: string) => void;
  loading?: boolean;
  disabled?: boolean;
}) {
  return (
    <select
      id={id}
      value={value}
      disabled={disabled || loading}
      onChange={(e) => onChange(e.target.value)}
      className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-black focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/30 disabled:bg-slate-50 disabled:text-slate-400"
    >
      <option value="">{loading ? "Memuat tagihan..." : bills.length === 0 ? "Belum ada tagihan barang yang masih punya barang belum diterima" : "Pilih tagihan barang"}</option>
      {bills.map((b) => (
        <option key={b.bill_id} value={b.bill_id}>
          {b.bill_ref} — {b.supplier_name ?? "-"} — belum diterima {rp(b.remaining)}
          {b.open_age_days != null && b.open_age_days > 0 ? ` (${b.open_age_days} hari)` : ""}
        </option>
      ))}
    </select>
  );
}

/** Ringkasan kolam tagihan terpilih: nilai tagihan, sudah diterima, dan sisa. */
export function PoolSummary({ pool, receiving }: { pool: ApBillPool; receiving?: number }) {
  const after = receiving != null ? pool.remaining - receiving : null;
  return (
    <div className="grid grid-cols-1 gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm sm:grid-cols-4">
      <div>
        <p className="text-xs text-slate-500">Nilai barang di tagihan</p>
        <p className="font-mono text-black">{rp(pool.pool_amount)}</p>
      </div>
      <div>
        <p className="text-xs text-slate-500">Sudah diterima</p>
        <p className="font-mono text-black">{rp(pool.received_value)}</p>
      </div>
      <div>
        <p className="text-xs text-slate-500">Belum diterima</p>
        <p className="font-mono font-medium text-black">{rp(pool.remaining)}</p>
      </div>
      {after != null && (
        <div>
          <p className="text-xs text-slate-500">Belum diterima setelah barang masuk ini</p>
          <p className={`font-mono font-medium ${after < 0 ? "text-red-600" : "text-black"}`}>{rp(after)}</p>
        </div>
      )}
    </div>
  );
}
