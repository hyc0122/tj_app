// @vitest-environment jsdom
/**
 * 供应商凭据输入区状态机与渲染契约。
 * 证明：列表/模型可显示时，输入框不得因非响应式 secretSession 字段长期隐藏。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import {
  computed,
  defineComponent,
  h,
  nextTick,
  ref,
} from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { VendorInput, VendorItem } from "@/components/setting/components/vendorConfig/types";

const axiosPost = vi.hoisted(() => vi.fn());

vi.mock("@/utils/axios", () => ({
  default: {
    post: (...args: unknown[]) => axiosPost(...args),
    get: vi.fn(),
  },
}));

vi.mock("tdesign-vue-next", () => ({
  DialogPlugin: {
    confirm: vi.fn(),
  },
}));

// 全局消息桩：加载失败不得把 Key 拼进提示
const messageError = vi.fn();
(globalThis as any).window = globalThis.window ?? globalThis;
(window as any).$message = {
  error: messageError,
  success: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
};
(globalThis as any).$t = (key: string) => key;

import { useVendorCatalog } from "@/components/setting/components/vendorConfig/useVendorCatalog";
import {
  getInputPlaceholder,
  getVisibleInputType,
} from "@/components/setting/components/vendorConfig/vendorCatalogPresentation";

/** 从权威模板源抽取 inputs 契约（测试只读，不改生成物） */
function readTemplateInputs(fileName: string): VendorInput[] {
  const source = readFileSync(
    path.join(process.cwd(), "..", "app", "src", "provider-templates", fileName),
    "utf8",
  );
  const block = source.match(/inputs:\s*\[([\s\S]*?)\],/);
  expect(block, `${fileName} 缺少 inputs`).toBeTruthy();
  const entries = [...block![1].matchAll(/\{\s*key:\s*"([^"]+)"([\s\S]*?)\}/g)];
  return entries.map((match) => {
    const key = match[1];
    const body = match[2];
    const label = body.match(/label:\s*"([^"]*)"/)?.[1] ?? key;
    const type = (body.match(/type:\s*"([^"]+)"/)?.[1] ?? "text") as VendorInput["type"];
    const required = /required:\s*true/.test(body);
    const placeholder = body.match(/placeholder:\s*"([^"]*)"/)?.[1];
    const disabled = /disabled:\s*true/.test(body);
    return { key, label, type, required, placeholder, disabled };
  });
}

function fakeVendor(
  id: string,
  inputs: VendorInput[],
  inputValues: Record<string, string> = {},
  models: VendorItem["models"] = [
    { name: "demo", modelName: "demo-model", type: "text", think: false },
  ],
): VendorItem {
  return {
    id,
    author: "tianjiang",
    name: id,
    description: `${id} desc`,
    code: "",
    inputs,
    inputValues: { ...inputValues },
    enable: 1,
    models,
    version: "2.0",
  };
}

function mountCatalogHost() {
  const Host = defineComponent({
    name: "VendorCatalogHost",
    setup() {
      const catalog = useVendorCatalog();
      return catalog;
    },
    render() {
      return h("div", { class: "host" });
    },
  });
  return mount(Host, {
    global: {
      plugins: [createPinia()],
    },
  });
}

describe("供应商凭据输入框响应式状态机", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    axiosPost.mockReset();
    messageError.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("RED/契约：vendorSecretsLoaded 不得只依赖非响应式 secretSession 私有字段", () => {
    const catalogSource = readFileSync(
      path.join(
        process.cwd(),
        "src/components/setting/components/vendorConfig/useVendorCatalog.ts",
      ),
      "utf8",
    );
    // 单一响应式来源：loaded 状态来自 vendorLoadStates / vendorLoadState，而非 secretSession.isLoaded。
    expect(catalogSource).not.toMatch(
      /vendorSecretsLoaded\s*=\s*computed\(\s*\(\)\s*=>\s*secretSession\.isLoaded/,
    );
    expect(catalogSource).toMatch(/vendorLoadState\.value\.state\s*===\s*["']loaded["']/);
  });

  it("选择 volcengine 后：接口已返回 inputs/inputValues、加载完成，凭据输入键可编辑回显", async () => {
    const volcInputs = readTemplateInputs("volcengine.ts.template");
    expect(volcInputs.map((item) => item.key)).toEqual(["apiKey", "baseUrl"]);

    axiosPost.mockImplementation(async (url: string, body?: any) => {
      if (url === "/setting/vendorConfig/getVendorList") {
        return {
          data: [
            fakeVendor("volcengine", volcInputs, {
              apiKey: "volc-local-key",
              baseUrl: "https://ark.example/v3",
            }),
          ],
        };
      }
      if (url === "/setting/vendorConfig/updateVendorInputs") {
        return { data: null };
      }
      throw new Error(`未 mock 的请求: ${url}`);
    });

    const wrapper = mountCatalogHost();
    await flushPromises();
    await nextTick();

    const vm = wrapper.vm as any;
    expect(vm.vendorList.length).toBe(1);
    expect(vm.activeVendorId).toBe("volcengine");
    expect(vm.vendorLoadState.state).toBe("loaded");
    expect(vm.vendorSecretsLoaded).toBe(true);
    expect(vm.currentVendor.models?.length ?? vm.vendorModels.length).toBeGreaterThan(0);
    // 模型与输入可同时就绪
    expect(vm.vendorModels.length).toBe(1);
    expect(vm.orderedInputs.map((item: VendorInput) => item.key)).toEqual([
      "apiKey",
      "baseUrl",
    ]);
    expect(vm.currentVendor.inputValues.apiKey).toBe("volc-local-key");
    expect(vm.currentVendor.inputValues.baseUrl).toBe("https://ark.example/v3");

    // 渲染层：用 load 状态驱动的表单字段可见契约
    const FormProbe = defineComponent({
      props: {
        loaded: { type: Boolean, required: true },
        inputs: { type: Array as () => VendorInput[], required: true },
        values: { type: Object as () => Record<string, string>, required: true },
        models: { type: Array, required: true },
      },
      setup(props) {
        return () =>
          h("div", [
            props.models.length > 0 ? h("div", { "data-testid": "models" }, "models-ok") : null,
            props.loaded
              ? props.inputs.map((input) =>
                  h("label", { key: input.key, "data-field": input.key }, [
                    h("span", { class: "label" }, input.label),
                    h("input", {
                      "data-testid": `field-${input.key}`,
                      type: getVisibleInputType(input.type),
                      value: props.values[input.key] ?? "",
                      disabled: Boolean(input.disabled),
                      placeholder: getInputPlaceholder(input),
                    }),
                  ]),
                )
              : h("div", { "data-testid": "hidden-inputs" }, "inputs-hidden"),
          ]);
      },
    });

    const probe = mount(FormProbe, {
      props: {
        loaded: vm.vendorSecretsLoaded,
        inputs: vm.orderedInputs,
        values: vm.currentVendor.inputValues,
        models: vm.vendorModels,
      },
    });
    expect(probe.find('[data-testid="models"]').exists()).toBe(true);
    expect(probe.find('[data-testid="hidden-inputs"]').exists()).toBe(false);
    expect(probe.find('[data-testid="field-apiKey"]').exists()).toBe(true);
    expect(probe.find('[data-testid="field-baseUrl"]').exists()).toBe(true);
    expect((probe.find('[data-testid="field-apiKey"]').element as HTMLInputElement).type).toBe(
      "text",
    );
    expect((probe.find('[data-testid="field-baseUrl"]').element as HTMLInputElement).type).toBe(
      "url",
    );

    wrapper.unmount();
    probe.unmount();
  });

  it("volcengineSd2 / openai / atlascloud 字段顺序与模板 schema 一致且 URL 可见", () => {
    const cases: Array<{ file: string; keys: string[] }> = [
      {
        file: "volcengine.ts.template",
        keys: ["apiKey", "baseUrl"],
      },
      {
        file: "volcengineSd2.ts.template",
        keys: ["apiKey", "baseUrl", "ak", "sk", "groupId", "tosEndpoint", "tosBucket"],
      },
      {
        file: "openai.ts.template",
        keys: ["apiKey", "baseUrl"],
      },
      {
        file: "atlascloud.ts.template",
        keys: ["apiKey", "chatBaseUrl", "mediaBaseUrl"],
      },
    ];
    for (const item of cases) {
      const inputs = readTemplateInputs(item.file);
      expect(inputs.map((entry) => entry.key)).toEqual(item.keys);
      for (const input of inputs) {
        expect(input.label.length).toBeGreaterThan(0);
        expect(["text", "password", "url"]).toContain(input.type);
        if (input.type === "url") {
          expect(getVisibleInputType(input.type)).toBe("url");
        } else {
          // 产品策略：密钥字段也不使用 password 掩码
          expect(getVisibleInputType(input.type)).toBe("text");
        }
      }
      if (item.file === "atlascloud.ts.template") {
        expect(inputs.find((entry) => entry.key === "chatBaseUrl")?.disabled).toBe(true);
        expect(inputs.find((entry) => entry.key === "mediaBaseUrl")?.disabled).toBe(true);
      }
    }
  });

  it("保存后重新读取仍回显；快速切换供应商不会串保存", async () => {
    const alphaInputs = readTemplateInputs("openai.ts.template");
    const betaInputs = readTemplateInputs("volcengine.ts.template");
    const store: Record<string, Record<string, string>> = {
      openai: { apiKey: "openai-a", baseUrl: "https://api.openai.com/v1" },
      volcengine: { apiKey: "volc-b", baseUrl: "https://ark.example/v3" },
    };

    axiosPost.mockImplementation(async (url: string, body?: any) => {
      if (url === "/setting/vendorConfig/getVendorList") {
        return {
          data: [
            fakeVendor("openai", alphaInputs, store.openai),
            fakeVendor("volcengine", betaInputs, store.volcengine),
          ],
        };
      }
      if (url === "/setting/vendorConfig/updateVendorInputs") {
        const id = String(body.id);
        store[id] = { ...body.inputValues };
        return { data: null };
      }
      throw new Error(`未 mock: ${url}`);
    });

    const wrapper = mountCatalogHost();
    await flushPromises();
    const vm = wrapper.vm as any;
    expect(vm.activeVendorId).toBe("openai");
    expect(vm.vendorSecretsLoaded).toBe(true);

    vm.currentVendor.inputValues.apiKey = "openai-a-edited";
    await vm.onBlurFn();
    // 在自动保存定时器触发前立刻切换到 volcengine
    vm.activeVendorId = "volcengine";
    await flushPromises();
    await nextTick();
    // 等待 debounce
    await new Promise((resolve) => setTimeout(resolve, 800));
    await flushPromises();

    // volcengine 当前值不得被 openai 编辑污染
    expect(vm.activeVendorId).toBe("volcengine");
    expect(vm.currentVendor.inputValues.apiKey).toBe("volc-b");
    const saveCalls = axiosPost.mock.calls.filter(
      (call: unknown[]) => call[0] === "/setting/vendorConfig/updateVendorInputs",
    );
    for (const call of saveCalls) {
      const body = call[1] as { id: string; inputValues: Record<string, string> };
      if (body.id === "volcengine") {
        expect(body.inputValues.apiKey).not.toBe("openai-a-edited");
      }
      if (body.id === "openai") {
        expect(body.inputValues.apiKey).not.toBe("volc-b");
      }
      // 日志/请求体允许含 key 字段名，但测试侧不把密钥写入断言快照以外的共享输出
      expect(body.id === "openai" || body.id === "volcengine").toBe(true);
    }

    // 再读 openai：若曾保存则回显编辑值；若因切换取消保存则仍为旧值——不得串成 volc 值
    vm.activeVendorId = "openai";
    await flushPromises();
    await nextTick();
    expect(vm.currentVendor.inputValues.apiKey).not.toBe("volc-b");
    expect(["openai-a", "openai-a-edited"]).toContain(vm.currentVendor.inputValues.apiKey);

    wrapper.unmount();
  });

  it("加载失败后重试恢复；单供应商失败不影响列表；错误不含 Key", async () => {
    const inputs = readTemplateInputs("openai.ts.template");
    let failOnce = true;
    axiosPost.mockImplementation(async (url: string) => {
      if (url === "/setting/vendorConfig/getVendorList") {
        return {
          data: [
            fakeVendor("openai", inputs, { apiKey: "secret-should-not-log", baseUrl: "https://x" }),
            {
              ...fakeVendor("broken", inputs, {}),
              loadError: "模板损坏",
              models: [],
            },
          ],
        };
      }
      throw new Error("unreachable");
    });

    const wrapper = mountCatalogHost();
    await flushPromises();
    const vm = wrapper.vm as any;
    expect(vm.vendorList.length).toBe(2);

    // 模拟 activate 路径失败：通过直接设置 error 后 retry
    // 覆盖 retryVendorLoad：强制下一次 load 先失败再成功
    const original = vm.loadVendorSecrets ?? null;
    let attempts = 0;
    // 通过切换触发 load：先让 secret 路径抛错
    axiosPost.mockImplementation(async (url: string) => {
      if (url === "/setting/vendorConfig/getVendorList") {
        return {
          data: [fakeVendor("openai", inputs, { apiKey: "secret-should-not-log", baseUrl: "https://x" })],
        };
      }
      return { data: null };
    });

    // 注入失败：临时替换 list 中的 vendor 触发 load 时抛错
    const realFind = Array.prototype.find;
    attempts = 0;
    vi.spyOn(vm.vendorList, "find").mockImplementation((...args: any[]) => {
      attempts += 1;
      if (failOnce && attempts <= 1) {
        failOnce = false;
        throw new Error("模拟加载失败 secret-should-not-log");
      }
      return realFind.apply(vm.vendorList, args as any);
    });

    await vm.retryVendorLoad();
    await flushPromises();
    // 第一次失败
    expect(vm.vendorLoadState.state === "error" || messageError.mock.calls.length > 0).toBe(true);
    for (const call of messageError.mock.calls) {
      const text = String(call[0] ?? "");
      expect(text).not.toContain("secret-should-not-log");
    }

    await vm.retryVendorLoad();
    await flushPromises();
    expect(vm.vendorLoadState.state).toBe("loaded");
    expect(vm.vendorSecretsLoaded).toBe(true);
    // broken 供应商仍在列表中（来自首次 list）；不要求全局转圈
    expect(vm.loading).toBe(false);

    wrapper.unmount();
  });

  it("账号 A/B 的 Key 与 URL 隔离：clear 后不得残留上一账号内存值", async () => {
    const inputs = readTemplateInputs("openai.ts.template");
    axiosPost.mockImplementation(async (url: string) => {
      if (url === "/setting/vendorConfig/getVendorList") {
        return {
          data: [
            fakeVendor("openai", inputs, {
              apiKey: "account-a-key",
              baseUrl: "https://a.example/v1",
            }),
          ],
        };
      }
      return { data: null };
    });
    const wrapper = mountCatalogHost();
    await flushPromises();
    const vm = wrapper.vm as any;
    expect(vm.currentVendor.inputValues.apiKey).toBe("account-a-key");
    // 模拟账号切换：重新拉取列表（clearVendorSecrets + 新值）
    axiosPost.mockImplementation(async (url: string) => {
      if (url === "/setting/vendorConfig/getVendorList") {
        return {
          data: [
            fakeVendor("openai", inputs, {
              apiKey: "account-b-key",
              baseUrl: "https://b.example/v1",
            }),
          ],
        };
      }
      return { data: null };
    });
    await vm.getVendorList();
    await flushPromises();
    expect(vm.currentVendor.inputValues.apiKey).toBe("account-b-key");
    expect(vm.currentVendor.inputValues.apiKey).not.toBe("account-a-key");
    expect(vm.currentVendor.inputValues.baseUrl).toBe("https://b.example/v1");
    wrapper.unmount();
  });

  it("无供应商时不显示错误的加载失败；Workspace 以 loaded 状态显示输入区", () => {
    const workspace = readFileSync(
      path.join(
        process.cwd(),
        "src/components/setting/components/vendorConfig/components/VendorWorkspace.vue",
      ),
      "utf8",
    );
    expect(workspace).toContain("vendorLoadState.state === 'loaded'");
    expect(workspace).toMatch(/vendorSecretsLoaded\s*\|\|\s*vendorLoadState\.state\s*===\s*'loaded'/);
    // 不得用 password 掩码绑定
    expect(workspace).not.toContain(':type="input.type"');
    expect(workspace).toContain("orderedInputs");
    // idle 空列表文案不是 loadInputsFailed
    expect(workspace).toContain("selectVendorFirst");
    const errorSlice = workspace.slice(
      workspace.indexOf("vendorLoadState.state === 'error'"),
      workspace.indexOf("vendorLoadState.state === 'loading'"),
    );
    expect(errorSlice).toContain("loadInputsFailed");
  });

  it("列表与保存路径契约：updateVendorInputs；源码不把密钥写入 console", () => {
    const catalog = readFileSync(
      path.join(
        process.cwd(),
        "src/components/setting/components/vendorConfig/useVendorCatalog.ts",
      ),
      "utf8",
    );
    const session = readFileSync(
      path.join(process.cwd(), "src/features/tianjiang/vendor-secret-session.ts"),
      "utf8",
    );
    expect(catalog).toContain("secretSession.save");
    expect(catalog).toContain("/setting/vendorConfig/getVendorList");
    expect(session).toContain("/setting/vendorConfig/updateVendorInputs");
    expect(catalog).not.toMatch(/console\.(log|info|debug|error)\([^)]*inputValues/);
    expect(catalog).not.toMatch(/console\.(log|info|debug|error)\([^)]*apiKey/);
    expect(session).not.toMatch(/console\.(log|info|debug|error)/);
  });
});
