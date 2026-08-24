// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("新建项目并行加载图片/视频目录", () => {
  it("useProjectForm 并行请求 image 与 video catalog", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/views/project/components/projectDialog/useProjectForm.ts"),
      "utf8",
    );
    expect(source).toMatch(/ensure\([^)]*image/);
    expect(source).toMatch(/ensure\([^)]*video/);
    expect(source).toMatch(/Promise\.all/);
  });
});
