import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { setGenerationArtifactDownloaderForTests } from "../../../src/tianjiang/tasks/generation-artifact-downloader";

export function installManagedStaging(root: string): {
  stagingRoot: string;
  stage(sourcePath: string): string;
  stageBytes(bytes: Buffer): string;
  dispose(): void;
} {
  const stagingRoot = path.join(root, "generation-staging");
  fs.mkdirSync(stagingRoot, { recursive: true });
  setGenerationArtifactDownloaderForTests({ stagingRoot });
  return {
    stagingRoot,
    stage(sourcePath: string) {
      const dest = path.join(stagingRoot, `gen-${crypto.randomUUID()}`);
      fs.copyFileSync(sourcePath, dest);
      return dest;
    },
    stageBytes(bytes: Buffer) {
      const dest = path.join(stagingRoot, `gen-${crypto.randomUUID()}`);
      fs.writeFileSync(dest, bytes);
      return dest;
    },
    dispose() {
      setGenerationArtifactDownloaderForTests(null);
    },
  };
}
