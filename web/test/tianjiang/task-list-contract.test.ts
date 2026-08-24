import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  path.join(process.cwd(), "src/views/taskList/index.vue"),
  "utf8",
);

describe("任务列表契约", () => {
  it("必须请求已注册的 getTaskApi 且禁止 getMyTaskApi", () => {
    expect(source).toContain("/task/getTaskApi");
    expect(source).not.toContain("getMyTaskApi");
  });

  it("查询、重置、页码与每页数量变化都会重新请求", () => {
    expect(source).toMatch(/onSearch|@click="onSearch"/);
    expect(source).toMatch(/onReset|@click="onReset"/);
    expect(source).toMatch(/onPageChange|onPageSizeChange/);
    expect(source).toMatch(/void getTaskList\(\)|getTaskList\(\)/);
  });

  it("保留 projectId、taskClass、state 筛选语义", () => {
    expect(source).toMatch(/projectId:\s*projectId\.value/);
    expect(source).toMatch(/taskClass:\s*taskClass\.value/);
    expect(source).toMatch(/state:\s*state\.value/);
  });

  it("空列表正常 0 条且用请求序号抑制重复错误提示", () => {
    expect(source).toMatch(/total:\s*0/);
    expect(source).toMatch(/listRequestSeq|seq !== listRequestSeq/);
    expect(source).toMatch(/Array\.isArray\(data\?\.data\)/);
  });
});
