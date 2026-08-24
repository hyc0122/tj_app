/**
 * Round20 RED：常规专项测试在没有被忽略官方 CLI 时必须通过。
 * 生产入口：readApprovedReleaseManifest + 未注入测试清单的 installApprovedDreaminaRelease。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const OFFICIAL = path.resolve(
  __dirname,
  "../../../.tmp/round19-dreamina-official/dreamina_cli_windows_amd64.exe",
);

test("移走被忽略官方 exe 后，内置清单专项测试仍必须通过", () => {
  const hidden = `${OFFICIAL}.round20-hidden`;
  let moved = false;
  if (fs.existsSync(OFFICIAL)) {
    fs.renameSync(OFFICIAL, hidden);
    moved = true;
  }
  try {
    assert.equal(fs.existsSync(OFFICIAL), false, "本 RED 必须在没有官方 exe 的环境执行");
    const ran = spawnSync(
      process.execPath,
      ["--import", "tsx", "--test", "--test-concurrency=1", "test/tianjiang/dreamina-bundled-manifest-round19.test.ts"],
      {
        cwd: path.resolve(__dirname, "../.."),
        encoding: "utf8",
        env: Object.fromEntries(
          Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT"),
        ),
      },
    );
    const output = `${ran.stdout}\n${ran.stderr}`;
    assert.match(output, /tests 4|ℹ tests 4/, `子进程必须跑完内置清单 4 个测试，output=${output}`);
    assert.equal(
      ran.status,
      0,
      `无被忽略 Artifact 时内置清单测试必须通过，exit=${ran.status}\n${output}`,
    );
  } finally {
    if (moved && fs.existsSync(hidden) && !fs.existsSync(OFFICIAL)) {
      fs.renameSync(hidden, OFFICIAL);
    }
  }
});
