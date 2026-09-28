/** Replay antrian outbox (transaksi yang kesimpen offline) balik ke Supabase,
 * satu-satu berurutan -- BUKAN Promise.all -- biar gak nghajar Supabase
 * sekaligus abis offline lama. Lihat plan: offline sync POS. */
import { supabase } from "@/lib/supabase/client";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { localDb, type OutboxStatus } from "@/lib/local-db";
import { isLikelyNetworkError, probeSupabase } from "@/lib/online-status";

export type SyncResult = { succeeded: number; failed: number; stoppedOffline: boolean };

// Pesan persis yang dilempar consume_weighted_average (0018_goods_notes_schema.sql)
// pas stok gak cukup -- ini yang mbedain "gagal krn oversell" (masuk panel review)
// dari "gagal krn sebab lain" (juga masuk review, tapi beda label).
const STOCK_ERROR_PATTERN = /gak cukup/i;

let syncInFlight = false; // reentrancy guard -- event online + tombol manual + startup bisa overlap

export async function syncOutbox(): Promise<SyncResult> {
  if (syncInFlight) return { succeeded: 0, failed: 0, stoppedOffline: false };
  syncInFlight = true;
  try {
    const rows = await localDb.outboxSales.where("status").equals("pending").sortBy("createdAt");
    let succeeded = 0;
    let failed = 0;

    for (const row of rows) {
      if (!(await probeSupabase())) return { succeeded, failed, stoppedOffline: true };

      await localDb.outboxSales.update(row.id, { status: "syncing" satisfies OutboxStatus });
      try {
        const sourceRef = await generateDocumentNumber("pos_sales");
        const { error } = await supabase.rpc("create_pos_sale", { ...row.payload, p_source_ref: sourceRef });
        if (error) throw new Error(error.message);

        await localDb.outboxSales.delete(row.id);
        await localDb.reconciliationLog.add({
          tempRef: row.tempSourceRef,
          realRef: sourceRef,
          syncedAt: new Date().toISOString(),
        });
        succeeded++;
      } catch (err) {
        if (isLikelyNetworkError(err)) {
          // Koneksi putus lagi di tengah replay -- berhenti total, sisa baris (termasuk
          // yang ini) tetap/balik "pending", dicoba lagi lain kali. Jangan maksa lanjut.
          await localDb.outboxSales.update(row.id, { status: "pending" satisfies OutboxStatus });
          return { succeeded, failed, stoppedOffline: true };
        }
        const message = err instanceof Error ? err.message : String(err);
        const status: OutboxStatus = STOCK_ERROR_PATTERN.test(message) ? "failed_stock" : "failed_other";
        await localDb.outboxSales.update(row.id, {
          status,
          lastError: message,
          retryCount: row.retryCount + 1,
          updatedAt: new Date().toISOString(),
        });
        failed++; // 1 baris gagal (bisnis) gak nge-block baris berikutnya
      }
    }

    return { succeeded, failed, stoppedOffline: false };
  } finally {
    syncInFlight = false;
  }
}
