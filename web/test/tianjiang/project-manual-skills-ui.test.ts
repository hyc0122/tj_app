import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("项目手册与 Skills 账号隔离 UI 契约", () => {
  it("手册加载失败显示错误与重试入口", () => {
    const form = readFileSync(
      path.join(process.cwd(), "src/views/project/components/projectDialog/components/ProjectFormDialog.vue"),
      "utf8",
    );
    const visual = readFileSync(
      path.join(process.cwd(), "src/views/project/components/projectDialog/useVisualManual.ts"),
      "utf8",
    );
    const director = readFileSync(
      path.join(process.cwd(), "src/views/project/components/projectDialog/useDirectorManual.ts"),
      "utf8",
    );
    expect(visual).toContain("visualManualError");
    expect(director).toContain("directorManualError");
    expect(form).toContain("visualManualError");
    expect(form).toContain("directorManualError");
    expect(form).toContain("fetchVisualManuals");
    expect(form).toContain("queryDirectorManual");
    expect(form).toContain("ProjectManualPicker");
    const picker = readFileSync(
      path.join(process.cwd(), "src/views/project/components/projectDialog/components/ProjectManualPicker.vue"),
      "utf8",
    );
    expect(picker).toMatch(/重试|retry/);
  });

  it("选中值使用 stylePath/directorManual 相对标识", () => {
    const form = readFileSync(
      path.join(process.cwd(), "src/views/project/components/projectDialog/components/ProjectFormDialog.vue"),
      "utf8",
    );
    expect(form).toContain("formState.artStyle = $event");
    expect(form).toContain("formState.directorManual = $event");
    expect(form).toContain("visualManualKey");
    expect(form).toContain("directorManualKey");
  });
});
