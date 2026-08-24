import path from "node:path";
import u from "@/utils";
import {
  ElectronCredentialStore,
  MemoryCredentialStore,
  type CredentialStore,
} from "./credential-store";

/**
 * 进程内唯一安全凭据后端：
 * Electron 使用 OS safeStorage 加密落盘；测试/纯 Node 使用内存实现。
 * 禁止 localStorage、明文 JSON、SQLite 保存密码或中央 token。
 */
export const defaultCredentialStore: CredentialStore = process.versions.electron
  ? new ElectronCredentialStore(path.join(u.getPath(), "secure-credentials.json"))
  : new MemoryCredentialStore();
