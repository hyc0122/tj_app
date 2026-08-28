import { ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@/utils/axios", () => ({ default: { post } }));

import { useVendorModels } from "@/components/setting/components/vendorConfig/useVendorModels";
import type { VendorItem } from "@/components/setting/components/vendorConfig/types";

describe("佳速手动添加远端模型", () => {
  beforeEach(() => {
    post.mockReset();
  });

  function createCatalog(vendorId = "tianjiang") {
    const vendor: VendorItem = {
      id: vendorId,
      name: "佳速 API",
      author: "JiasuAPI",
      inputs: [],
      inputValues: {},
      models: [],
      enable: 1,
    };
    return {
      currentVendor: ref(vendor),
      vendorModels: ref([]),
      getVendorList: vi.fn(),
    };
  }

  it("打开佳速手动添加时默认视频模型，并由用户主动获取远端列表", async () => {
    post.mockResolvedValue({
      data: {
        models: [
          { id: "video-model-b", owned_by: "jiasu" },
          { id: "video-model-a", owned_by: "jiasu" },
        ],
      },
    });
    const models = useVendorModels(createCatalog() as any) as ReturnType<typeof useVendorModels> & {
      loadRemoteModels?: () => Promise<void>;
      remoteModels?: { value: Array<{ id: string }> };
      selectRemoteModel?: (id: string) => void;
    };

    models.handleAddModel();
    expect(models.modelFormData.value.type).toBe("video");
    expect(models.modelFormData.value.mode).toEqual(["multiReference"]);
    expect(models.modelFormData.value.mixedMode).toEqual([
      "imageReference",
      "videoReference",
      "audioReference",
    ]);
    expect(models.modelFormData.value.mixedModeCount).toEqual({
      imageReference: 9,
      videoReference: 3,
      audioReference: 3,
    });
    expect(models.modelFormData.value.durationResolutionMap).toEqual([{
      duration: Array.from({ length: 27 }, (_, index) => String(index + 4)),
      resolution: ["480p", "720p", "1080p"],
    }]);
    expect(post).not.toHaveBeenCalled();
    expect(typeof models.loadRemoteModels).toBe("function");

    await models.loadRemoteModels!();
    expect(post).toHaveBeenCalledWith("/setting/vendorConfig/listRemoteModels", {
      id: "tianjiang",
    });
    expect(models.remoteModels!.value.map((item) => item.id)).toEqual([
      "video-model-b",
      "video-model-a",
    ]);

    models.selectRemoteModel!("video-model-a");
    expect(models.modelFormData.value.name).toBe("video-model-a");
    expect(models.modelFormData.value.modelName).toBe("video-model-a");
    expect(models.modelFormData.value.type).toBe("video");
    expect(models.modelFormData.value.mode).toEqual(["multiReference"]);
    expect(models.modelFormData.value.mixedModeCount).toEqual({
      imageReference: 9,
      videoReference: 3,
      audioReference: 3,
    });
    expect(models.modelFormData.value.durationResolutionMap[0]).toEqual({
      duration: Array.from({ length: 27 }, (_, index) => String(index + 4)),
      resolution: ["480p", "720p", "1080p"],
    });
  });

  it("非佳速供应商仍保持文本模型默认值", () => {
    const models = useVendorModels(createCatalog("custom") as any);
    models.handleAddModel();
    expect(models.modelFormData.value.type).toBe("text");
  });
});
