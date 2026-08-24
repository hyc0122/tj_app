import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import "./project-first-sync-round7.test";

function source(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("云端项目完整编辑契约", () => {
  it("云端目录编辑必须交给完整项目弹窗，禁止继续维护两字段弹窗", () => {
    const catalog = source("src/views/project/components/centralCatalog.vue");

    expect(catalog).not.toContain('v-model:visible="editVisible"');
    expect(catalog).not.toContain("const editForm = reactive");
    expect(catalog).toMatch(/emit\(["']edit["']/);
  });

  it("新建与编辑必须共用完整字段，编辑态仍展示但锁定项目归属", () => {
    const dialog = source(
      "src/views/project/components/projectDialog/components/ProjectFormDialog.vue",
    );
    const types = source("src/views/project/components/projectDialog/types.ts");

    expect(dialog).not.toContain('v-if="!isEdit"');
    expect(dialog).toContain(':disabled="isEdit"');
    expect(types).toContain("projectUuid: string");
    expect(types).toContain('kind: "personal" | "team"');
    expect(types).toContain("teamUuid: string");
  });

  it("项目页必须接收云端编辑事件并先加载完整本地项目字段", () => {
    const page = source("src/views/project/index.vue");

    expect(page).toContain('@edit="openCatalogEdit"');
    expect(page).toContain("openCatalogProject");
    expect(page).toContain("getSingleProject");
    expect(page).toContain("catalogEditContext");
  });
});
