import type { ReactNode } from "react";

export type DetailRow = { label: string; value: ReactNode };
export type DetailRowGroup = { title: string; rows: DetailRow[] };

/**
 * 1 grup baris label-value bergaya "pill" (label latar abu-abu, value polos di
 * kanan, divider tipis antar baris) — dipakai buat tab "Detail" halaman detail
 * entity (mis. AP Bill: Supplier, Rujukan Dokumen, Jatuh Tempo, dst), gantiin
 * pola `dl`/`dt`/`dd` grid yang sebelumnya dipakai. Referensi visual: preferensi
 * user (2026-08-12).
 */
function Group({ title, rows }: DetailRowGroup) {
  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-base font-semibold text-black">{title}</h2>
      <div className="overflow-hidden rounded-lg border border-slate-200">
        {rows.map((r, i) => (
          <div
            key={r.label}
            className={`grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] ${i > 0 ? "border-t border-slate-100" : ""}`}
          >
            <div className="bg-slate-50 px-4 py-2.5 text-sm font-semibold text-slate-700">{r.label}</div>
            <div className="px-4 py-2.5 text-sm text-black">{r.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Layout 2 kolom (responsive jadi 1 kolom di layar sempit) buat beberapa grup baris sekaligus. */
export function DetailRows({ groups }: { groups: DetailRowGroup[] }) {
  return (
    <div className="grid grid-cols-1 gap-x-8 gap-y-6 lg:grid-cols-2">
      {groups.map((g) => (
        <Group key={g.title} {...g} />
      ))}
    </div>
  );
}
