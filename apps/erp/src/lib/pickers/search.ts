import { supabase } from "@/lib/supabase/client";
import type { Item } from "@/lib/items/schema";
import type { ItemUnit } from "@/lib/item-units/schema";
import { fetchWalkInCustomerId } from "@/lib/pos-settings/schema";

// id walk-in jarang berubah -- cukup 1x fetch per sesi halaman, bukan per ketikan.
let walkInPromise: Promise<string | null> | null = null;
const walkInId = () => (walkInPromise ??= fetchWalkInCustomerId());

// Pencarian server-side buat combobox item & counterparty: tiap ketikan = 1 query kecil
// (ilike nama + limit), bukan memuat seluruh katalog di awal halaman.
export const PICKER_LIMIT = 20;

export type ItemWithUnits = Item & { item_units: ItemUnit[] };

const ITEM_BASE = "id, name, item_type, uom, inventory_account_id, category_id, brand_id, archived_at";
const UNIT_COLUMNS = "id, item_id, unit_label, conversion_factor, price, is_base";
const ITEM_COLUMNS = `${ITEM_BASE}, item_units(${UNIT_COLUMNS})`;

// % dan _ di input user gak boleh jadi wildcard ilike.
const escapeLike = (q: string) => q.replace(/[\\%_]/g, (c) => `\\${c}`);

export type ItemSearchOptions = {
  itemType?: "RAW_MATERIAL" | "FINISHED_GOOD";
  sellableOnly?: boolean; // punya minimal 1 satuan jual berharga
  includeArchived?: boolean;
};

export async function searchItems(query: string, opts: ItemSearchOptions = {}): Promise<ItemWithUnits[]> {
  // !inner + filter price = hanya item yang punya satuan jual berharga (embed ikut ke-filter,
  // satuan tanpa harga gak ikut -- sama persis dengan filter lama di sisi client).
  let q = supabase
    .from("items")
    .select(opts.sellableOnly ? `${ITEM_BASE}, item_units!inner(${UNIT_COLUMNS})` : ITEM_COLUMNS)
    .order("name")
    .limit(PICKER_LIMIT);
  if (!opts.includeArchived) q = q.is("archived_at", null);
  if (opts.itemType) q = q.eq("item_type", opts.itemType);
  if (opts.sellableOnly) q = q.not("item_units.price", "is", null);
  const term = query.trim();
  if (term) q = q.ilike("name", `%${escapeLike(term)}%`);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as ItemWithUnits[];
}

export async function fetchItemById(id: string): Promise<ItemWithUnits | null> {
  const { data } = await supabase.from("items").select(ITEM_COLUMNS).eq("id", id).maybeSingle();
  return (data as unknown as ItemWithUnits | null) ?? null;
}

export type CounterpartyRow = {
  id: string;
  name: string;
  contact: string | null;
  payment_term_days: number;
  archived_at: string | null;
};

export type CounterpartySearchOptions = {
  includeArchived?: boolean;
  includeWalkIn?: boolean; // customer "Pelanggan Umum" (POS) -- default disembunyikan
};

const CP_COLUMNS = "id, name, contact, payment_term_days, archived_at";

export async function searchCounterparties(
  role: "customer" | "supplier",
  query: string,
  opts: CounterpartySearchOptions = {}
): Promise<CounterpartyRow[]> {
  let q = supabase
    .from("counterparties")
    .select(`${CP_COLUMNS}, counterparty_type_mapping!inner(role)`)
    .eq("counterparty_type_mapping.role", role)
    .order("name")
    .limit(PICKER_LIMIT);
  if (!opts.includeArchived) q = q.is("archived_at", null);
  if (role === "customer" && !opts.includeWalkIn) {
    const walkIn = await walkInId();
    if (walkIn) q = q.neq("id", walkIn);
  }
  const term = query.trim();
  if (term) q = q.ilike("name", `%${escapeLike(term)}%`);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as CounterpartyRow[];
}

export async function fetchCounterpartyName(id: string): Promise<string | null> {
  const { data } = await supabase.from("counterparties").select("name").eq("id", id).maybeSingle();
  return (data as { name: string } | null)?.name ?? null;
}

export type { ItemUnit };
