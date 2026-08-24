import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  clearTeamCheckpointReceipt,
  readTeamCheckpointReceipt,
  writeTeamCheckpointReceipt,
} from "../../src/tianjiang/runtime/team-checkpoint-receipt";
import { readTeamReleaseReceiptStrict } from "../../src/tianjiang/runtime/team-release-receipt";

const projectUuid = "018f3d6e-2d9e-7b6c-8a9b-00000000009a";
const userSegment = "f".repeat(32);
const workspaceTempRoot = path.resolve(__dirname, "../../../.tmp");
fs.mkdirSync(workspaceTempRoot, { recursive: true });

test("checkpoint receipt 与 release receipt 目录分离，阶段不得混淆", () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-team-cp-receipt-"));
  try {
    writeTeamCheckpointReceipt(dataRoot, userSegment, {
      projectUuid,
      lockId: "L-cp",
      fencingToken: 3,
      phase: "publishing",
      baseVersion: 1,
      expectedVersion: 2,
      capturedMutationGeneration: 5,
      objects: [{ relativePath: "project.sqlite", md5: "a".repeat(32), size: 1 }],
    });
    const cp = readTeamCheckpointReceipt(dataRoot, userSegment, projectUuid);
    assert.equal(cp?.type, "team_checkpoint");
    assert.equal(cp?.phase, "publishing");
    // release receipt 仍缺失
    const release = readTeamReleaseReceiptStrict(dataRoot, userSegment, projectUuid);
    assert.equal(release.kind, "missing");

    clearTeamCheckpointReceipt(dataRoot, userSegment, projectUuid);
    assert.equal(readTeamCheckpointReceipt(dataRoot, userSegment, projectUuid), undefined);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
