import { describe, expect, it } from "vitest";
import { formatByteProgress, isBlockingProgress } from "../../src/features/tianjiang/sync/progress";

describe("sync progress helpers", () => {
  it("running is blocking; failed is not auto-dismiss", () => {
    expect(isBlockingProgress({
      operationId: "1",
      intent: "logout",
      state: "running",
      phase: "uploading",
      completedProjects: 0,
      totalProjects: 1,
      completedObjects: 0,
      totalObjects: 1,
      uploadedBytes: 0,
      totalBytes: 1,
      counts: { database: 1, image: 0, video: 0, audio: 0, other: 0 },
    })).toBe(true);
    expect(isBlockingProgress({
      operationId: "1",
      intent: "logout",
      state: "failed",
      phase: "failed",
      completedProjects: 0,
      totalProjects: 1,
      completedObjects: 0,
      totalObjects: 1,
      uploadedBytes: 0,
      totalBytes: 1,
      counts: { database: 1, image: 0, video: 0, audio: 0, other: 0 },
    })).toBe(false);
  });

  it("formats bytes", () => {
    expect(formatByteProgress(512, 2048)).toContain("KB");
  });
});
