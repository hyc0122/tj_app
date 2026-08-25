import { shallowRef } from "vue";
import axios from "@/utils/axios";
import { setAccountScope } from "@/features/models/account-scope";

export const CENTRAL_API_URL = "https://api.j11.com.cn";

export interface CentralUser {
  id: number;
  username: string;
  nickname: string;
}

export interface LoginResult {
  user: CentralUser;
  keyServiceDegraded: boolean;
}

export type AuthBootstrapMode =
  | "session"
  | "auto_login"
  | "fill"
  | "offline"
  | "reauth_required"
  | "none";

export interface AuthBootstrapData {
  mode: AuthBootstrapMode;
  user?: CentralUser | null;
  username?: string;
  password?: string;
  keyServiceDegraded?: boolean;
  message?: string;
}

export const centralUser = shallowRef<CentralUser | null>(null);

/** 兼容 Axios 已解包和未解包错误，个人中心始终优先显示服务端安全中文文案。 */
export function authActionErrorMessage(error: unknown, fallback: string): string {
  const payload = error as {
    message?: unknown;
    msg?: unknown;
    response?: { data?: { message?: unknown; msg?: unknown } };
  };
  // 中文注释：标准 AxiosError 自带通用 message，必须优先采用服务端已审计的业务文案。
  const candidate = payload?.response?.data?.message
    ?? payload?.response?.data?.msg
    ?? payload?.message
    ?? payload?.msg;
  return typeof candidate === "string" && candidate.trim() ? candidate : fallback;
}

export async function fetchCaptcha() {
  return axios.post("/tianjiang/auth/captcha");
}

export async function centralLogin(input: {
  username: string;
  password: string;
  captcha: string;
  captchaId: string;
}): Promise<LoginResult> {
  const response = await axios.post("/tianjiang/auth/login", input);
  const user = response.data.user as CentralUser;
  const previousId = centralUser.value?.id;
  centralUser.value = user;
  setAccountScope(user.id);
  try {
    const { modelCatalogStore } = await import("@/features/models/modelCatalogStore");
    if (previousId) modelCatalogStore.invalidateAccount(`account:${previousId}`);
    modelCatalogStore.invalidateAccount(`account:${user.id}`);
  } catch {
    // 目录缓存不可用时不阻断登录。
  }
  // 新登录进入首页前清理上一账号的陈旧活动项目/路由态；tombstone 按账号键保留。
  try {
    const { default: projectStore } = await import("@/stores/project");
    const store = projectStore();
    store.setActiveAccount(user.id);
    store.resetSessionProjectState({ clearLocalList: true });
  } catch {
    // store 不可用时不阻断登录。
  }
  return {
    user,
    keyServiceDegraded: response.data.keyServiceDegraded === true,
  };
}

export async function centralRegister(input: {
  username: string;
  nickname: string;
  password: string;
  captcha: string;
  captchaId: string;
}) {
  // 注册只创建账号，不建立登录会话，成功后由页面回到登录表单。
  return axios.post("/tianjiang/auth/register", input);
}

export async function updateCentralProfile(input: {
  username: string;
  nickname: string;
}): Promise<CentralUser> {
  const response = await axios.patch("/tianjiang/auth/profile", input);
  const user = response.data.user as CentralUser;
  centralUser.value = user;
  return user;
}

export async function changeCentralPassword(input: {
  oldPassword: string;
  newPassword: string;
}): Promise<CentralUser> {
  const response = await axios.post("/tianjiang/auth/profile/password", input);
  const user = response.data.user as CentralUser;
  centralUser.value = user;
  return user;
}

export async function bootstrapAuth(): Promise<AuthBootstrapData> {
  const response = await axios.get("/tianjiang/auth/bootstrap");
  const data = (response.data ?? {}) as AuthBootstrapData;
  if (data.user && (data.mode === "session" || data.mode === "auto_login")) {
    centralUser.value = data.user;
    setAccountScope(data.user.id);
  }
  return data;
}

export async function clearSavedAccount(): Promise<void> {
  await axios.post("/tianjiang/auth/clear-saved-account");
}

export async function restoreCentralSession(): Promise<boolean> {
  try {
    const response = await axios.get("/tianjiang/auth/session");
    centralUser.value = response.data.user;
    setAccountScope(response.data.user?.id);
    return true;
  } catch {
    centralUser.value = null;
    setAccountScope(null);
    return false;
  }
}

export async function refreshCentralSession(): Promise<boolean> {
  try {
    const response = await axios.post("/tianjiang/auth/refresh");
    centralUser.value = response.data.user;
    setAccountScope(response.data.user?.id);
    return true;
  } catch {
    centralUser.value = null;
    setAccountScope(null);
    return false;
  }
}

export async function centralLogout(): Promise<void> {
  try {
    await axios.post("/tianjiang/auth/logout");
  } finally {
    centralUser.value = null;
    setAccountScope(null);
    try {
      const { modelCatalogStore } = await import("@/features/models/modelCatalogStore");
      modelCatalogStore.invalidateAll();
    } catch {
      // ignore
    }
    try {
      const { default: projectStore } = await import("@/stores/project");
      projectStore().resetSessionProjectState({ clearLocalList: true });
    } catch {
      // ignore
    }
  }
}
