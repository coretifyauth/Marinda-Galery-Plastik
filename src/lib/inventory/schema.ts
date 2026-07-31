export type InventoryLot = {
  id: string;
  item_id: string;
  source_type: "PURCHASE_RECEIPT" | "PRODUCTION_OUTPUT";
  lot_date: string;
  qty_in: number;
  unit_cost: number;
  inventory_lot_consumptions: { qty: number }[];
};

/** Qty tersisa derived (qty_in - SUM(consumptions)), gak ada kolom qty_remaining — ref inventory-schema.md. */
export function lotRemaining(lot: Pick<InventoryLot, "qty_in" | "inventory_lot_consumptions">): number {
  const consumed = lot.inventory_lot_consumptions.reduce((sum, c) => sum + c.qty, 0);
  return Math.max(0, lot.qty_in - consumed);
}

export type InventoryBalance = {
  item_id: string;
  qty_on_hand: number;
  avg_cost: number;
};
