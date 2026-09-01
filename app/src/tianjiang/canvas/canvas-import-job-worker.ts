import { db } from "@/utils/db";

/** origin-device worker：本任务 GREEN 在 accept 后保持 queued，由 cancel/reconciler 收敛。 */
export async function runCanvasImportWorker(importUuid: string): Promise<void> {
  const job = await db("canvas_import_jobs").where({ import_uuid: importUuid }).first();
  if (!job) return;
}
