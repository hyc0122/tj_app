import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { PersonalManifest } from "./personal-project-sync";

export interface PersonalPublishReceipt {
  projectUuid: string;
  version: number;
  requestId: string;
  manifestDigest: string;
}

export function publishReceiptPath(dataRoot: string, projectUuid: string): string {
  return path.join(dataRoot, "personal-publish-receipts", `${projectUuid}.json`);
}

export function manifestDigestOf(manifest: PersonalManifest): string {
  return crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

export function writePersonalPublishReceipt(
  dataRoot: string,
  projectUuid: string,
  manifest: PersonalManifest,
): PersonalPublishReceipt {
  const receipt: PersonalPublishReceipt = {
    projectUuid,
    version: manifest.version,
    requestId: crypto.randomUUID(),
    manifestDigest: manifestDigestOf(manifest),
  };
  const target = publishReceiptPath(dataRoot, projectUuid);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(receipt));
  fs.renameSync(temporary, target);
  return receipt;
}

export function readPersonalPublishReceipt(
  dataRoot: string,
  projectUuid: string,
): PersonalPublishReceipt | undefined {
  const target = publishReceiptPath(dataRoot, projectUuid);
  if (!fs.existsSync(target)) return undefined;
  return JSON.parse(fs.readFileSync(target, "utf8")) as PersonalPublishReceipt;
}
