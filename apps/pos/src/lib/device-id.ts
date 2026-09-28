/** ID unik per instalasi (per komputer kasir), dipakai buat susun nomor struk
 * sementara pas offline (`OFFLINE-{deviceId}-{seq}`) -- disimpan localStorage,
 * pola sama persis printer-settings.ts. */
const DEVICE_ID_KEY = "pos_device_id";
const OFFLINE_SEQ_KEY = "pos_offline_seq";

export function getDeviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = crypto.randomUUID().slice(0, 8);
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    return "unknown";
  }
}

// Counter lokal per-device, disimpan synchronous di localStorage (bukan di
// Dexie) biar tetap jalan walau IndexedDB belum sempat kebuka, dan gak perlu
// nunggu Promise cuma buat nomor urut.
export function nextOfflineSourceRef(): string {
  const deviceId = getDeviceId();
  try {
    const seq = Number(localStorage.getItem(OFFLINE_SEQ_KEY) ?? "0") + 1;
    localStorage.setItem(OFFLINE_SEQ_KEY, String(seq));
    return `OFFLINE-${deviceId}-${seq}`;
  } catch {
    return `OFFLINE-${deviceId}-${Date.now()}`;
  }
}
