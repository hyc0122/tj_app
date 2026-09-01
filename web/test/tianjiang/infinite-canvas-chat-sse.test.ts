import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const apiSource = readFileSync(fileURLToPath(new URL(
  "../../src/features/tianjiang/canvas/api.ts",
  import.meta.url,
)), "utf8");

describe("无限画布聊天 SSE", () => {
  test("前端必须按 data 帧流式消费，不能由 Axios 缓冲成单个对象", () => {
    expect(apiSource).toContain("response.body.getReader()");
    expect(apiSource).toContain("text/event-stream");
    expect(apiSource).not.toMatch(/axios\.post\([^)]*\/canvas\/chat/s);
  });
});
