"use client";

import {
  Children,
  Fragment,
  isValidElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";

export type ComboboxOption = { value: string; label: string; disabled?: boolean; data?: unknown };
type Option = ComboboxOption;

// Drop-in pengganti <Select>/<select>: terima <option> sebagai children dan manggil onChange
// dengan objek ber-`target.value` (cukup buat semua pemakai yang ada), tapi bisa diketik buat
// nyaring daftar -- dipakai buat pilihan item & counterparty yang bisa ratusan baris.
//
// Mode server (kalau `searchOptions` diisi): daftar BUKAN dari children, tapi dicari ke server tiap
// ketikan (debounce) -- buat katalog besar. `selectedLabel` = teks yang ditampilkan saat tertutup
// (caller yang tahu label dari `value`), `onPick` dipanggil dengan opsi terpilih (bawa `data`).
type ComboboxProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "onChange" | "value"> & {
  value: string;
  onChange?: (e: ChangeEvent<HTMLSelectElement>) => void;
  searchOptions?: (query: string) => Promise<ComboboxOption[]>;
  selectedLabel?: string;
  emptyLabel?: string; // mode server: tampilkan opsi "kosongkan" di paling atas
  onPick?: (option: ComboboxOption) => void;
  placeholder?: string;
};

const MAX_RENDERED = 100;
const SEARCH_DEBOUNCE_MS = 250;

function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

function collectOptions(children: ReactNode, out: Option[] = []): Option[] {
  Children.forEach(children, (child) => {
    if (!isValidElement<{ value?: string | number; disabled?: boolean; children?: ReactNode }>(child)) return;
    if (child.type === "option") {
      const label = textOf(child.props.children);
      out.push({
        value: child.props.value !== undefined ? String(child.props.value) : label,
        label,
        disabled: !!child.props.disabled,
      });
    } else if (child.type === Fragment || child.type === "optgroup") {
      collectOptions(child.props.children, out);
    }
  });
  return out;
}

export function Combobox({
  value,
  onChange,
  children,
  className = "",
  disabled,
  id,
  searchOptions,
  selectedLabel,
  emptyLabel,
  onPick,
  placeholder,
  ...rest
}: ComboboxProps) {
  const remote = !!searchOptions;
  const [remoteOptions, setRemoteOptions] = useState<Option[]>([]);
  const [loading, setLoading] = useState(false);
  const localOptions = useMemo(() => collectOptions(children), [children]);
  const options = useMemo(
    () => (remote ? (emptyLabel ? [{ value: "", label: emptyLabel }, ...remoteOptions] : remoteOptions) : localOptions),
    [remote, emptyLabel, remoteOptions, localOptions]
  );
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [rect, setRect] = useState<{ left: number; width: number; top?: number; bottom?: number } | null>(null);

  const selected = remote
    ? value
      ? { value: String(value), label: selectedLabel ?? "" }
      : undefined
    : options.find((o) => o.value === String(value));
  const emptyOption = remote ? (emptyLabel ? { value: "", label: emptyLabel } : undefined) : options.find((o) => o.value === "");
  const shown = useMemo(() => {
    if (remote) return query ? options.filter((o) => o.value !== "") : options;
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return options.filter((o) => terms.every((t) => o.label.toLowerCase().includes(t)));
  }, [remote, options, query]);
  const visible = shown.slice(0, MAX_RENDERED);

  function place() {
    const el = inputRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    setRect(
      below < 200 && r.top > below
        ? { left: r.left, width: Math.max(r.width, 224), bottom: window.innerHeight - r.top + 2 }
        : { left: r.left, width: Math.max(r.width, 224), top: r.bottom + 2 }
    );
  }

  function openList() {
    if (disabled) return;
    setQuery("");
    setActive(Math.max(0, options.findIndex((o) => o.value === String(value))));
    place();
    setOpen(true);
  }

  function close() {
    setOpen(false);
    setQuery("");
  }

  function choose(opt: Option) {
    if (opt.disabled) return;
    onChange?.({ target: { value: opt.value }, currentTarget: { value: opt.value } } as unknown as ChangeEvent<HTMLSelectElement>);
    if (opt.value !== "") onPick?.(opt);
    close();
  }

  useEffect(() => {
    if (!open) return;
    const reposition = () => place();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!inputRef.current?.contains(t) && !listRef.current?.contains(t)) close();
    };
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !searchOptions) return;
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(
      () => {
        searchOptions(query.trim())
          .then((rows) => !cancelled && setRemoteOptions(rows))
          .catch(() => !cancelled && setRemoteOptions([]))
          .finally(() => !cancelled && setLoading(false));
      },
      query ? SEARCH_DEBOUNCE_MS : 0
    );
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // searchOptions sengaja gak jadi dependency: identitasnya berubah tiap render caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query]);

  useEffect(() => {
    if (open) listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter") {
        e.preventDefault();
        openList();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, visible.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (visible[active]) choose(visible[active]);
    } else if (e.key === "Escape" || e.key === "Tab") {
      close();
    }
  }

  const baseClass =
    "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/40 disabled:opacity-50";

  return (
    <>
      <input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label={rest["aria-label"]}
        autoComplete="off"
        disabled={disabled}
        className={`${className.includes("w-") || className.includes("px-") ? "" : baseClass} ${className}`}
        value={open ? query : selected && selected.value !== "" ? selected.label : ""}
        placeholder={open ? "Ketik untuk mencari..." : emptyOption?.label || placeholder || rest["aria-label"] || "Pilih..."}
        onFocus={openList}
        onClick={() => !open && openList()}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          if (!open) openList();
        }}
        onKeyDown={onKeyDown}
      />
      {open &&
        rect &&
        createPortal(
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            style={{ left: rect.left, width: rect.width, top: rect.top, bottom: rect.bottom }}
            className="fixed z-[70] max-h-64 overflow-auto rounded-lg border border-slate-200 bg-white py-1 text-sm shadow-lg"
          >
            {visible.map((o, i) => (
              <li
                key={`${o.value}-${i}`}
                data-idx={i}
                role="option"
                aria-selected={o.value === String(value)}
                aria-disabled={o.disabled}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(o);
                }}
                onMouseEnter={() => setActive(i)}
                className={`cursor-pointer px-3 py-1.5 ${i === active ? "bg-blue-50 text-blue-900" : "text-slate-800"} ${
                  o.value === String(value) ? "font-medium" : ""
                } ${o.disabled ? "cursor-not-allowed opacity-40" : ""} ${o.value === "" ? "text-slate-400" : ""}`}
              >
                {o.label || "—"}
              </li>
            ))}
            {visible.length === 0 && (
              <li className="px-3 py-2 text-slate-400">{loading ? "Mencari..." : "Tidak ada yang cocok."}</li>
            )}
            {shown.length > MAX_RENDERED && (
              <li className="px-3 py-1.5 text-xs text-slate-400">
                +{shown.length - MAX_RENDERED} lainnya — ketik untuk mempersempit.
              </li>
            )}
          </ul>,
          document.body
        )}
    </>
  );
}
