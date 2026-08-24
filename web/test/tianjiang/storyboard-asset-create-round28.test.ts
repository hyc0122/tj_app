// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";

const axiosGet = vi.fn();
const axiosPost = vi.fn();

vi.mock("@/utils/axios", () => ({
  default: {
    get: (...args: unknown[]) => axiosGet(...args),
    post: (...args: unknown[]) => axiosPost(...args),
  },
}));

import AssetManager from "@/views/storyboardProject/components/AssetManager.vue";

const projectUuid = "11111111-1111-4111-a111-111111111111";
const createdAsset = {
  assetUuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "林夏",
  type: "role",
  describe: "女主角",
  sourceProjectUuid: projectUuid,
};

describe("资产管理新建与上传", () => {
  it("可写时显示新建入口，创建后刷新列表", async () => {
    axiosGet.mockResolvedValue({
      data: { data: { sourceProjectUuid: projectUuid, assets: [] } },
    });
    axiosPost.mockResolvedValue({ data: { data: createdAsset } });
    const wrapper = mount(AssetManager, {
      props: { projectUuid, readonly: false },
      global: {
        stubs: {
          TButton: {
            inheritAttrs: true,
            props: ["loading", "disabled"],
            template: '<button v-bind="$attrs" :disabled="disabled || loading"><slot name="icon"/><slot/></button>',
          },
          TIcon: { template: "<i />" },
          TDialog: {
            props: ["visible"],
            template: '<div v-if="visible"><slot /><slot name="footer" /></div>',
          },
        },
      },
    });
    await flushPromises();
    expect(wrapper.get('[data-action="create-asset"]').exists()).toBe(true);
    await wrapper.get('[data-action="create-asset"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-field="asset-name"]').setValue("林夏");
    await wrapper.get('[data-field="asset-type"]').setValue("role");
    await wrapper.get('[data-action="confirm-create-asset"]').trigger("click");
    await flushPromises();
    expect(axiosPost).toHaveBeenCalledWith(
      `/tianjiang/runtime/projects/${projectUuid}/storyboard/assets`,
      { type: "role", name: "林夏", describe: "" },
    );
    expect(axiosGet.mock.calls.filter(([url]) => String(url).includes("/storyboard/assets")).length).toBeGreaterThan(1);
    wrapper.unmount();
  });

  it("只读时不显示新建入口", async () => {
    axiosGet.mockResolvedValue({
      data: { data: { sourceProjectUuid: projectUuid, assets: [] } },
    });
    const wrapper = mount(AssetManager, {
      props: { projectUuid, readonly: true },
      global: {
        stubs: {
          TButton: { inheritAttrs: true, template: "<button v-bind=\"$attrs\"><slot /></button>" },
          TIcon: { template: "<i />" },
          TDialog: { template: "<div />" },
        },
      },
    });
    await flushPromises();
    expect(wrapper.find('[data-action="create-asset"]').exists()).toBe(false);
    wrapper.unmount();
  });
});
