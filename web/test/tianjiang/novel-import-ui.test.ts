import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  path.join(process.cwd(), "src/views/novel/components/importNovel.vue"),
  "utf8",
);
const listSource = readFileSync(
  path.join(process.cwd(), "src/views/novel/index.vue"),
  "utf8",
);

describe("小说导入 UI 接线契约", () => {
  it("保存前使用 normalizeNovelProjectIdInput 并以 JSON number 发送 projectId", () => {
    expect(source).toContain("normalizeNovelProjectIdInput");
    expect(source).toContain("projectId");
    expect(source).toMatch(/normalizeNovelProjectIdInput\(/);
    // 不得直接把 store 字符串 id 塞进 body
    expect(source).not.toMatch(/projectId:\s*project\.value\?\.id\s*,/);
  });

  it("解析出新章节集时默认全选，且不依赖无关渲染", () => {
    expect(source).toContain("allChapterRowKeys");
    expect(source).toMatch(/selectedRowKeys\.value\s*=\s*allChapterRowKeys/);
    expect(source).toMatch(/chapterSignature|签名|signature/);
  });

  it("失败提示走 novelImportErrorMessage，且失败不关弹窗", () => {
    expect(source).toContain("novelImportErrorMessage");
    expect(source).not.toMatch(/\$message\.error\(\(e as Error\)\.message\)/);
    // 成功路径才关闭；keep 的 catch 不得关闭弹窗
    const keepFn = source.slice(
      source.indexOf("async function keep"),
      source.indexOf("watch(purgeNovelShow"),
    );
    const keepCatch = keepFn.slice(keepFn.indexOf("} catch (e)"));
    expect(keepCatch).not.toMatch(/purgeNovelShow\.value\s*=\s*false/);
    expect(keepCatch).toContain("novelImportErrorMessage");
  });

  it("导入成功必须 await confirmVisible 后再提示成功", () => {
    expect(source).toContain("confirmVisible");
    expect(source).toMatch(/await props\.confirmVisible/);
    expect(source).toMatch(/saveSuccess/);
    // 禁止在 await 列表前先 success
    const keepFn = source.slice(source.indexOf("async function keep"), source.indexOf("watch(purgeNovelShow"));
    const successIdx = keepFn.indexOf("saveSuccess");
    const confirmIdx = keepFn.indexOf("confirmVisible");
    expect(confirmIdx).toBeGreaterThan(-1);
    expect(successIdx).toBeGreaterThan(confirmIdx);
  });

  it("列表侧 getNovel 使用同一数字 projectId 并解析统一响应结构", () => {
    expect(listSource).toContain("normalizeNovelProjectIdInput");
    expect(listSource).toContain("parseNovelListResponse");
    expect(listSource).toContain("confirmImportVisible");
    expect(listSource).toMatch(/resetPage:\s*true/);
    expect(listSource).toMatch(/clearSearch:\s*true/);
  });

  it("App addNovel/getNovel 路由要求正安全整数且无 coerce", () => {
    const addRoute = readFileSync(
      path.join(process.cwd(), "../app/src/routes/novel/addNovel.ts"),
      "utf8",
    );
    const getRoute = readFileSync(
      path.join(process.cwd(), "../app/src/routes/novel/getNovel.ts"),
      "utf8",
    );
    expect(addRoute).toMatch(/projectId:\s*z\.number\(\)/);
    expect(addRoute).toMatch(/\.positive\(\)/);
    expect(addRoute).toContain("transaction");
    expect(addRoute).toContain("insertedIds");
    expect(addRoute).not.toMatch(/projectId:\s*z\.coerce/);
    expect(getRoute).toMatch(/projectId:\s*z\.number\(\)/);
    expect(getRoute).toMatch(/\.positive\(\)/);
    expect(getRoute).not.toMatch(/projectId:\s*z\.coerce/);
  });

  it("行为：confirmVisible=false 时不提示成功且不关弹窗；true 时才成功关闭", async () => {
    // 从 keep() 源码抽取关键路径顺序：addNovel → confirmVisible → saveSuccess → close
    const keepFn = source.slice(
      source.indexOf("async function keep"),
      source.indexOf("watch(purgeNovelShow"),
    );
    const addIdx = keepFn.indexOf('"/novel/addNovel"');
    const confirmIdx = keepFn.indexOf("confirmVisible");
    const notVisibleIdx = keepFn.indexOf("savedButHidden");
    const successIdx = keepFn.indexOf("saveSuccess");
    const closeIdx = keepFn.indexOf("purgeNovelShow.value = false");
    expect(addIdx).toBeGreaterThan(-1);
    expect(confirmIdx).toBeGreaterThan(addIdx);
    expect(notVisibleIdx).toBeGreaterThan(confirmIdx);
    expect(successIdx).toBeGreaterThan(notVisibleIdx);
    expect(closeIdx).toBeGreaterThan(successIdx);
    // 失败 catch 分支不得 close / success
    const catchPart = keepFn.slice(keepFn.indexOf("} catch (e)"));
    expect(catchPart).not.toContain("saveSuccess");
    expect(catchPart).not.toMatch(/purgeNovelShow\.value\s*=\s*false/);
  });
});
