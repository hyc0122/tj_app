import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { isLegacyProjectMutation } from "@/features/tianjiang/project/access";

describe("任务中心前端门禁与页面契约", () => {
  it("三个任务读取 POST 不得被判为写操作；写任务路由仍为写", () => {
    expect(isLegacyProjectMutation("POST", "/task/getTaskApi")).toBe(false);
    expect(isLegacyProjectMutation("POST", "/task/getTaskCategories")).toBe(false);
    expect(isLegacyProjectMutation("POST", "/task/getProject")).toBe(false);
    expect(isLegacyProjectMutation("POST", "/api/task/getTaskApi")).toBe(false);
    expect(isLegacyProjectMutation("POST", "/task/retryRemoteTask")).toBe(true);
  });

  it("页面使用 projectUuid 筛选、rowKey 防冲突，列表失败最多一次提示", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/views/task/index.vue"),
      "utf8",
    );
    expect(source).toContain("projectUuid");
    expect(source).toContain('row-key="rowKey"');
    expect(source).toContain("listErrorNotified");
    expect(source).toContain("/task/getTaskApi");
    // 不得再默认把活动项目数字 id 塞进筛选
    expect(source).not.toMatch(/projectId:\s*projectId\.value\s*\|\|\s*project\.value/);
  });
});
