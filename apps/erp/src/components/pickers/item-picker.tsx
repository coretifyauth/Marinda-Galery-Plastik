"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Combobox } from "@/components/ui/combobox";
import {
  fetchItemById,
  searchItems,
  type ItemSearchOptions,
  type ItemWithUnits,
} from "@/lib/pickers/search";

const labelOf = (it: { name: string; uom: string }) => `${it.name} (${it.uom})`;

// Combobox item yang mencari ke server (limit 20) -- gak ada lagi daftar item penuh di halaman.
// `onResolve` dipanggil dengan item lengkap (+ satuan jualnya) tiap kali user memilih ATAU nilai
// awal (mis. baris dari PO) selesai di-resolve -- caller menyimpannya di cache lokal (useItemCache)
// supaya lookup uom/satuan/kategori tetap sync.
export function ItemPicker({
  value,
  onChange,
  onResolve,
  emptyLabel,
  placeholder = "Pilih item...",
  className,
  id,
  disabled,
  "aria-label": ariaLabel,
  ...search
}: {
  value: string;
  onChange: (id: string) => void;
  onResolve?: (item: ItemWithUnits) => void;
  emptyLabel?: string;
  placeholder?: string;
  className?: string;
  id?: string;
  disabled?: boolean;
  "aria-label"?: string;
} & ItemSearchOptions) {
  const [labels, setLabels] = useState<Record<string, string>>({});
  const resolveRef = useRef(onResolve);
  useEffect(() => {
    resolveRef.current = onResolve;
  });

  // nilai awal yang labelnya belum diketahui -> ambil 1 item by id.
  useEffect(() => {
    if (!value || labels[value] !== undefined) return;
    let active = true;
    fetchItemById(value).then((it) => {
      if (!active || !it) return;
      setLabels((p) => ({ ...p, [it.id]: labelOf(it) }));
      resolveRef.current?.(it);
    });
    return () => {
      active = false;
    };
  }, [value, labels]);

  const { itemType, sellableOnly, includeArchived } = search;
  const searchOptions = useCallback(
    async (q: string) =>
      (await searchItems(q, { itemType, sellableOnly, includeArchived })).map((it) => ({
        value: it.id,
        label: labelOf(it),
        data: it,
      })),
    [itemType, sellableOnly, includeArchived]
  );

  return (
    <Combobox
      id={id}
      value={value}
      className={className}
      disabled={disabled}
      aria-label={ariaLabel}
      placeholder={placeholder}
      emptyLabel={emptyLabel}
      selectedLabel={labels[value]}
      searchOptions={searchOptions}
      onChange={(e) => onChange(e.target.value)}
      onPick={(opt) => {
        const it = opt.data as ItemWithUnits;
        setLabels((p) => ({ ...p, [it.id]: opt.label }));
        onResolve?.(it);
      }}
    >
      {null}
    </Combobox>
  );
}
