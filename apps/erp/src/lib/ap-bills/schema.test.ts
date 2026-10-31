import { describe, expect, it } from "vitest";
import { billStatus } from "./schema";

const bill = (over = {}) => ({
  amount: 1000,
  ap_payments: [],
  ap_returns: [],
  ap_deposit_applications: [],
  ap_bill_adjustments: [],
  ...over,
});

describe("billStatus -- pembayaran batal & koreksi tagihan", () => {
  it("pembayaran yang dibatalkan tidak dihitung", () => {
    const { allocated, outstanding, status } = billStatus(
      bill({ ap_payments: [{ amount: 1000, payment_cancellations: { payment_id: "x" } }] })
    );
    expect(allocated).toBe(0);
    expect(outstanding).toBe(1000);
    expect(status).toBe("belum");
  });

  it("pembayaran aktif tetap dihitung di samping yang batal", () => {
    const { allocated, status } = billStatus(
      bill({
        ap_payments: [
          { amount: 1000, payment_cancellations: { payment_id: "x" } },
          { amount: 1000, payment_cancellations: null },
        ],
      })
    );
    expect(allocated).toBe(1000);
    expect(status).toBe("lunas");
  });

  it("koreksi tagihan mengubah sisa", () => {
    expect(billStatus(bill({ ap_bill_adjustments: [{ amount: -200 }] })).outstanding).toBe(800);
    expect(billStatus(bill({ ap_bill_adjustments: [{ amount: 300 }] })).outstanding).toBe(1300);
  });
});
