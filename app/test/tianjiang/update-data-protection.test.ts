import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { protectUserDataBeforeUpdate } from "../../src/tianjiang/update/update-data-protection";

// 测试夹具统一落在工作树根目录，并在测试结束后清理，避免污染敏感文件扫描。
const fixtureRoot = path.resolve(process.cwd(), "..", ".tmp", "update-data-protection");

test.after(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

test("更新前完整备份 userData/data 并逐文件验证 SHA-256", async () => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  const dataRoot = path.join(fixtureRoot, "data");
  const fixtures = new Map([
    ["db2.sqlite", "sqlite-data"],
    ["runtime-users/account-a/profile.sqlite", "profile-data"],
    ["projects/project-a/project.sqlite", "project-data"],
    ["secure-credentials.json", "encrypted-credential"],
    ["skills/storyboard/SKILL.md", "skill-content"],
    ["models/catalog.json", "model-content"],
    ["modelPrompt/prompt.txt", "prompt-content"],
    ["vendor/vendor.json", "vendor-content"],
    ["client-config/public.json", "public-cache"],
  ]);
  for (const [relativePath, content] of fixtures) {
    const absolutePath = path.join(dataRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, "utf8");
  }

  const result = await protectUserDataBeforeUpdate({ userDataRoot: fixtureRoot });
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf8")) as {
    files: Array<{ path: string; size: number; sha256: string }>;
  };
  assert.equal(result.fileCount, fixtures.size);
  assert.equal(manifest.files.length, fixtures.size);
  for (const [relativePath, content] of fixtures) {
    const entry = manifest.files.find((item) => item.path === relativePath.replaceAll("\\", "/"));
    assert.ok(entry, relativePath);
    const expectedHash = crypto.createHash("sha256").update(content).digest("hex");
    assert.equal(entry.sha256, expectedHash);
    const backupFile = path.join(result.backupDir, "data", relativePath);
    assert.equal(fs.readFileSync(backupFile, "utf8"), content);
    assert.equal(
      crypto.createHash("sha256").update(fs.readFileSync(backupFile)).digest("hex"),
      expectedHash,
    );
  }
});
