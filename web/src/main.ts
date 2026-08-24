import { createApp } from "vue";
import { createPinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import App from "./App.vue";
import { BRAND } from "./brand.generated";
import { discoverRuntimeConnection } from "./bootstrap/runtime-connection";
import settingStore from "./stores/setting";
import router from "./router";
import i18n from "./locales";
import { install } from "@icon-park/vue-next/es/all";
import "@icon-park/vue-next/styles/index.css";

import "tdesign-vue-next/es/style/index.css";
import { LoadingDirective, LoadingPlugin } from "tdesign-vue-next";

import "@/utils/global";

import { Log } from "@webav/av-cliper";
Log.setLogLevel(Log.warn);

import "md-editor-v3/lib/style.css";
import "splitpanes/dist/splitpanes.css";

import "./assets/main.scss";

import { imageOptimizer } from '@/utils/imageOptimizer'

async function bootstrapApplication(): Promise<void> {
  document.title = BRAND.displayName;
  const app = createApp(App);
  const pinia = createPinia().use(piniaPluginPersistedstate);
  app.use(imageOptimizer);
  install(app, "i");
  app.use(pinia);

  // 必须先取得 Electron 随机端口，再安装路由；路由守卫会立即请求会话接口。
  const runtime = await discoverRuntimeConnection();
  const settings = settingStore(pinia);
  if (runtime.mode === "electron") {
    settings.isElectron = true;
    if (runtime.state === "ready") {
      settings.baseUrl = runtime.url;
      settings.runtimeStartupError = null;
    } else {
      settings.runtimeStartupError = {
        code: runtime.code,
        message: runtime.message,
        logPath: runtime.logPath,
      };
    }
  }

  // 本地服务失败时只渲染启动诊断页，禁止路由守卫继续请求陈旧端口。
  if (!settings.runtimeStartupError) {
    app.use(router);
  }
  app.use(i18n);
  app.use(LoadingPlugin);
  app.directive("loading", LoadingDirective);
  app.mount("#app");
}

void bootstrapApplication();
