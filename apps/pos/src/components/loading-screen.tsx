// Spinner modern gantiin teks "Memuat..." polos. Padanan apps/erp/src/components/ui/
// loading-screen.tsx -- gak ada package UI bersama antar app, jadi duplikat kecil ini
// sengaja (bukan diextract ke packages/shared, spekulatif kalau dipaksa sekarang).
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
