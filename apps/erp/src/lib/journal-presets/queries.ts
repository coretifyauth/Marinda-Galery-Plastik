import { supabase } from "@/lib/supabase/client";
import type { Preset } from "./schema";

const SELECT_COLUMNS =
  "id, label, status, created_at, activated_at, app_preset_journal_entry_lines(id, preset_id, account_id, side, label, sort_order, accounts(code, name))";

export async function fetchPresets(): Promise<Preset[]> {
  const { data, error } = await supabase
    .from("app_preset_journal_entries")
    .select(SELECT_COLUMNS)
    .order("label");
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as Preset[];
}

export async function fetchActivePresets(): Promise<Preset[]> {
  const { data, error } = await supabase
    .from("app_preset_journal_entries")
    .select(SELECT_COLUMNS)
    .eq("status", "active")
    .order("label");
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as Preset[];
}

export async function fetchPreset(id: string): Promise<Preset | null> {
  const { data, error } = await supabase.from("app_preset_journal_entries").select(SELECT_COLUMNS).eq("id", id).single();
  if (error) return null;
  const preset = data as unknown as Preset;
  preset.app_preset_journal_entry_lines.sort((a, b) => a.sort_order - b.sort_order);
  return preset;
}
