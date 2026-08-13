"use client";

export type TabDef = {
  key: string;
  label: string;
  badge?: number;
};

/**
 * Tab strip generik buat detail page — dipakai buat misahin tabel relasi (Jurnal,
 * Pembayaran, Retur, dst) + tombol aksi masing-masing ke tab sendiri-sendiri,
 * bukan ditumpuk vertikal. Styling mirror tab ad-hoc yang sebelumnya cuma ada di
 * `/accounts/[id]` (satu-satunya halaman yang pakai tab sebelum ini). Controlled
 * (active+onChange di-manage caller), bukan nyimpen state sendiri, biar caller
 * bebas nyambungin ke query param/dll kalau nanti perlu.
 */
export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: TabDef[];
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1 border-b border-slate-200">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => onChange(t.key)}
          className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium ${
            active === t.key ? "border-b-2 border-blue-600 text-blue-700" : "text-slate-500 hover:text-slate-700"
          }`}
        >
          {t.label}
          {t.badge !== undefined && (
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">{t.badge}</span>
          )}
        </button>
      ))}
    </div>
  );
}
