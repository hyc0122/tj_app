import {
  CentralAuthGateway,
  MemoryCentralSessionStore,
  createTestOnlyLoopbackPolicy,
} from "./central-session";
import {
  acceptanceCentralApiUrl,
  isAcceptanceMode,
} from "../acceptance/isolation";
import { AuthCredentialStore } from "./auth-credential-store";
import { defaultCredentialStore } from "../crypto/default-credential-store";

// 进程内唯一会话运行时：中央 JWT 不写磁盘、不写数据库、不返回浏览器。
export const centralSessionStore = new MemoryCentralSessionStore();
const acceptanceCentralURL = acceptanceCentralApiUrl();
const acceptancePolicy = (() => {
  try {
    return isAcceptanceMode()
      ? createTestOnlyLoopbackPolicy(acceptanceCentralURL)
      : undefined;
  } catch (error) {
    throw new Error("验收中央 API URL 无效", { cause: error });
  }
})();
export const centralAuthGateway = new CentralAuthGateway(
  fetch,
  acceptancePolicy,
);

// 账号密码与持久化 token 仅允许 OS safeStorage（Electron）或内存测试实现。
export const authCredentialStore = new AuthCredentialStore(defaultCredentialStore);
