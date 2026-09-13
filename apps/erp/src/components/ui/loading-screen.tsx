// Spinner modern gantiin teks "Memuat..." polos -- dipakai di titik "checkingSession"
// yang muncul di HAMPIR SEMUA halaman sebelum konten render. LoadingScreen = full-block
// replacement (dipakai lewat `return <LoadingScreen />`), InlineSpinner = versi kecil buat
// ditaruh di tengah konten yang udah render (mis. laporan yang lagi di-refresh).
export function LoadingScreen() {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-200 border-t-blue-600" />
        <p className="text-sm text-slate-400">Memuat...</p>
      </div>
    </div>
  );
}

export function InlineSpinner({ label = "Memuat..." }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 text-sm text-slate-400">
      <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-200 border-t-blue-600" />
      {label}
    </div>
  );
}
