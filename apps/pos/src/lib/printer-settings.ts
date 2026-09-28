/** Port COM printer thermal Bluetooth beda-beda per komputer (tergantung urutan
 * pairing Windows), jadi disimpan per-device di localStorage, bukan di database. */
const PORT_KEY = "pos_thermal_printer_port";

export function getPrinterPort(): string | null {
  try {
    return localStorage.getItem(PORT_KEY);
  } catch {
    return null;
  }
}

export function setPrinterPort(port: string | null): void {
  try {
    if (port) localStorage.setItem(PORT_KEY, port);
    else localStorage.removeItem(PORT_KEY);
  } catch {
    // localStorage gak tersedia (mis. private mode) -- print ESC/POS gak dipakai, no-op.
  }
}

// window.print() (print-window.ts) dipakai kalau app dibuka lewat browser biasa,
// bukan cuma di window desktop Tauri -- __TAURI_INTERNALS__ cuma ada di webview Tauri.
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
