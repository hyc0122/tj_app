// @vitest-environment jsdom
import { ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { post, confirm } = vi.hoisted(() => ({
  post: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock("@/utils/axios", () => ({ default: { post } }));
vi.mock("tdesign-vue-next", () => ({
  DialogPlugin: { confirm },
}));

import { useVendorUpdates } from "@/components/setting/components/vendorConfig/useVendorUpdates";
import type { VendorItem } from "@/components/setting/components/vendorConfig/types";

describe("佳速配置在线更新", () => {
  beforeEach(() => {
    post.mockReset();
    confirm.mockReset();
    (window as any).$message = {
      success: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    };
  });

  function catalog(id = "tianjiang") {
    const vendor: VendorItem = {
      id,
      name: "佳速 API",
      author: "JiasuAPI",
      inputs: [],
      inputValues: { apiKey: "secret-must-stay-local" },
      models: [],
      enable: 1,
      version: "4.3",
    };
    return { currentVendor: ref(vendor), getVendorList: vi.fn() };
  }

  it("只在用户点击后检查，发现新版本时展示版本和公告", async () => {
    post.mockResolvedValue({
      data: { hasUpdate: true, latestVersion: "4.4", notice: "配置兼容性更新" },
    });
    const updates = useVendorUpdates(catalog() as any);
    expect(post).not.toHaveBeenCalled();

    await updates.checkVendorUpdate();
    expect(post).toHaveBeenCalledWith("/setting/vendorConfig/checkVendorUpdate", {
      id: "tianjiang",
    });
    expect(updates.hasVendorUpdate.value).toBe(true);
    expect(updates.latestVendorVersion.value).toBe("4.4");
    expect(updates.vendorUpdateNotice.value).toBe("配置兼容性更新");
    expect(JSON.stringify(post.mock.calls)).not.toContain("secret-must-stay-local");
  });

  it("确认后由本地后端下载并安装，完成后刷新供应商列表", async () => {
    const current = catalog();
    post
      .mockResolvedValueOnce({
        data: { hasUpdate: true, latestVersion: "4.4", notice: "配置兼容性更新" },
      })
      .mockResolvedValueOnce({ data: { id: "tianjiang", version: "4.4" } });
    confirm.mockImplementation((options) => ({
      destroy: vi.fn(),
      hide: vi.fn(),
      options,
    }));
    const updates = useVendorUpdates(current as any);
    await updates.checkVendorUpdate();
    updates.confirmVendorUpdate();
    const options = confirm.mock.calls[0][0];
    await options.onConfirm();

    expect(post).toHaveBeenLastCalledWith("/setting/vendorConfig/installVendorUpdate", {
      id: "tianjiang",
    });
    expect(current.getVendorList).toHaveBeenCalledTimes(1);
    expect(updates.hasVendorUpdate.value).toBe(false);
  });

  it("非佳速供应商不显示也不触发在线更新", async () => {
    const updates = useVendorUpdates(catalog("custom") as any);
    expect(updates.canUpdateVendor.value).toBe(false);
    await updates.checkVendorUpdate();
    expect(post).not.toHaveBeenCalled();
  });
});
