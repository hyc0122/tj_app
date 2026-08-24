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
