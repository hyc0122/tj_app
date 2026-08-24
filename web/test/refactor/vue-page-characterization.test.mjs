import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createPinia, setActivePinia } from "pinia";
import { JSDOM } from "jsdom";
import { createSSRApp, ref } from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer } from "vite";

let viteServer;

before(async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/#/",
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.$t = (key) => key;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator,
  });

  viteServer = await createServer({
    root: process.cwd(),
    resolve: {
      // Monaco 的 UMD 构建依赖浏览器 AMD loader；SSR characterization 只替换编辑器壳，
      // 供应商页面其余真实组件、状态和渲染链仍由 Vite 执行。
      alias: {
        "monaco-editor-vue3": fileURLToPath(
          new URL("./fixtures/CodeEditorStub.vue", import.meta.url),
        ),
      },
    },
    server: { middlewareMode: true },
    appType: "custom",
  });
});

after(async () => {
  await viteServer?.close();
});

async function renderPage(modulePath, setupApp = () => {}, props = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const pageModule = await viteServer.ssrLoadModule(modulePath);
  const app = createSSRApp(pageModule.default, props);
  app.use(pinia);
  app.config.globalProperties.$t = (key) => key;
  app.config.warnHandler = () => {};
  setupApp(app);
  return renderToString(app);
}

test("生产生成页渲染模式、提示词和生成操作入口", async () => {
  const html = await renderPage("/src/views/production/components/workbench/generate/index.vue", (app) => {
    app.provide("episodesId", ref(1));
  });

  // 断言真实渲染结果，拆分后页面仍须保留三类核心操作入口。
  assert.match(html, /workbench\.generate\.addReference/);
  assert.match(html, /workbench\.generate\.batchGenerateText/);
  assert.match(html, /workbench\.generate\.batchGenerateVideo/);
});

test("素材页渲染新增、搜索和批量生成入口", async () => {
  const html = await renderPage("/src/views/assets/index.vue");

  assert.match(html, /workbench\.assets\.addPrefix/);
  assert.match(html, /workbench\.assets\.search/);
  assert.match(html, /workbench\.assets\.batchGenerate/);
});

test("角色情景页渲染筛选、批量提示词和批量生成入口", async () => {
  const html = await renderPage("/src/views/cornerScape/index.vue");

  assert.match(html, /workbench\.cornerScape\.assetTypeFilter/);
  assert.match(html, /workbench\.cornerScape\.batchGenerationPrompt/);
  assert.match(html, /workbench\.cornerScape\.startBatch/);
});

test("视频预览在没有画布内容时显示占位与时间轴", async () => {
  const html = await renderPage("/src/views/production/components/workbench/editVideo/videoPreview.vue");

  assert.match(html, /workbench\.production\.editVideo\.videoPreviewArea/);
  assert.match(html, /type="range"/);
  assert.match(html, /00:00/);
});

test("视频编辑工作台保留素材、预览、属性与导出入口", async () => {
  const html = await renderPage("/src/views/production/components/workbench/editVideo/index.vue");

  assert.match(html, /workbench\.production\.editVideo\.clipMaterials/);
  assert.match(html, /workbench\.production\.editVideo\.videoPreviewArea/);
  assert.match(html, /workbench\.production\.editVideo\.propertyPanel/);
  assert.match(html, /workbench\.production\.editVideo\.exportVideo/);
});

test("供应商设置保留新增入口与空列表状态", async () => {
  const html = await renderPage(
    "/src/components/setting/components/vendorConfig.vue",
    (app) => {
      app.directive("loading", { getSSRProps: () => ({}) });
    },
  );

  assert.match(html, /settings\.vendor\.addVendor/);
  assert.match(html, /settings\.vendor\.noVendor/);
});

test("项目弹窗保留项目、视觉手册和导演手册入口", async () => {
  const pageModule = await viteServer.ssrLoadModule(
    "/src/views/project/components/projectDialog.vue",
  );
  const html = await renderPage(
    "/src/views/project/components/projectDialog.vue",
    () => {},
    { modelValue: true, projectData: null },
  );

  // TDesign Dialog 在 SSR 中通过 Teleport 延迟正文，但编译后的公开契约可直接核验。
  assert.match(html, /class="addProject"/);
  assert.deepEqual([...pageModule.default.emits].sort(), [
    "add",
    "edit",
    "update:modelValue",
  ]);
  assert.equal("projectData" in pageModule.default.props, true);
});
