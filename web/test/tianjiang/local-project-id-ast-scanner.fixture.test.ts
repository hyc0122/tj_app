/**
 * AST 扫描器自身灵敏度 fixture：证明作用域隔离、body 变量、spread、伪边界与多分支 auth。
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import {
  formatOffenses,
  scanTypeScriptSource,
} from "./helpers/local-project-id-ast-scanner";

const OFFICIAL = {
  assumeOfficialGlobals: [
    "toLocalProjectId",
    "localProjectBody",
    "normalizeNovelProjectIdInput",
    "toNovelProjectId",
  ],
};

function scan(code: string) {
  return formatOffenses(scanTypeScriptSource("fixture.ts", code, 1, OFFICIAL));
}

describe("local-project-id AST scanner fixtures", () => {
  it("同文件 good 安全绑定不得污染 bad 参数简写 projectId", () => {
    const offenses = scan(`
function good(raw: unknown) {
  const projectId = toLocalProjectId(raw);
  axios.post("/good", { projectId });
}
function bad(projectId: string) {
  axios.post("/x", { projectId });
}
`);
    expect(offenses.some((o) => o.includes("bad") || o.includes("/x") || o.includes("简写")), offenses.join("\n")).toBe(
      true,
    );
    // good 路径不得误报
    expect(offenses.filter((o) => o.includes("/good"))).toEqual([]);
  });

  it("同一函数内安全别名 projectId: localId 必须通过", () => {
    const offenses = scan(`
function f(raw: unknown) {
  const localId = toLocalProjectId(raw);
  axios.post("/x", { projectId: localId });
}
`);
    expect(offenses, offenses.join("\n")).toEqual([]);
  });

  it("axios.post 第二参为含裸 projectId 的 body 变量必须报告", () => {
    const offenses = scan(`
function f(raw: string) {
  const bodyVariable = { projectId: raw };
  axios.post("/x", bodyVariable);
}
`);
    expect(offenses.length, offenses.join("\n")).toBeGreaterThan(0);
    expect(offenses.some((o) => /bodyVariable|请求体变量/.test(o))).toBe(true);
  });

  it("axios.post 对象展开 ...unsafeBody 必须报告，禁止静默 continue", () => {
    const offenses = scan(`
function f(unsafeBody: Record<string, unknown>) {
  axios.post("/x", { ...unsafeBody });
}
`);
    expect(offenses.length, offenses.join("\n")).toBeGreaterThan(0);
    expect(offenses.some((o) => /展开|spread|\.\.\./i.test(o) || o.includes("unsafeBody"))).toBe(true);
  });

  it("局部同名 toLocalProjectId 不得被识别为官方安全边界", () => {
    const offenses = scan(`
function toLocalProjectId(v: unknown) { return v; }
function f(raw: string) {
  const projectId = toLocalProjectId(raw);
  axios.post("/x", { projectId });
}
`);
    expect(offenses.length, offenses.join("\n")).toBeGreaterThan(0);
  });

  it("Socket auth 嵌套 if/else 每个 return 分支都必须检查", () => {
    const offenses = scan(`
function connect(raw: string, ok: unknown) {
  const opts = {
    auth: () => {
      if (raw) {
        return { projectId: raw };
      } else {
        return { projectId: toLocalProjectId(ok) };
      }
    },
  };
  return opts;
}
`);
    expect(offenses.length, offenses.join("\n")).toBeGreaterThan(0);
    expect(offenses.some((o) => o.includes("socket.auth") || o.includes("projectId"))).toBe(true);
    // 安全分支单独出现时不得误报
    const onlySafe = scan(`
function connect(ok: unknown) {
  const opts = {
    auth: () => {
      if (ok) {
        return { projectId: toLocalProjectId(ok) };
      }
      return { projectId: toLocalProjectId(ok) };
    },
  };
  return opts;
}
`);
    expect(onlySafe, onlySafe.join("\n")).toEqual([]);
  });

  it("同文件一正确一裸传：只报告裸传，证明无文件级跳过", () => {
    const offenses = scan(`
function ok(raw: unknown) {
  const projectId = toLocalProjectId(raw);
  axios.post("/ok", { projectId });
}
function bare(project: { id: string }) {
  axios.post("/bare", { projectId: project.id });
}
`);
    expect(offenses.some((o) => o.includes("/bare") || o.includes("project.id") || o.includes("疑似") || o.includes("裸")), offenses.join("\n")).toBe(
      true,
    );
    expect(offenses.filter((o) => o.includes("/ok"))).toEqual([]);
  });
});
