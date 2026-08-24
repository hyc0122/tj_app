// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("设置页运行时回归", () => {
  it("同步状态走 REST 且无伪协议", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/views/settings/index.vue"),
      "utf8",
    );
    expect(source).not.toContain("tianjiang://profileSyncStatus");
    expect(source).toContain("/tianjiang/runtime/profile-sync/status");
    expect(source).toContain("/tianjiang/runtime/profile-sync/retry");
  });

  it("设置菜单选中态使用主题变量", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/components/setting/index.vue"),
      "utf8",
    );
    expect(source).toMatch(/--td-brand-color-light/);
    expect(source).not.toMatch(/background(?:-color)?\s*:\s*#000\b/);
  });

  it("workbench 左下角导航激活态禁止硬编码 #000/black，使用品牌 token", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/pages/workbench/index.vue"),
      "utf8",
    );
    expect(source).not.toMatch(/\.footItem[\s\S]*?\.active\s*\{[^}]*#000\b/i);
    expect(source).not.toMatch(/\.footItem[\s\S]*?\.active\s*\{[^}]*\bblack\b/i);
    expect(source).toMatch(/\.footItem[\s\S]*?\.active\s*\{[^}]*--td-brand-color/);
  });

  it("检查更新页已删除许可证卡片", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/components/setting/components/about.vue"),
      "utf8",
    );
    expect(source).not.toContain("Apache-2.0 License");
    expect(source).not.toMatch(/class="license"/);
  });

  it("供应商加载按供应商记录状态并取消过期列表请求", () => {
    const catalog = readFileSync(
      path.join(process.cwd(), "src/components/setting/components/vendorConfig/useVendorCatalog.ts"),
      "utf8",
    );
    const workspace = readFileSync(
      path.join(process.cwd(), "src/components/setting/components/vendorConfig/components/VendorWorkspace.vue"),
      "utf8",
    );
    expect(catalog).toContain("vendorLoadStates");
    expect(catalog).toContain("AbortController");
    expect(catalog).toContain("signal: listAbortController.signal");
    expect(catalog).toContain('state: "error"');
    expect(workspace).toContain("vendorLoadState.state === 'error'");
    expect(workspace).toContain("retryVendorLoad");
    expect(workspace).toContain("selectVendorFirst");
    expect(catalog).toMatch(/await getVendorList\(\)/);
  });
});
