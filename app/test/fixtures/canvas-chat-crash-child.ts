/**
 * 真实子进程：走已提交的 Runtime 入口执行 home-plan，供父进程在 failpoint 硬杀。
 */
import fs from "node:fs";

import { initializeCanvasWorkspace } from "../../src/utils/db";
import { runWithTemporaryAccount } from "../tianjiang/helpers/worktree-runtime";
import { mountCanvasRuntimeApp, stubOpenedCanvas } from "../tianjiang/helpers/canvas-crash-harness";

const projectUuid = String(process.env.CANVAS_CRASH_PROJECT_UUID ?? "");
const markerPath = String(process.env.CANVAS_CRASH_MARKER ?? "");
const failpoint = String(process.env.CANVAS_FAILPOINT ?? "");

function mark(state: string): void {
  if (!markerPath) return;
  fs.writeFileSync(markerPath, state, "utf8");
}

async function main(): Promise<void> {
  mark("started");
  await runWithTemporaryAccount("canvas-chat-crash-child", async () => {
    await initializeCanvasWorkspace(projectUuid);
    await stubOpenedCanvas(projectUuid);
    const { port, close } = await mountCanvasRuntimeApp();
    try {
      mark("planning");
      const response = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${projectUuid}/canvas/home-plan`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            prompt: "一座春日庭院",
            attachmentAssetUuids: [],
            baseRevision: 0,
            clientChatRequestId: "018f3d6e-2d9e-7b6c-8a9b-00000000d001",
            requestDigest: "a".repeat(64),
          }),
        },
      );
      const body = await response.json().catch(() => ({}));
      fs.writeFileSync(`${markerPath}.json`, JSON.stringify({ status: response.status, body }), "utf8");
      mark(`http:${response.status}`);
      if (failpoint === "after-accept") {
        await new Promise(() => undefined);
      }
    } finally {
      await close();
    }
  });
  mark("exited");
}

main().catch((error) => {
  mark(`error:${error instanceof Error ? error.message : "unknown"}`);
  process.exit(1);
});
