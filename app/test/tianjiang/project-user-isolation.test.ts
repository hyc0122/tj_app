import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { projectDirectory } from "../../src/tianjiang/data/paths";
import { ProjectStore } from "../../src/tianjiang/data/project-store";

test("两个 issuer 用户使用相同项目 UUID 时 SQLite、files、manifest 和 recovery 根目录不同", () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tj-project-user-isolation-"));
  const projectUuid = "11111111-1111-4111-a111-111111111111";
  const issuerAUser7 = "a".repeat(32);
  const issuerBUser7 = "b".repeat(32);
  const first = projectDirectory(dataRoot, projectUuid, issuerAUser7);
  const second = projectDirectory(dataRoot, projectUuid, issuerBUser7);
  assert.notEqual(first, second);
  assert.match(first, new RegExp(`runtime-users[\\\\/]${issuerAUser7}[\\\\/]projects`));
  assert.match(second, new RegExp(`runtime-users[\\\\/]${issuerBUser7}[\\\\/]projects`));
  const firstStore = new ProjectStore(dataRoot, projectUuid, "readwrite", issuerAUser7);
  const secondStore = new ProjectStore(dataRoot, projectUuid, "readwrite", issuerBUser7);
  try {
    firstStore.setRecord("runtime", "owner", { user: "issuer-a-user-7" });
    secondStore.setRecord("runtime", "owner", { user: "issuer-b-user-7" });
    fs.mkdirSync(path.dirname(firstStore.resolveFile("images/a.txt")), { recursive: true });
    fs.writeFileSync(firstStore.resolveFile("images/a.txt"), "only-a");
    assert.deepEqual(firstStore.getRecord("runtime", "owner"), { user: "issuer-a-user-7" });
    assert.deepEqual(secondStore.getRecord("runtime", "owner"), { user: "issuer-b-user-7" });
    assert.equal(fs.existsSync(secondStore.resolveFile("images/a.txt")), false);
  } finally {
    firstStore.close();
    secondStore.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
