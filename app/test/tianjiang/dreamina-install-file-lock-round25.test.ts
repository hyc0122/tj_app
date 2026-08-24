import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  activateUserDatabase,
  destroyAllDatabaseHandles,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import { enterUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import { closeActivatedWorkspaceRuntime, createUniqueWorktreeRoot } from "./helpers/worktree-runtime";

const APPROVED_URL =
  "https://lf3-static.bytednsdoc.com/obj/eden-cn/psj_hupthlyk/ljhwZthlaukjlkulzlp/dreamina_cli_beta/dreamina_cli_windows_amd64.exe";

function peX64(): Buffer {
  const bytes = Buffer.alloc(0x180, 0);
  bytes.write("MZ", 0);
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write("PE\0\0", 0x80);
  bytes.writeUInt16LE(0x8664, 0x84);
  return bytes;
}

test("Windows 扫描器短暂锁定候选 EXE 时安装必须有界重试且保持原子 rename", async () => {
  const root = createUniqueWorktreeRoot("dreamina-lock-r25");
  const originalCwd = process.cwd();
  const originalRename = fs.renameSync;
  const identity = { issuer: "https://api.j11.com.cn", userId: 9825 };
  const approvedBytes = peX64();
  let candidateRenameCalls = 0;
  try {
    process.chdir(root);
    process.env.NODE_ENV = "prod";
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    enterUserStorage(identity);
    const installer = await import("../../src/tianjiang/model-providers/dreamina-cli/managed-installer");
    const sha256 = crypto.createHash("sha256").update(approvedBytes).digest("hex");
    installer.bindDreaminaApprovedManifest({
      schemaVersion: 1,
      sourceVersionUrl: `${APPROVED_URL}/../version.json`,
      releases: [{
        version: "2.5.0",
        platform: "windows-x64",
        url: APPROVED_URL,
        size: approvedBytes.length,
        sha256,
        releaseId: sha256,
        publishedAt: "2026-08-14T00:00:00.000Z",
      }],
    });
    installer.bindDreaminaInstallTestTransport(async () => new Response(
      Uint8Array.from(approvedBytes),
      {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(approvedBytes.length),
        },
      },
    ));
    installer.bindDreaminaCommandRunner(async () => ({
      stdout: "dreamina 2.5.0",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      parsed: { version: "2.5.0" },
    }));

    fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
      const isCandidatePromotion = path.basename(String(source)) === "dreamina.exe"
        && String(destination).includes(".candidate");
      if (isCandidatePromotion) {
        candidateRenameCalls += 1;
        if (candidateRenameCalls === 1) {
          throw Object.assign(new Error("EBUSY: scanner lock"), { code: "EBUSY" });
        }
      }
      return originalRename(source, destination);
    }) as typeof fs.renameSync;

    const result = await installer.installApprovedDreaminaRelease({
      confirm: true,
      platform: "windows-x64",
    });
    assert.equal(result.ok, true, `短锁后安装应成功，实际=${JSON.stringify(result)}`);
    assert.equal(candidateRenameCalls, 2, "只允许对同一原子 rename 做一次有界重试");
    assert.equal(fs.existsSync(result.executablePath!), true);
  } finally {
    fs.renameSync = originalRename;
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});
