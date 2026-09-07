import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  clearPendingLegacyMutationIntent,
  recordPendingLegacyMutationIntent,
} from "../../src/tianjiang/runtime/pending-legacy-mutation-intent";
import {
  clearTeamCheckpointReceipt,
  writeTeamCheckpointReceipt,
} from "../../src/tianjiang/runtime/team-checkpoint-receipt";
import {
  clearTeamReleaseReceipt,
  writeTeamReleaseReceipt,
} from "../../src/tianjiang/runtime/team-release-receipt";

const userSegment = "a".repeat(32);
const otherUserSegment = "b".repeat(32);
const projectUuid = "11111111-1111-4111-8111-111111111111";
const otherProjectUuid = "22222222-2222-4222-8222-222222222222";

type MarkerCase = {
  name: string;
  directory: string;
  write: (root: string, user: string, project: string) => unknown;
  clear: (root: string, user: string, project: string) => void;
};

const markers: MarkerCase[] = [
  {
    name: "mutation intent",
    directory: "pending-legacy-mutations",
    write: (dataRoot, segment, uuid) => recordPendingLegacyMutationIntent({
      dataRoot, userSegment: segment, projectUuid: uuid, kind: "personal", source: "project-create",
    }),
    clear: clearPendingLegacyMutationIntent,
  },
  {
    name: "team release receipt",
    directory: "team-release-receipts",
    write: (dataRoot, segment, uuid) => writeTeamReleaseReceipt(dataRoot, segment, {
      projectUuid: uuid,
      lockId: "fixture-lock",
      fencingToken: 1,
      phase: "released_cleanup_pending",
      publishedAt: "2026-09-07T00:00:00.000Z",
      capturedMutationGeneration: 1,
    }),
    clear: clearTeamReleaseReceipt,
  },
  {
    name: "team checkpoint receipt",
    directory: "team-checkpoint-receipts",
    write: (dataRoot, segment, uuid) => writeTeamCheckpointReceipt(dataRoot, segment, {
      projectUuid: uuid,
      lockId: "fixture-lock",
      fencingToken: 1,
      phase: "finalized",
      baseVersion: 0,
      expectedVersion: 1,
      capturedMutationGeneration: 1,
      objects: [],
    }),
    clear: clearTeamCheckpointReceipt,
  },
];

function fixture(t: TestContext) {
  const temporaryRoot = path.resolve(process.cwd(), ".tmp");
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(temporaryRoot, "sync-marker-unicode-"));
  const dataRoot = path.join(root, "天将漫创", "用户目录", "data");
  fs.mkdirSync(dataRoot, { recursive: true });
  t.after(() => {
    t.mock.restoreAll();
    // 仅清理本用例创建的目录；同样不依赖有中文路径缺陷的 rmSync。
    const removeFixture = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) removeFixture(filename);
        else fs.unlinkSync(filename);
      }
      fs.rmdirSync(directory);
    };
    removeFixture(root);
  });
  return dataRoot;
}

function markerPath(root: string, marker: MarkerCase, user = userSegment, project = projectUuid) {
  return path.join(root, "runtime-users", user, marker.directory, `${project}.json`);
}

for (const marker of markers) {
  test(`${marker.name}：旧版 rmSync 静默失效时仍清除中文路径标记且不影响其他项目`, (t) => {
    const root = fixture(t);
    marker.write(root, userSegment, projectUuid);
    marker.write(root, userSegment, otherProjectUuid);
    marker.write(root, otherUserSegment, projectUuid);
    const target = markerPath(root, marker);
    const otherProject = markerPath(root, marker, userSegment, otherProjectUuid);
    const otherUser = markerPath(root, marker, otherUserSegment);
    const projectBefore = fs.readFileSync(otherProject, "utf8");
    const userBefore = fs.readFileSync(otherUser, "utf8");
    const dataFile = path.join(root, "project.sqlite");
    fs.writeFileSync(dataFile, "project-data-sentinel");
    // 模拟 Node 24.11.1 的删除静默空操作；实际写入、unlink 和最终文件断言均使用真实磁盘。
    t.mock.method(fs, "rmSync", () => {});

    marker.clear(root, userSegment, projectUuid);

    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.readFileSync(otherProject, "utf8"), projectBefore);
    assert.equal(fs.readFileSync(otherUser, "utf8"), userBefore);
    assert.equal(fs.readFileSync(dataFile, "utf8"), "project-data-sentinel");
  });

  test(`${marker.name}：标记不存在时重复清理保持幂等`, (t) => {
    const root = fixture(t);
    assert.doesNotThrow(() => marker.clear(root, userSegment, projectUuid));
    assert.doesNotThrow(() => marker.clear(root, userSegment, projectUuid));
    assert.equal(fs.existsSync(markerPath(root, marker)), false);
  });

  test(`${marker.name}：删除被拒绝时必须报错并保留恢复标记`, (t) => {
    const root = fixture(t);
    marker.write(root, userSegment, projectUuid);
    const target = markerPath(root, marker);
    const before = fs.readFileSync(target, "utf8");
    t.mock.method(fs, "unlinkSync", () => {
      throw Object.assign(new Error("fixture deletion denied"), { code: "EACCES" });
    });

    assert.throws(() => marker.clear(root, userSegment, projectUuid), /deletion denied/);
    assert.equal(fs.readFileSync(target, "utf8"), before);
  });

  test(`${marker.name}：异常目录不能被当作标记递归删除`, (t) => {
    const root = fixture(t);
    const target = markerPath(root, marker);
    fs.mkdirSync(target, { recursive: true });
    const sentinel = path.join(target, "keep.txt");
    fs.writeFileSync(sentinel, "keep");

    assert.throws(() => marker.clear(root, userSegment, projectUuid));
    assert.equal(fs.readFileSync(sentinel, "utf8"), "keep");
  });

  test(`${marker.name}：删除返回但文件仍存在时不能伪装清理成功`, (t) => {
    const root = fixture(t);
    marker.write(root, userSegment, projectUuid);
    const target = markerPath(root, marker);
    const before = fs.readFileSync(target, "utf8");
    t.mock.method(fs, "unlinkSync", () => {});

    assert.throws(() => marker.clear(root, userSegment, projectUuid), /文件仍存在/);
    assert.equal(fs.readFileSync(target, "utf8"), before);
  });
}
