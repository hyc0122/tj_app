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

describe("右侧 AI 对话面板合同", () => {
  it("编辑器必须接入可收起/全屏/恢复/拖宽的右侧 AI 面板与会话作曲器", () => {
    const haystack = [
      webSrc("views/infiniteCanvas/editor.vue"),
      webSrc("views/infiniteCanvas/components/ai/CanvasAiPanel.vue"),
      webSrc("views/infiniteCanvas/components/ai/CanvasConversationList.vue"),
      webSrc("views/infiniteCanvas/components/ai/CanvasChatTimeline.vue"),
      webSrc("views/infiniteCanvas/components/ai/CanvasChatComposer.vue"),
      webSrc("views/infiniteCanvas/components/ai/CanvasPlanPreview.vue"),
      webSrc("features/tianjiang/canvas/useCanvasAiSession.ts"),
      webSrc("features/tianjiang/canvas/api.ts"),
    ].join("\n");
    const required = [
      "CanvasAiPanel",
      "CanvasConversationList",
      "CanvasChatTimeline",
      "CanvasChatComposer",
      "CanvasPlanPreview",
      "docked",
      "collapsed",
      "fullscreen",
      "restore",
      "resize",
      "drawer",
      "newChat",
      "history",
      "shortcut",
      "skill",
      "modelId",
      "txt",
      "docx",
      "voice",
      "isComposing",
      "Shift+Enter",
      "clientChatRequestId",
      "requestDigest",
      "/tianjiang/runtime/projects/",
      "canvas/chat",
      "done",
      "delta",
    ];
    const missing = required.filter((token) => !haystack.includes(token));
    if (missing.length !== 0 || haystack.includes("/api/api/") || haystack.includes("v-html")) {
      console.error(SENTINEL);
      expect(missing, SENTINEL).toEqual([]);
    }
  });

  it("普通 SSE delta 不得改图，完整 done 前不得展示可应用计划，聊天计划不得自动应用", () => {
    const session = webSrc("features/tianjiang/canvas/useCanvasAiSession.ts");
    const preview = webSrc("views/infiniteCanvas/components/ai/CanvasPlanPreview.vue");
    if (
      !session.includes("autoApply")
      || !session.includes("false")
      || !session.includes("completeDone")
      || !preview.includes("applyPlan")
      || session.includes("applyCanvasPlan(") && session.includes("source: \"chat\"") && session.includes("auto")
    ) {
      console.error(SENTINEL);
      expect(session.includes("completeDone"), SENTINEL).toBe(true);
      expect(preview.includes("applyPlan"), SENTINEL).toBe(true);
    }
  });
});
