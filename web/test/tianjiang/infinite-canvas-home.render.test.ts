// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import router from "@/router/index.ts";

const SENTINEL = "RED_EXPECTED:WEB_CANVAS_HOME_RENDER";

function workbenchSource(): string {
  return readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/pages/workbench/index.vue"),
    "utf8",
  );
}

describe("个人无限画布首页入口", () => {
  it("主导航顺序必须是我的项目、任务中心、团队、无限画布", () => {
    const src = workbenchSource();
    const menuBlock = src.split("const menuList")[1]?.split("const rightBtnList")[0] ?? "";
    const paths = [...menuBlock.matchAll(/path:\s*"(\/[^"]+)"/g)].map((match) => match[1]);
    if (paths.join(",") !== "/project,/task,/team,/infinite-canvas") {
      console.error(SENTINEL);
      expect(paths, SENTINEL).toEqual(["/project", "/task", "/team", "/infinite-canvas"]);
    }
  });

  it("无限画布首页路由必须挂载真实组件", () => {
    const route = router.getRoutes().find((item) => item.path === "/infinite-canvas");
    if (!route?.components && !route?.component) {
      console.error(SENTINEL);
      expect(Boolean(route?.components || route?.component), SENTINEL).toBe(true);
    }
  });
});
