"use client";

import { useEffect, useRef, useState } from "react";

// BarcodeDetector API -- gak universal (Safari/iOS masih terbatas per Agustus 2026),
// keputusan (2026-08-16): pakai native API doang (feature-detect, fallback pesan kalau
// gak didukung) BUKAN library pihak ketiga, biar gak nambah dependency buat toko yang
// device kasirnya kebanyakan Android/Chrome (dukungan native udah cukup luas di situ).
type BarcodeDetectorInstance = {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
};
type BarcodeDetectorConstructor = new (options?: { formats?: string[] }) => BarcodeDetectorInstance;

declare global {
  interface Window {
    BarcodeDetector?: BarcodeDetectorConstructor;
  }
}

export function CameraScanner({ onDetect, onClose }: { onDetect: (code: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [supported] = useState(() => typeof window !== "undefined" && !!window.BarcodeDetector);

  useEffect(() => {
    if (!supported) return;
    let stream: MediaStream | null = null;
    let rafId = 0;
    let cancelled = false;

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();

        const Detector = window.BarcodeDetector as BarcodeDetectorConstructor;
        const detector = new Detector({
          formats: ["qr_code", "ean_13", "ean_8", "code_128", "code_39", "upc_a", "upc_e"],
        });

        const tick = async () => {
          if (cancelled || !videoRef.current) return;
          try {
            const codes = await detector.detect(videoRef.current);
            if (codes.length > 0) {
              onDetect(codes[0].rawValue);
              return;
            }
          } catch {
            // Frame belum siap / decode gagal sesaat -- coba lagi frame berikutnya,
            // bukan error yang perlu ditampilkan ke kasir.
          }
          rafId = requestAnimationFrame(tick);
        };
        rafId = requestAnimationFrame(tick);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Gagal akses kamera");
      }
    }

    start();

    return () => {
      cancelled = true;
      if (rafId) cancelAnimationFrame(rafId);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [supported, onDetect]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-sm rounded-lg bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold">Scan Kamera</h3>
          <button type="button" onClick={onClose} className="text-slate-500" aria-label="Tutup">
            ✕
          </button>
        </div>
        {!supported && (
          <p className="text-sm text-amber-600">
            Browser ini belum dukung scan kamera. Pakai scanner fisik atau ketik kode manual.
          </p>
        )}
        {supported && error && <p className="text-sm text-red-600">{error}</p>}
        {supported && !error && <video ref={videoRef} className="w-full rounded" muted playsInline />}
        <p className="mt-2 text-xs text-slate-400">Arahkan kamera ke barcode/QR barang.</p>
      </div>
    </div>
  );
}
