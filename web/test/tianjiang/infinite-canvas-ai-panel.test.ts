// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SENTINEL = "RED_EXPECTED:WEB_CANVAS_AI_PANEL";

function webSrc(relative: string): string {
  try {
    return readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src", relative),
      "utf8",
    );
  } catch {
    console.error(SENTINEL);
    expect.fail(SENTINEL);
    return "";
  }
}

function tapSrc(relative: string): string {
  try {
    return readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../tapcanvas/src", relative),
      "utf8",
    );
  } catch {
    console.error(SENTINEL);
    expect.fail(SENTINEL);
    return "";
  }
}

describe("右侧 AI 对话面板合同", () => {
  it("TapCanvas 编辑器必须直接挂载原项目右侧 AI 对话框", () => {
    const haystack = [
      webSrc("views/infiniteCanvas/TapCanvasHost.vue"),
      tapSrc("App.tsx"),
      tapSrc("ui/chat/AiChatDialog.tsx"),
      tapSrc("api/server.ts"),
    ].join("\n");
    const required = [
      "AiChatDialog",
      "AI 执行台",
      "开启新对话",
      "历史会话",
      "ResizeObserver",
      "sessionKey",
      "modelKey",
      "txt",
      "docx",
      "语音输入",
      "text/event-stream",
      "agentsChatStream",
    ];
    const missing = required.filter((token) => !haystack.includes(token));
    if (missing.length !== 0 || haystack.includes("/api/api/") || haystack.includes("v-html")) {
      console.error(SENTINEL);
      expect(missing, SENTINEL).toEqual([]);
    }
  });

  it("AI 对话必须使用天将同源适配接口，不得写死外部服务地址", () => {
    const server = tapSrc("api/server.ts");
    expect(server, SENTINEL).toContain("/api/tianjiang/tapcanvas");
    expect(server, SENTINEL).toContain("/public/agents/chat");
    expect(server, SENTINEL).not.toMatch(/https?:\/\/[^'\"`]+\/public\/agents\/chat/);
  });
});
