"use client";

import { useCallback, useEffect, useState } from "react";
import { Combobox } from "@/components/ui/combobox";
import {
  fetchCounterpartyName,
  searchCounterparties,
  type CounterpartySearchOptions,
} from "@/lib/pickers/search";

// Combobox customer/supplier yang mencari ke server (limit 20), bukan memuat semua counterparty.
export function CounterpartyPicker({
  role,
  value,
  onChange,
  emptyLabel,
  placeholder,
  className,
  id,
  disabled,
  "aria-label": ariaLabel,
  ...search
}: {
  role: "customer" | "supplier";
  value: string;
  onChange: (id: string) => void;
  emptyLabel?: string; // filter list: "Semua supplier" -> opsi untuk mengosongkan
  placeholder?: string;
  className?: string;
  id?: string;
  disabled?: boolean;
  "aria-label"?: string;
} & CounterpartySearchOptions) {
  const [labels, setLabels] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!value || labels[value] !== undefined) return;
    let active = true;
    fetchCounterpartyName(value).then((name) => {
      if (active && name) setLabels((p) => ({ ...p, [value]: name }));
    });
    return () => {
      active = false;
    };
  }, [value, labels]);

  const { includeArchived, includeWalkIn } = search;
  const searchOptions = useCallback(
    async (q: string) =>
      (await searchCounterparties(role, q, { includeArchived, includeWalkIn })).map((c) => ({
        value: c.id,
        label: c.name,
      })),
    [role, includeArchived, includeWalkIn]
  );

  return (
    <Combobox
      id={id}
      value={value}
      className={className}
      disabled={disabled}
      aria-label={ariaLabel}
      placeholder={placeholder ?? (role === "customer" ? "Pilih pelanggan..." : "Pilih supplier...")}
      emptyLabel={emptyLabel}
      selectedLabel={labels[value]}
      searchOptions={searchOptions}
      onChange={(e) => onChange(e.target.value)}
      onPick={(opt) => setLabels((p) => ({ ...p, [opt.value]: opt.label }))}
    >
      {null}
    </Combobox>
  );
}
