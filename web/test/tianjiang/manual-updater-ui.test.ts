import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("手动更新 UI 契约", () => {
  it("about 页调用固定本地动作且不提交 url", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/components/setting/components/about.vue"),
      "utf8",
    );
    expect(source).toContain('action: "check"');
    expect(source).toContain("download-differential");
    expect(source).toContain("download-full");
    expect(source).toContain("install");
    expect(source).not.toMatch(/downloadApp",\s*\{\s*url:/);
  });
});
