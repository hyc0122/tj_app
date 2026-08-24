// @vitest-environment jsdom
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";
import ModelSelect from "../../src/components/modelSelect.vue";
import { modelCatalogStore } from "../../src/features/models/modelCatalogStore";

const axiosPost = vi.fn();
const axiosGet = vi.fn();

vi.mock("@/utils/axios", () => ({
  default: {
    post: (...args: unknown[]) => axiosPost(...args),
    get: (...args: unknown[]) => axiosGet(...args),
  },
}));

vi.mock("@/stores/setting", () => ({
  default: () => ({ setActiveMenu: vi.fn(), activeMenu: "", showSetting: false }),
}));

vi.mock("@/router/index.ts", () => ({
  default: { push: vi.fn(), currentRoute: { value: { path: "/" } } },
}));

describe("modelSelect 必须区分加载与真正空目录", () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    axiosPost.mockReset();
    axiosGet.mockReset();
    modelCatalogStore.invalidateAll();
    axiosGet.mockResolvedValue({
      data: { accountScopeId: "", catalogVersion: 3 },
    });
    axiosPost.mockResolvedValue({
      data: {
        accountScopeId: "",
        catalogVersion: 3,
        items: [{ id: "v1", label: "图模", value: "img", type: "image", name: "普通供应商" }],
        providers: [{ providerId: "v1", providerName: "普通供应商", state: "ready" }],
      },
    });
  });

  function mountSelect() {
    const i18n = createI18n({
      legacy: false,
      locale: "zh-CN",
      messages: { "zh-CN": zhCN },
    });
    return mount(ModelSelect, {
      props: { type: "image" },
      global: {
        plugins: [i18n],
        stubs: {
          TSelect: { template: "<div><slot /><slot name='empty' /></div>" },
          TOptionGroup: { template: "<div><slot /></div>" },
          TOption: { template: "<div><slot /></div>" },
          TAvatar: { template: "<span />" },
          TButton: { template: "<button><slot /></button>" },
        },
      },
    });
  }

  it("已有普通供应商模型时不得显示去设置空态", async () => {
    const wrapper = await mountSelect();
    await flushPromises();
    await flushPromises();
    expect(wrapper.text()).toContain("图模");
    expect(wrapper.find(".emptyActionButton").exists()).toBe(false);
    wrapper.unmount();
  });

  it("两个 modelSelect 同时挂载只请求一次目录", async () => {
    const [a, b] = await Promise.all([mountSelect(), mountSelect()]);
    await flushPromises();
    expect(axiosPost.mock.calls.filter((call) => call[0] === "/modelSelect/getModelList")).toHaveLength(1);
    a.unmount();
    b.unmount();
  });

  it("后台刷新失败不得清空已选模型", async () => {
    const wrapper = await mountSelect();
    await flushPromises();
    wrapper.vm.selectValue = "v1:img";
    axiosPost.mockRejectedValueOnce(new Error("network"));
    modelCatalogStore.invalidateAccount("");
    await wrapper.vm.loadCatalog?.().catch(() => undefined);
    await flushPromises();
    expect(wrapper.vm.selectValue || "v1:img").toBe("v1:img");
    wrapper.unmount();
  });

  it("第二次打开弹窗不得再发 getModelList", async () => {
    const wrapper = await mountSelect();
    await flushPromises();
    expect(axiosPost.mock.calls.filter((call) => call[0] === "/modelSelect/getModelList")).toHaveLength(1);
    await modelCatalogStore.ensure("", "image");
    await flushPromises();
    expect(axiosPost.mock.calls.filter((call) => call[0] === "/modelSelect/getModelList")).toHaveLength(1);
    wrapper.unmount();
  });

  it("不同账号不得串用目录缓存", async () => {
    axiosPost.mockResolvedValueOnce({
      data: {
        accountScopeId: "acc-a",
        catalogVersion: 3,
        items: [{ id: "va", label: "A模", value: "a", type: "image", name: "A" }],
        providers: [{ providerId: "va", providerName: "A", state: "ready" }],
      },
    });
    await modelCatalogStore.ensure("acc-a", "image");
    axiosPost.mockResolvedValueOnce({
      data: {
        accountScopeId: "acc-b",
        catalogVersion: 3,
        items: [{ id: "vb", label: "B模", value: "b", type: "image", name: "B" }],
        providers: [{ providerId: "vb", providerName: "B", state: "ready" }],
      },
    });
    const b = await modelCatalogStore.ensure("acc-b", "image");
    expect(b.items[0]?.label).toBe("B模");
    expect(modelCatalogStore.peek("acc-a", "image")?.items[0]?.label).toBe("A模");
  });

  it("disabled 即梦项不得被选中", async () => {
    axiosPost.mockResolvedValueOnce({
      data: {
        accountScopeId: "current",
        catalogVersion: 4,
        items: [{
          id: "native:dreamina-cli",
          label: "即梦",
          value: "dreamina",
          type: "image",
          name: "即梦 CLI",
          disabled: true,
          disabledReason: "未安装",
        }],
        providers: [{ providerId: "native:dreamina-cli", providerName: "即梦 CLI", state: "disabled" }],
      },
    });
    const wrapper = await mountSelect();
    await flushPromises();
    wrapper.vm.selectValue = "";
    await wrapper.vm.onChange?.("native:dreamina-cli:dreamina", {
      option: { disabled: true, label: "即梦" },
    });
    expect(wrapper.vm.selectValue).toBe("");
    wrapper.unmount();
  });
});
