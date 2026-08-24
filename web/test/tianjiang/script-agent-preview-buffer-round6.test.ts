/**
 * 第 6 轮：预览缓冲与正式 planData 隔离（纯逻辑）
 */
import { describe, expect, it } from "vitest";
import {
  applyXmlTagToPreview,
  createEmptyPreview,
  mergePreviewDiscard,
  type PlanPreview,
} from "@/features/tianjiang/script-agent/preview-buffer";

describe("scriptAgent preview buffer", () => {
  it("onXmlTag 只写按 messageId 隔离的预览，不返回应写入 canonical 的信号", () => {
    const byMessage: Record<string, PlanPreview> = {};
    const mid = "msg-1";
    byMessage[mid] = createEmptyPreview();
    applyXmlTagToPreview(byMessage[mid], {
      tag: "storySkeleton",
      value: "预览骨架",
      attrs: {},
      status: "streaming",
    });
    expect(byMessage[mid].storySkeleton).toBe("预览骨架");
    // 另一 message 互不影响
    byMessage["msg-2"] = createEmptyPreview();
    expect(byMessage["msg-2"].storySkeleton).toBe("");
  });

  it("失败丢弃预览后不残留数据", () => {
    const byMessage: Record<string, PlanPreview> = {
      "msg-err": {
        storySkeleton: "半成品",
        adaptationStrategy: "",
        script: [{ name: "EP01", content: "x" }],
      },
    };
    const next = mergePreviewDiscard(byMessage, "msg-err");
    expect(next["msg-err"]).toBeUndefined();
    expect(Object.keys(next)).toHaveLength(0);
  });

  it("scriptItem 写入预览列表", () => {
    const preview = createEmptyPreview();
    applyXmlTagToPreview(preview, {
      tag: "scriptItem",
      value: "对白A",
      attrs: { name: "EP01" },
      status: "complete",
    });
    expect(preview.script).toEqual([{ name: "EP01", content: "对白A" }]);
    // complete 不得暗示调用 setPlanData — 本模块无副作用
    applyXmlTagToPreview(preview, {
      tag: "scriptItem",
      value: "对白B",
      attrs: { name: "EP01" },
      status: "complete",
    });
    expect(preview.script).toHaveLength(1);
    expect(preview.script[0].content).toBe("对白B");
  });
});
