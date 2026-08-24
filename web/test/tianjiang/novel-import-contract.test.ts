import { describe, expect, it } from "vitest";
import {
  allChapterRowKeys,
  normalizeNovelProjectIdInput,
  novelImportErrorMessage,
  novelListHasVisibleRows,
  parseNovelListResponse,
  toNovelProjectId,
} from "@/views/novel/components/novel-import-contract";

describe("小说导入契约", () => {
  it("toNovelProjectId 最终层只接受 number 正安全整数，拒绝字符串与非法值", () => {
    expect(toNovelProjectId(42)).toBe(42);
    expect(() => toNovelProjectId("42")).toThrow(/项目编号无效/);
    expect(() => toNovelProjectId(" 42 ")).toThrow(/项目编号无效/);
    expect(() => toNovelProjectId(0)).toThrow(/项目编号无效/);
    expect(() => toNovelProjectId(-1)).toThrow(/项目编号无效/);
    expect(() => toNovelProjectId(1.5)).toThrow(/项目编号无效/);
    expect(() => toNovelProjectId(Number.NaN)).toThrow(/项目编号无效/);
    expect(() => toNovelProjectId(Number.MAX_SAFE_INTEGER + 1)).toThrow(/项目编号无效/);
    expect(() => toNovelProjectId(undefined)).toThrow(/项目编号无效/);
  });

  it("normalizeNovelProjectIdInput 可规范纯数字串，空白串按全局本地 ID 契约拒绝，输出再经 toNovelProjectId", () => {
    expect(normalizeNovelProjectIdInput(9)).toBe(9);
    expect(normalizeNovelProjectIdInput("42")).toBe(42);
    expect(normalizeNovelProjectIdInput("9")).toBe(9);
    expect(() => normalizeNovelProjectIdInput(" 42 ")).toThrow(/项目编号无效/);
    expect(() => normalizeNovelProjectIdInput("0")).toThrow(/项目编号无效/);
    expect(() => normalizeNovelProjectIdInput("x")).toThrow(/项目编号无效/);
    // 最终层契约：规范化结果必须能通过只接受 number 的 toNovelProjectId
    expect(toNovelProjectId(normalizeNovelProjectIdInput("42"))).toBe(42);
  });

  it("allChapterRowKeys 返回全部章节 index", () => {
    expect(allChapterRowKeys([{ index: 1 }, { index: 3 }])).toEqual([1, 3]);
    expect(allChapterRowKeys([])).toEqual([]);
  });

  it("parseNovelListResponse 兼容多层 data 且不混用 list/total", () => {
    const nested = parseNovelListResponse({
      code: 200,
      data: { data: [{ id: 1 }], total: 1 },
      message: "成功",
    });
    expect(nested.rows).toEqual([{ id: 1 }]);
    expect(nested.total).toBe(1);

    const page = parseNovelListResponse({ data: [{ id: 2 }, { id: 3 }], total: "2" });
    expect(page.rows).toHaveLength(2);
    expect(page.total).toBe(2);

    const listShape = parseNovelListResponse({ list: [{ id: 4 }], total: 1 });
    expect(listShape.rows).toEqual([{ id: 4 }]);
    expect(novelListHasVisibleRows(nested)).toBe(true);
    expect(novelListHasVisibleRows({ rows: [], total: 0 })).toBe(false);
  });

  it("错误归一化为安全中文，禁止 object Object", () => {
    expect(novelImportErrorMessage({ message: { code: "BAD" } })).toBe(
      "导入小说失败，请检查项目后重试",
    );
    expect(novelImportErrorMessage({})).not.toMatch(/\[object Object\]/);
    expect(novelImportErrorMessage(new Error("项目编号无效，请返回项目目录重新打开"))).toBe(
      "项目编号无效，请返回项目目录重新打开",
    );
    expect(novelImportErrorMessage(new Error("C:\\private\\x.sqlite failed"))).toBe(
      "导入小说失败，请检查项目后重试",
    );
    expect(novelImportErrorMessage({ message: "https://evil.example/api" })).toBe(
      "导入小说失败，请检查项目后重试",
    );
    expect(novelImportErrorMessage({ message: "Bearer token-should-not-leak" })).toBe(
      "导入小说失败，请检查项目后重试",
    );
  });
});
