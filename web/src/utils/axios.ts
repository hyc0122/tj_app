import axios, { type AxiosRequestConfig } from "axios";
import router from "@/router/index";
import { storeToRefs } from "pinia";
import { MessagePlugin, NotifyPlugin } from "tdesign-vue-next";
import settingStore from "@/stores/setting";
import { h } from "vue";
import { assertLegacyProjectWriteAllowed } from "@/features/tianjiang/project/access";
import {
  classifyTransportFailure,
  type TransportFailureGuidance,
} from "@/features/tianjiang/runtime/error-guidance";
import {
  isPublicAuthPath,
  shouldAnnounceSessionExpired,
} from "@/features/tianjiang/auth/public-auth-paths";
import { discoverRuntimeConnectionSingleFlight } from "@/bootstrap/runtime-connection";
import { isRetryableLocalRuntimeFailure } from "@/features/tianjiang/runtime/request-recovery";

declare module "axios" {
  interface AxiosRequestConfig<D = any> {
    /** 中文注释：仅限必须校验真实 HTTP 状态的调用；默认仍返回 response.data。 */
    preserveResponse?: boolean;
  }
}

const instance = axios.create({ withCredentials: true });
let lastNetworkNoticeAt = 0;
let lastBusinessErrorAt = 0;
let lastBusinessErrorText = "";

type RuntimeRetryConfig = AxiosRequestConfig & {
  __tianjiangRuntimeRetried?: boolean;
  baseURL?: string;
  method?: string;
};

type RuntimeRetryResult =
  | { recovered: false }
  | { recovered: true; response: unknown };

/**
 * 重新读取 Electron 主进程当前端口，并把原请求最多重放一次。
 * 端口未变化时仅允许重放只读请求，避免响应丢失场景重复提交写操作。
 */
async function retryAfterLocalRuntimeReconnect(error: any): Promise<RuntimeRetryResult> {
  const settings = settingStore();
  if (!isRetryableLocalRuntimeFailure(error, settings.isElectron)) return { recovered: false };
  const config = error.config as RuntimeRetryConfig | undefined;
  if (!config) return { recovered: false };

  const previousBaseUrl = String(config.baseURL ?? "").replace(/\/$/, "");
  const runtime = await discoverRuntimeConnectionSingleFlight();
  if (runtime.mode !== "electron" || runtime.state !== "ready") return { recovered: false };

  const nextBaseUrl = runtime.url.replace(/\/$/, "");
  settings.baseUrl = runtime.url;
  settings.runtimeStartupError = null;
  const method = String(config.method ?? "get").toLowerCase();
  const safeMethod = method === "get" || method === "head" || method === "options";
  if (nextBaseUrl === previousBaseUrl && !safeMethod) return { recovered: false };

  config.__tianjiangRuntimeRetried = true;
  config.baseURL = runtime.url;
  return { recovered: true, response: await instance.request(config) };
}

function notifyTransportFailure(guidance: TransportFailureGuidance): void {
  const now = Date.now();
  // 并发请求失败时只显示一条诊断，避免通知风暴遮挡页面。
  if (now - lastNetworkNoticeAt < 5000) return;
  lastNetworkNoticeAt = now;
  NotifyPlugin.error({
    title: guidance.title,
    closeBtn: true,
    duration: 8000,
    className: "customNotifyFull",
    content: () => h("div", guidance.detail),
  });
}

/** 同一业务错误文案短时间只 toast 一次。 */
export function notifyBusinessErrorOnce(message: string): void {
  const text = message.replace(/\s+/g, " ").trim();
  if (!text) return;
  const now = Date.now();
  if (text === lastBusinessErrorText && now - lastBusinessErrorAt < 4000) return;
  lastBusinessErrorText = text;
  lastBusinessErrorAt = now;
  MessagePlugin.error(text);
}

function isExpectedStaleProjectMiss(error: any, requestPath: string): boolean {
  const status = error?.response?.status;
  const bodyMessage = error?.response?.data?.message ?? error?.message;
  const message = typeof bodyMessage === "string" ? bodyMessage : "";
  const isNotFound = status === 404 || /项目或子资源不存在|项目不存在或未打开|项目尚未打开/.test(message);
  if (!isNotFound) return false;
  // 访问轮询或非工作区路由上的预期 404：清理陈旧状态，不重复全局 toast。
  const headers = error?.config?.headers ?? {};
  const pollFlag = headers["X-Tianjiang-Access-Poll"] ?? headers["x-tianjiang-access-poll"];
  if (pollFlag === "1" || pollFlag === 1) return true;
  // 首页/登录后无活动项目时的列表类探测
  if (
    requestPath.includes("/project/getProject")
    || requestPath.includes("/tianjiang/runtime/status")
  ) {
    return true;
  }
  return false;
}

instance.interceptors.request.use(function (config) {
  const { baseUrl, otherSetting } = storeToRefs(settingStore());
  config.baseURL = baseUrl.value;
  config.timeout = otherSetting.value.axiosTimeOut;
  const requestURL = new URL(config.url ?? "/", "http://local.invalid");
  assertLegacyProjectWriteAllowed(config.method ?? "GET", requestURL.pathname);
  return config;
});

instance.interceptors.response.use(
  function (response) {
    // 中文注释：保持既有全局解包合同，只让显式声明的极小范围请求取得完整 AxiosResponse。
    return response.config.preserveResponse === true ? response : response.data;
  },
  async function (error) {
    const recovery = await retryAfterLocalRuntimeReconnect(error);
    if (recovery.recovered) return recovery.response;

    const requestPath = new URL(
      error.config?.url ?? "/",
      "http://local.invalid",
    ).pathname;
    // 公开认证接口（登录/注册/验证码等）的 401 是业务失败，不是“已有登录过期”。
    // 首次启动空会话探测同理，只表示尚未登录。
    if (
      shouldAnnounceSessionExpired(
        error.response?.status,
        error.config?.method,
        requestPath,
      )
    ) {
      router.push("/login");
      MessagePlugin.error(window.$t("common.sessionExpired"));
    }
    // 标记供页面侧识别，避免与全局拦截器重复弹窗（公开路径由页面独占提示）。
    if (error.response?.status === 401 && isPublicAuthPath(requestPath)) {
      error.__publicAuth401 = true;
    }

    // 预期的项目关闭/回收站 404：清理陈旧活动项目，不触发全局重复 toast。
    if (isExpectedStaleProjectMiss(error, requestPath)) {
      try {
        // 动态导入避免循环依赖；失败忽略。
        void import("@/stores/project").then(({ default: projectStore }) => {
          const store = projectStore();
          if (store.access.projectUuid || store.project) {
            store.clearActiveProject();
          }
        });
      } catch {
        // ignore
      }
      const payload = error?.response?.data ?? error;
      if (payload && typeof payload === "object") {
        (payload as { __staleProjectMiss?: boolean }).__staleProjectMiss = true;
      }
      return Promise.reject(payload);
    }

    const { isElectron } = storeToRefs(settingStore());
    const guidance = classifyTransportFailure(error, isElectron.value);
    if (guidance) notifyTransportFailure(guidance);

    return Promise.reject(error?.response?.data ?? error);
  },
);

export default instance;
