// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import axios from "@/utils/axios";

vi.mock("@/utils/axios", () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
}));

import { completeLocalProjectInit } from "@/features/tianjiang/project/create-project-flow";
import { saveFullCatalogProject } from "@/features/tianjiang/project/project-actions";

const projectUuid = "77777777-7777-4777-a777-777777777777";
const fields = {
  name: "首次同步项目",
  projectType: "novel",
  intro: "简介",
  type: "玄幻",
  artStyle: "style-a",
  directorManual: "director-a",
  videoRatio: "16:9",
  imageModel: "image-a",
  videoModel: "video-a",
  imageQuality: "1K",
  mode: "text",
  scope: "personal" as const,
  teamUuid: "",
};

describe("项目保存后的首次云同步", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(axios.post).mockReset();
    vi.mocked(axios.patch).mockReset();
  });

  it("新建本地字段保存后立即同步，顺序为 refresh→open→edit→sync", async () => {
    const calls: string[] = [];
    vi.mocked(axios.post).mockImplementation(async (url: string) => {
      calls.push(url);
      if (url.endsWith("/refresh")) return { data: [] } as any;
      if (url.endsWith("/open")) {
        return {
          data: {
            projectUuid,
            project: { id: "71", name: fields.name, projectType: "novel" },
            accessMode: "readwrite",
          },
        } as any;
      }
      if (url === "/project/editProject") return { data: null } as any;
      if (url.endsWith("/sync")) return { data: { state: "synced" } } as any;
      throw new Error(url);
    });

    await completeLocalProjectInit(projectUuid, fields);
    expect(calls).toEqual([
      "/tianjiang/runtime/projects/refresh",
      `/tianjiang/runtime/projects/${projectUuid}/open`,
      "/project/editProject",
      `/tianjiang/runtime/projects/${projectUuid}/sync`,
    ]);
  });

  it("云端完整编辑先改中央摘要，再写本地全字段，最后立即同步", async () => {
    vi.mocked(axios.patch).mockResolvedValue({
      data: {
        projectUuid,
        name: fields.name,
        kind: "personal",
        myRole: "owner",
        businessType: "novel",
      },
    } as any);
    vi.mocked(axios.post).mockResolvedValue({ data: { state: "synced" } } as any);

    await saveFullCatalogProject(projectUuid, 71, fields);

    expect(axios.patch).toHaveBeenCalledTimes(1);
    expect(axios.post).toHaveBeenNthCalledWith(
      1,
      "/project/editProject",
      expect.objectContaining({ id: 71, intro: "简介", imageModel: "image-a" }),
    );
    expect(axios.post).toHaveBeenNthCalledWith(
      2,
      `/tianjiang/runtime/projects/${projectUuid}/sync`,
    );
  });
});
