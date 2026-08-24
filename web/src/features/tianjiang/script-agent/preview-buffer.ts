/**
 * 剧本 Agent 流式 XML 预览缓冲：按 messageId 隔离，禁止直接写 canonical planData。
 */

export interface PlanPreviewScriptItem {
  name: string;
  content: string;
}

export interface PlanPreview {
  storySkeleton: string;
  adaptationStrategy: string;
  script: PlanPreviewScriptItem[];
}

export function createEmptyPreview(): PlanPreview {
  return {
    storySkeleton: "",
    adaptationStrategy: "",
    script: [],
  };
}

export interface XmlTagPreviewInput {
  tag: string;
  value: string;
  attrs: Record<string, string>;
  status?: string;
}

/** 仅更新预览对象；不触发 setPlanData / 不触碰 canonical */
export function applyXmlTagToPreview(preview: PlanPreview, data: XmlTagPreviewInput): void {
  const { tag, value, attrs } = data;
  if (tag === "storySkeleton") {
    preview.storySkeleton = value;
  } else if (tag === "adaptationStrategy") {
    preview.adaptationStrategy = value;
  } else if (tag === "scriptItem") {
    const name = attrs.name ?? "";
    const content = value;
    if (!name) return;
    const existingIndex = preview.script.findIndex((s) => s.name === name);
    if (existingIndex !== -1) {
      preview.script[existingIndex].content = content;
    } else {
      preview.script.push({ name, content });
    }
  }
}

/** 失败/丢弃：移除指定 messageId 预览 */
export function mergePreviewDiscard(
  byMessage: Record<string, PlanPreview>,
  messageId: string,
): Record<string, PlanPreview> {
  const next = { ...byMessage };
  delete next[messageId];
  return next;
}

/** 成功提交后清空全部预览 */
export function clearAllPreviews(): Record<string, PlanPreview> {
  return {};
}
