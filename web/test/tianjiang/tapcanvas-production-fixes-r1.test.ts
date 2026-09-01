import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));

function tapSrc(relative: string): string {
  return readFileSync(path.resolve(here, "../../tapcanvas/src", relative), "utf8");
}

function appSrc(relative: string): string {
  return readFileSync(path.resolve(here, "../../../app/src", relative), "utf8");
}

describe("TapCanvas 正式环境合同", () => {
  it("导演台模型必须走 BASE_URL / tapcanvasAssetUrl，禁止站点根 /director", () => {
    const assets = tapSrc("canvas/nodes/directorConsole/assets.ts");
    expect(assets).toContain("tapcanvasAssetUrl");
    expect(assets).not.toMatch(/['"]\/director\/xbot\.glb['"]/);
    const helper = tapSrc("tianjiang/tapcanvasAssetUrl.ts");
    expect(helper).toContain("BASE_URL");
  });

  it("连接点偏移必须贴边", () => {
    const helpers = tapSrc("canvas/nodes/taskNodeHelpers.ts");
    expect(helpers).toMatch(/HANDLE_HORIZONTAL_OFFSET\s*=\s*0/);
    expect(helpers).toMatch(/HANDLE_VERTICAL_OFFSET\s*=\s*0/);
    expect(helpers).not.toMatch(/HANDLE_HORIZONTAL_OFFSET\s*=\s*36/);
  });

  it("兼容层必须实现前端正式路径而不是只提供错误旧路径", () => {
    const route = appSrc("routes/tianjiang/tapcanvas-compat.ts");
    expect(route).toContain('"/projects/public"');
    expect(route).toContain('"/auth/generation-preferences"');
    expect(route).toContain('"/codex/bridges"');
    expect(route).toContain('"/codex/tasks"');
    expect(route).toContain('"/codex/pairings"');
    expect(route).toContain('"/memory/context"');
    expect(route).toContain('"/memory/project-chat-artifacts"');
    expect(route).toContain("canvasRevision");
    expect(route).toContain("flow_revision_conflict");
    expect(route).toContain("dataAdjusted");
  });

  it("readiness 不得返回非法 URL 或 null recommendedProvider", () => {
    const route = appSrc("routes/tianjiang/tapcanvas-compat.ts");
    expect(route).not.toMatch(/recommendedProvider:\s*null/);
    expect(route).not.toContain('setupUrl: "/settings/model-service"');
    expect(route).toContain("https://");
  });

  it("首页一句话规划必须传独立 prompt，不能再把项目名冒充或丢弃规划输入", () => {
    const hub = tapSrc("portal/CanvasHubPage.tsx");
    const api = tapSrc("api/server.ts");
    expect(hub).toMatch(/bootstrapProjectFlow\(\{[\s\S]*?name:\s*prompt,\s*prompt,/);
    expect(api).toMatch(/bootstrapProjectFlow\(payload:\s*\{[\s\S]*?prompt\??:\s*string/);
    expect(api).toMatch(/prompt:\s*payload\.prompt/);
  });

  it("右侧 AI 的真实 canvasProjectId 必须由后端消费，SSE 必须具备稳定身份与事件游标", () => {
    const route = appSrc("routes/tianjiang/tapcanvas-compat.ts");
    expect(route).toContain("req.body?.canvasProjectId");
    expect(route).toContain('res.setHeader("X-Trace-ID"');
    expect(route).toMatch(/id:\s*\$\{turnId\}#/);
    expect(route).toContain('"/public/agents/chat/status"');
  });
});
