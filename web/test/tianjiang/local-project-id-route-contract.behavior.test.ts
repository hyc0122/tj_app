/**
 * AST 门禁：逐请求检查 axios.post / Socket auth 的 projectId 是否经边界函数。
 * 白名单仅列明确中央/任务/透传封装文件；禁止 features/tianjiang 整目录放行。
 * 扫描实现见 helpers/local-project-id-ast-scanner.ts（作用域敏感，禁止文件级安全名 Set）。
 * @vitest-environment node
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseSfc } from "@vue/compiler-sfc";
import { toLocalProjectId, LocalProjectIdError } from "@/features/tianjiang/project/local-project-id";
import { formatOffenses, scanTypeScriptSource } from "./helpers/local-project-id-ast-scanner";

const webSrc = path.resolve(__dirname, "../../src");

/** 仅明确中央 API / 任务筛选 / auth 透传封装例外（含原因） */
const ALLOWLIST_FILES: Array<{ rel: string; reason: string }> = [
  {
    rel: "views/taskList/index.vue",
    reason: "账号级任务中心筛选兼容 projectId/projectUuid，禁止强制本地数字转换",
  },
  {
    rel: "features/tianjiang/project/local-project-id.ts",
    reason: "边界叶子实现本身",
  },
  {
    rel: "utils/useSocket.ts",
    reason: "Socket 连接封装透传 authOptions；projectId 由调用方 store 注入并经 toLocalProjectId",
  },
  {
    rel: "utils/useChat.ts",
    reason: "Chat 封装透传 auth；projectId 由调用方注入并经官方边界",
  },
];

const allowSet = new Set(ALLOWLIST_FILES.map((a) => a.rel.replace(/\\/g, "/")));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      walk(full, out);
    } else if (/\.(ts|vue|tsx)$/.test(name) && !name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

function extractScripts(file: string): Array<{ text: string; offsetLine: number }> {
  const raw = fs.readFileSync(file, "utf8");
  if (file.endsWith(".vue")) {
    const { descriptor } = parseSfc(raw, { filename: file });
    const blocks: Array<{ text: string; offsetLine: number }> = [];
    for (const block of [descriptor.script, descriptor.scriptSetup]) {
      if (!block?.content) continue;
      const before = raw.slice(0, block.loc.start.offset);
      const offsetLine = before.split(/\r?\n/).length;
      blocks.push({ text: block.content, offsetLine });
    }
    return blocks;
  }
  return [{ text: raw, offsetLine: 1 }];
}

describe("AST 门禁：axios/Socket 本地 projectId 必须经边界", () => {
  it("扫描 web/src 请求体/auth 无裸传 Project.id", () => {
    const offenders: string[] = [];
    for (const full of walk(webSrc)) {
      const rel = path.relative(webSrc, full).replace(/\\/g, "/");
      if (allowSet.has(rel)) continue;
      for (const block of extractScripts(full)) {
        const result = scanTypeScriptSource(rel, block.text, block.offsetLine);
        offenders.push(...formatOffenses(result));
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("taskList 不得使用 toLocalProjectId（反向：中央/筛选例外）", () => {
    const taskList = fs.readFileSync(path.join(webSrc, "views/taskList/index.vue"), "utf8");
    expect(taskList).not.toMatch(/toLocalProjectId\s*\(/);
    expect(taskList).not.toMatch(/localProjectBody\s*\(/);
  });

  it("白名单不包含 features/tianjiang 整目录，仅叶子文件", () => {
    expect(ALLOWLIST_FILES.some((a) => a.rel === "features/tianjiang")).toBe(false);
    expect(
      ALLOWLIST_FILES.filter((a) => a.rel.startsWith("features/tianjiang/")).every(
        (a) => a.rel === "features/tianjiang/project/local-project-id.ts",
      ),
    ).toBe(true);
  });

  it("projectUuid 不得被 toLocalProjectId 转换（反向）", () => {
    expect(() => toLocalProjectId("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")).toThrow(LocalProjectIdError);
  });
});
