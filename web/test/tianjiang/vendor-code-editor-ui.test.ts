import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  const absolutePath = path.join(process.cwd(), relativePath);
  return existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : "";
}

const importSource = readFileSync(
  path.join(process.cwd(), "src/components/setting/components/vendorConfig/useVendorImport.ts"),
  "utf8",
);
const editorSource = readSource(
  "src/components/setting/components/vendorConfig/useVendorCodeEditor.ts",
);
const typesSource = readFileSync(
  path.join(process.cwd(), "src/components/setting/components/vendorConfig/types.ts"),
  "utf8",
);
const dialogsSource = readFileSync(
  path.join(process.cwd(), "src/components/setting/components/vendorConfig/components/VendorImportDialogs.vue"),
  "utf8",
);

describe("供应商代码编辑器 UI 契约", () => {
  it("导入 composable 委托给独立代码编辑会话且共享文件不再堆叠实现", () => {
    expect(importSource).toContain("useVendorCodeEditor");
    expect(editorSource).toContain("export function useVendorCodeEditor");
  });

  it("编辑代码异步请求 getVendorCode 且成功后才打开对话框", () => {
    expect(editorSource).toContain("/setting/vendorConfig/getVendorCode");
    expect(editorSource).toContain("handleEditVendorCode");
    expect(editorSource).toMatch(/async function handleEditVendorCode|function handleEditVendorCode/);
    expect(editorSource).toMatch(/codeDialogVisible\.value\s*=\s*true/);
    // 打开对话框必须在校验 code 之后
    const loadIdx = editorSource.indexOf("getVendorCode");
    const openIdx = editorSource.indexOf("codeDialogVisible.value = true");
    expect(loadIdx).toBeGreaterThan(-1);
    expect(openIdx).toBeGreaterThan(loadIdx);
    expect(editorSource).not.toMatch(/vendorCode\.value\s*=\s*catalog\.currentVendor\.value\.code/);
  });

  it("失败不打开空编辑器，错误不含 object Object，可重试", () => {
    expect(editorSource).toMatch(/codeDialogVisible\.value\s*=\s*false/);
    expect(editorSource).toContain("vendorEditorErrorMessage");
    expect(editorSource).toContain("[object Object]");
    expect(editorSource).toContain("codeLoading");
  });

  it("A/B 切换丢弃迟到响应并用冻结 editingVendorId 保存", () => {
    expect(editorSource).toContain("codeLoadGeneration");
    expect(importSource).toContain("frozenVendorId");
    expect(importSource).toMatch(/id:\s*frozenVendorId/);
  });

  it("编辑模式重置恢复刚加载源码", () => {
    expect(editorSource).toContain("loadedSourceBaseline");
    expect(editorSource).toContain("handleResetVendorCode");
    expect(dialogsSource).toContain("handleResetVendorCode");
    expect(dialogsSource).not.toMatch(/vendorCode\s*=\s*VENDOR_CODE_TEMPLATE/);
  });

  it("列表响应 code 为可选字段", () => {
    expect(typesSource).toMatch(/code\?:/);
  });
});
