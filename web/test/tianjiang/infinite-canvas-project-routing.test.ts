// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import router from "@/router/index.ts";
import { projectCapabilities } from "@/features/tianjiang/project/create-project";

const SENTINEL = "RED_EXPECTED:WEB_CANVAS_PROJECT_ROUTING";
const PROJECT_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000000d01";

describe("无限画布项目路由", () => {
  it("必须同时挂载首页与按 UUID 打开的编辑器路由", () => {
    const paths = router.getRoutes().map((item) => item.path);
    const hasHome = paths.includes("/infinite-canvas");
    const hasEditor = paths.includes("/infinite-canvas/:projectUuid");
    if (!hasHome || !hasEditor) {
      console.error(SENTINEL);
      expect(hasHome, SENTINEL).toBe(true);
      expect(hasEditor, SENTINEL).toBe(true);
    }
  });

  it("能力合同路径必须与编辑器路由一致", () => {
    const path = projectCapabilities("canvas").workspacePath?.(PROJECT_UUID);
    if (path !== `/infinite-canvas/${encodeURIComponent(PROJECT_UUID)}`) {
      console.error(SENTINEL);
      expect(path, SENTINEL).toBe(`/infinite-canvas/${encodeURIComponent(PROJECT_UUID)}`);
    }
  });
});
