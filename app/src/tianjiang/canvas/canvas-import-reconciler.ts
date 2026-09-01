import { db } from "@/utils/db";

/** 启动对账：receiving 无 receipt 时收敛为 awaiting_reupload。 */
export async function reconcileCanvasImportJobs(): Promise<void> {
  const receiving = await db("canvas_import_jobs").where({ state: "receiving" });
  const now = new Date().toISOString();
  for (const job of receiving) {
    if (!job.acceptance_response_json) {
      await db("canvas_import_jobs").where({ import_uuid: job.import_uuid }).update({
        state: "awaiting_reupload",
        updated_at: now,
      });
    }
  }
}
