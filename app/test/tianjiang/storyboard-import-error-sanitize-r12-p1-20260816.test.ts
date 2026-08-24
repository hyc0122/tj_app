/**
 * R12 追加 RED：导入公开错误不得回显路径、SQL、堆栈或内部原文。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { toPublicImportError } from "../../src/routes/tianjiang/storyboard-http";

const LEAK_CASES: Array<{ title: string; message: string; code?: string }> = [
  { title: "Windows 任意盘符反斜杠路径", message: "E:\\secret\\db.sqlite" },
  { title: "Windows 正斜杠路径", message: "E:/secret/db.sqlite" },
  { title: "UNC 路径", message: "\\\\fileserver\\share\\db.sqlite" },
  { title: "POSIX 绝对路径", message: "/home/user/db.sqlite" },
  { title: "SQL 语句", message: "SELECT * FROM o_storyboardShot WHERE id = 1" },
  { title: "SQLite 内部错误", message: "SQLITE_ERROR: no such column: evilColumn" },
  { title: "堆栈", message: "boom\n    at commitImportRows (storyboard-service.ts:339:17)" },
  { title: "普通未知内部错误", message: "unexpected pool timeout while opening project.sqlite" },
];

test("导入公开错误不得返回路径/SQL/堆栈/内部原文", () => {
  for (const item of LEAK_CASES) {
    const error = Object.assign(new Error(item.message), item.code ? { code: item.code } : {});
    const published = toPublicImportError(error);
    const serialized = JSON.stringify(published);
    assert.equal(
      serialized.includes(item.message),
      false,
      `${item.title} 不得返回原文，实际 ${serialized}`,
    );
    assert.equal(published.message, "分镜导入导出失败", `${item.title} 必须使用通用失败文案`);
  }
});

test("已知稳定导入错误码仍映射公开中文文案", () => {
  const published = toPublicImportError(Object.assign(new Error("ignored leak E:\\\\secret\\\\db.sqlite"), {
    status: 409,
    code: "STORYBOARD_IMPORT_CONTENT_CHANGED",
  }));
  assert.equal(published.code, "STORYBOARD_IMPORT_CONTENT_CHANGED");
  assert.equal(published.message, "导入内容已变化，请重新预览");
  assert.equal(published.message.includes("E:"), false);
});
