/**
 * 本地项目 ID 边界：字符串 "101" → number 101；非法值失败关闭。
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import {
  LocalProjectIdError,
  localProjectBody,
  toLocalProjectId,
  toPositiveSafeInteger,
  tryLocalProjectId,
} from "@/features/tianjiang/project/local-project-id";

describe("toLocalProjectId 边界", () => {
  it("接受正安全整数 number 与纯数字字符串", () => {
    expect(toLocalProjectId(101)).toBe(101);
    expect(toLocalProjectId("101")).toBe(101);
    expect(toLocalProjectId(1)).toBe(1);
  });

  it("拒绝空值、0、负数、小数、科学计数、前后空白、对象、NaN", () => {
    for (const bad of [
      null,
      undefined,
      "",
      "  ",
      " 101 ",
      "101 ",
      " 101",
      0,
      -1,
      1.5,
      "1.5",
      "1e2",
      "01",
      {},
      [],
      NaN,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => toLocalProjectId(bad), String(bad)).toThrow(LocalProjectIdError);
    }
  });
});

describe("localProjectBody", () => {
  it("将 projectId 规范为 number 并合并额外字段", () => {
    expect(localProjectBody("101", { agentType: "productionAgent", episodesId: 7 })).toEqual({
      projectId: 101,
      agentType: "productionAgent",
      episodesId: 7,
    });
  });

  it("非法项目 ID 在发请求前失败", () => {
    expect(() => localProjectBody(" 101 ", {})).toThrow(LocalProjectIdError);
  });

  it("as any 注入的 projectId 不能覆盖规范化 number", () => {
    const body = localProjectBody("101", { projectId: "bad" } as any);
    expect(body.projectId).toBe(101);
    expect(typeof body.projectId).toBe("number");
  });
});

describe("toPositiveSafeInteger 资源 ID", () => {
  it("接受正安全整数", () => {
    expect(toPositiveSafeInteger(9)).toBe(9);
    expect(toPositiveSafeInteger("42")).toBe(42);
  });

  it("拒绝 undefined/NaN/0", () => {
    expect(() => toPositiveSafeInteger(undefined)).toThrow(LocalProjectIdError);
    expect(() => toPositiveSafeInteger(NaN)).toThrow(LocalProjectIdError);
    expect(() => toPositiveSafeInteger(0)).toThrow(LocalProjectIdError);
  });
});

describe("tryLocalProjectId", () => {
  it("合法返回 number，非法返回 undefined", () => {
    expect(tryLocalProjectId("101")).toBe(101);
    expect(tryLocalProjectId(" 101 ")).toBeUndefined();
  });
});
