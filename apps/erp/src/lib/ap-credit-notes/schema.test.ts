import { describe, expect, it } from "vitest";
import { apReturnCreditOptions } from "./schema";

const acct = (id: string) => ({ id, code: id, name: id });
const defaultAccounts = {
  "inventory.purchase_not_received": acct("pbd"),
  "inventory.raw_material": acct("persediaan"),
};

describe("apReturnCreditOptions", () => {
  it("retur fisik tagihan barang: Persediaan, bukan Pembelian Belum Diterima atau biaya", () => {
    const options = apReturnCreditOptions({
      hasGoodsReceipt: true,
      billDebitAccounts: [acct("pbd"), acct("ongkir")],
      inventoryAccountIds: new Set(["persediaan"]),
      defaultAccounts,
    });
    expect(options.map((a) => a.id)).toEqual(["persediaan"]);
  });

  it("retur fisik tagihan lama: akun Persediaan di tagihan dipakai, tanpa dobel", () => {
    const options = apReturnCreditOptions({
      hasGoodsReceipt: true,
      billDebitAccounts: [acct("persediaan")],
      inventoryAccountIds: new Set(["persediaan"]),
      defaultAccounts,
    });
    expect(options.map((a) => a.id)).toEqual(["persediaan"]);
  });

  it("retur nominal: tanpa Persediaan dan tanpa Pembelian Belum Diterima", () => {
    const options = apReturnCreditOptions({
      hasGoodsReceipt: false,
      billDebitAccounts: [acct("pbd"), acct("persediaan"), acct("ongkir")],
      inventoryAccountIds: new Set(["persediaan"]),
      defaultAccounts,
    });
    expect(options.map((a) => a.id)).toEqual(["ongkir"]);
  });
});
