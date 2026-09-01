import crypto from "node:crypto";
import { db } from "@/utils/db";

export async function readCanvasCancelReceipt(runUuid: string, clientActionId: string): Promise<{
  requestDigest: string;
  response: unknown;
} | undefined> {
  const row = await db("canvas_execution_cancel_receipts").where({
    run_uuid: runUuid,
    client_action_id: clientActionId,
  }).first();
  if (!row) return undefined;
  return {
    requestDigest: String(row.request_digest),
    response: JSON.parse(String(row.response_json)),
  };
}

export async function writeCanvasCancelReceipt(input: {
  runUuid: string;
  clientActionId: string;
  requestDigest: string;
  response: unknown;
}): Promise<void> {
  await db("canvas_execution_cancel_receipts").insert({
    run_uuid: input.runUuid,
    client_action_id: input.clientActionId,
    request_digest: input.requestDigest,
    response_json: JSON.stringify(input.response),
    audit_uuid: crypto.randomUUID(),
    created_at: new Date().toISOString(),
  });
}
