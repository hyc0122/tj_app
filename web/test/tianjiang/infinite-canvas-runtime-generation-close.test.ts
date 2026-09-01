import { beforeEach, describe, expect, it, vi } from "vitest";

const axiosMock = vi.hoisted(() => ({
  post: vi.fn(),
}));

vi.mock("@/utils/axios", () => ({
  default: axiosMock,
}));

import {
  closeCanvasProject,
  openCanvasProject,
} from "@/features/tianjiang/canvas/api";

describe("无限画布项目运行时代次", () => {
  beforeEach(() => {
    axiosMock.post.mockReset();
  });

  it("open 保存服务端 generation，close 必须原样携带", async () => {
    axiosMock.post.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/open")) {
        return {
          data: {
            code: 0,
            data: {
              projectUuid: "11111111-1111-4111-a111-111111111111",
              runtimeGeneration: 9,
            },
          },
        };
      }
      return { data: { code: 0, data: { state: "closed" } } };
    });

    const opened = await openCanvasProject("11111111-1111-4111-a111-111111111111");
    expect(opened.runtimeGeneration).toBe(9);

    await closeCanvasProject(opened.projectUuid, opened.runtimeGeneration);
    const closeCall = axiosMock.post.mock.calls.find((call) => String(call[0]).endsWith("/close"));
    expect(closeCall?.[1]).toEqual({ runtimeGeneration: 9 });
  });

  it("缺少有效 generation 时前端必须拒绝发出危险 close", async () => {
    await expect(closeCanvasProject(
      "11111111-1111-4111-a111-111111111111",
      undefined,
    )).rejects.toThrow("缺少有效的项目运行时代次");
    expect(axiosMock.post).not.toHaveBeenCalled();
  });
});
