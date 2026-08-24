import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";

import {
  legacyUserStorageSegment,
  normalizeProductUserStorageIdentity,
  productUserStorageSegment,
} from "../identity/product-identity";

export interface UserStorageIdentity {
  issuer: string;
  userId: number;
}

export interface UserStorageContext extends UserStorageIdentity {
  segment: string;
  projectUuid?: string;
}

const storage = new AsyncLocalStorage<UserStorageContext>();

export function runWithUserStorage<T>(identity: UserStorageIdentity, run: () => T): T {
  return storage.run(createContext(identity), run);
}

export function enterUserStorage(identity: UserStorageIdentity): void {
  storage.enterWith(createContext(identity));
}

export function currentUserStorage(): UserStorageContext | undefined {
  return storage.getStore();
}

export function runWithProjectStorage<T>(projectUuid: string, run: () => T): T {
  const current = storage.getStore();
  if (!current) throw new Error("缺少中央用户存储上下文");
  if (!/^[0-9a-f-]{36}$/i.test(projectUuid)) throw new Error("项目 UUID 无效");
  return storage.run({ ...current, projectUuid }, run);
}

export function userStorageRoot(dataRoot: string, identity: UserStorageIdentity): string {
  return path.join(dataRoot, "runtime-users", createContext(identity).segment);
}

export function userStorageSegment(identity: UserStorageIdentity): string {
  return createContext(identity).segment;
}

/**
 * 首次使用新标识时原子迁移旧账号目录和活动指针。
 * 新旧目录同时存在时拒绝覆盖，确保任何一份用户数据都不会被静默删除。
 */
export function migrateLegacyUserStorageRoot(
  dataRoot: string,
  identity: UserStorageIdentity,
): void {
  const usersRoot = path.join(dataRoot, "runtime-users");
  const legacySegment = legacyUserStorageSegment(identity);
  const currentSegment = productUserStorageSegment(identity);
  const legacyRoot = path.join(usersRoot, legacySegment);
  const currentRoot = path.join(usersRoot, currentSegment);
  const legacyExists = fs.existsSync(legacyRoot);
  const currentExists = fs.existsSync(currentRoot);
  if (legacyExists && currentExists) {
    throw new Error("检测到新旧账号目录同时存在，已停止自动迁移以保护用户数据");
  }
  if (legacyExists) {
    fs.renameSync(legacyRoot, currentRoot);
  }

  const markerPath = path.join(usersRoot, "active-user.json");
  if (!fs.existsSync(markerPath)) return;
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as {
    segment?: unknown;
    [key: string]: unknown;
  };
  if (marker.segment !== legacySegment) return;
  if (!fs.existsSync(currentRoot)) {
    throw new Error("旧活动账号指针对应的用户目录不存在");
  }
  const temporaryPath = `${markerPath}.${process.pid}.identity-migration.tmp`;
  fs.writeFileSync(
    temporaryPath,
    JSON.stringify({
      ...marker,
      segment: currentSegment,
      identityMigratedAt: new Date().toISOString(),
    }, null, 2),
    { encoding: "utf8", mode: 0o600 },
  );
  fs.renameSync(temporaryPath, markerPath);
}

function createContext(identity: UserStorageIdentity): UserStorageContext {
  const normalized = normalizeProductUserStorageIdentity(identity);
  return {
    ...normalized,
    segment: productUserStorageSegment(normalized),
  };
}
