import fs from "node:fs";
import path from "node:path";

import type { PersonalManifest, PersonalRemote } from "../../../src/tianjiang/sync/personal-project-sync";

export interface PersistentPublishReceipt {
  projectUuid: string;
  version: number;
  requestId: string;
  manifestDigest: string;
}

export function publishReceiptPath(dataRoot: string, projectUuid: string): string {
  return path.join(dataRoot, "personal-publish-receipts", `${projectUuid}.json`);
}

export function loadPublishReceipt(dataRoot: string, projectUuid: string): PersistentPublishReceipt | undefined {
  const target = publishReceiptPath(dataRoot, projectUuid);
  if (!fs.existsSync(target)) return undefined;
  return JSON.parse(fs.readFileSync(target, "utf8")) as PersistentPublishReceipt;
}

export class PersistentSyncRemoteFake implements PersonalRemote {
  constructor(
    private readonly dataRoot: string,
    public current: PersonalManifest,
  ) {
    fs.mkdirSync(dataRoot, { recursive: true });
    this.persist();
  }

  async latest(): Promise<PersonalManifest> {
    return structuredClone(this.current);
  }

  async publish(
    base: number,
    next: PersonalManifest,
    _changed: string[],
    _reason: string,
  ): Promise<PersonalManifest> {
    if (base !== this.current.version) throw new Error("personal remote version conflict");
    this.current = { ...structuredClone(next), version: base + 1 };
    this.persist();
    return structuredClone(this.current);
  }

  private persist(): void {
    fs.writeFileSync(path.join(this.dataRoot, "latest.json"), JSON.stringify(this.current));
  }
}
