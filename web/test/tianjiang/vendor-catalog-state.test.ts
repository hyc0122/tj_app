import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("供应商目录状态机", () => {
  const catalog = readFileSync(
    path.join(process.cwd(), "src/components/setting/components/vendorConfig/useVendorCatalog.ts"),
    "utf8",
  );
  const workspace = readFileSync(
    path.join(
      process.cwd(),
      "src/components/setting/components/vendorConfig/components/VendorWorkspace.vue",
    ),
    "utf8",
  );

  it("首次加载必须显式 await 当前供应商，并用请求代次防竞态", () => {
    expect(catalog).toContain("listGeneration");
    expect(catalog).toContain("vendorLoadGenerations");
    expect(catalog).toMatch(/onMounted\s*\(\s*async\s*\(\)\s*=>\s*\{[\s\S]*await getVendorList\(\)/);
    expect(catalog).toContain("await loadVendorSecrets");
  });

  it("只有 error 状态显示加载失败；idle 为请选择供应商；loading 为加载中", () => {
    expect(workspace).toContain("vendorLoadState.state === 'error'");
    expect(workspace).toContain("loadInputsFailed");
    expect(workspace).toContain("vendorLoadState.state === 'loading'");
    expect(workspace).toMatch(/加载中|loading/);
    expect(workspace).toContain("selectVendorFirst");
    // idle 分支不得再错误使用 loadInputsFailed 作为默认 empty 文案。
    const idleBranch = workspace.match(
      /v-else-if="vendorLoadState\.state === 'loading'"[\s\S]*?<t-empty[^>]*description="([^"]+)"/,
    );
    expect(idleBranch?.[1] ?? "").toContain("selectVendorFirst");
    expect(idleBranch?.[1] ?? "").not.toContain("loadInputsFailed");
  });
});
