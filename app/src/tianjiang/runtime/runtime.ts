import u from "@/utils";
import { centralAuthGateway } from "../auth/auth-runtime";
import { SyncCoordinator } from "./sync-coordinator";
import { defaultCredentialStore } from "../crypto/default-credential-store";

// 生产进程只保留一个协调器实例，登录路由和所有同步路由共享同一状态。
// 与 authCredentialStore 共用同一 safeStorage 后端，键名按前缀隔离。
const dataRoot = u.getPath();
export const credentialStore = defaultCredentialStore;
export const syncCoordinator = new SyncCoordinator(dataRoot, centralAuthGateway, credentialStore);
