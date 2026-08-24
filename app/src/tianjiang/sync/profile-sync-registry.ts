export type ProfileSyncOwner = "account";
export type ProfileSerialization = "string" | "json";
export type ProfileSensitivity = "plain" | "encrypted";
export type ProfileConflictPolicy = "keywise-local-pending";

export interface ProfileSyncRegistration {
  matcher:
    | { kind: "exact"; value: string }
    | { kind: "prefix"; value: string };
  owner: ProfileSyncOwner;
  serialization: ProfileSerialization;
  sensitivity: ProfileSensitivity;
  conflictPolicy: ProfileConflictPolicy;
  writeEntry: string;
}

export const PROFILE_SYNC_KEY_NOT_REGISTERED = "PROFILE_SYNC_KEY_NOT_REGISTERED";

const accountPlain = (
  matcher: ProfileSyncRegistration["matcher"],
  writeEntry: string,
  serialization: ProfileSerialization = "string",
  sensitivity: ProfileSensitivity = "plain",
): ProfileSyncRegistration => ({
  matcher,
  owner: "account",
  serialization,
  sensitivity,
  conflictPolicy: "keywise-local-pending",
  writeEntry,
});

// 中文注释：只登记明确的设置写入口。禁止 setting. 通配整个账号库。
const REGISTRATIONS: readonly ProfileSyncRegistration[] = Object.freeze([
  accountPlain({ kind: "exact", value: "theme" }, "setting.theme"),
  accountPlain({ kind: "exact", value: "language" }, "setting.language"),
  accountPlain({ kind: "prefix", value: "provider." }, "setting.vendorConfig", "json", "encrypted"),
  accountPlain({ kind: "prefix", value: "vendor." }, "setting.vendorConfig", "json", "encrypted"),
  // 中文注释：点号等不能安全表示的供应商 ID 只用 vendorItem.<sha16>；安全 ID 只用 vendor.{id}。
  accountPlain({ kind: "prefix", value: "vendorItem." }, "setting.vendorConfig", "json", "encrypted"),
  accountPlain({ kind: "prefix", value: "model." }, "setting.modelMapping", "json"),
  accountPlain({ kind: "prefix", value: "agent." }, "setting.agentConfig", "json"),
  accountPlain({ kind: "prefix", value: "prompt." }, "setting.promptManager", "json"),
  accountPlain({ kind: "prefix", value: "skill." }, "setting.skillConfig", "json"),
  // 中文注释：显式删除 tombstone，禁止用「本机缺键」推断删除。
  accountPlain({ kind: "prefix", value: "deleted." }, "setting.collectionTombstone", "json"),
  accountPlain({ kind: "prefix", value: "memory." }, "setting.agentMemory", "json"),
  accountPlain({ kind: "exact", value: "messagesPerSummary" }, "setting.agentMemory"),
  accountPlain({ kind: "exact", value: "shortTermLimit" }, "setting.agentMemory"),
  accountPlain({ kind: "exact", value: "summaryMaxLength" }, "setting.agentMemory"),
  accountPlain({ kind: "exact", value: "summaryLimit" }, "setting.agentMemory"),
  accountPlain({ kind: "exact", value: "ragLimit" }, "setting.agentMemory"),
  accountPlain({ kind: "exact", value: "deepRetrieveSummaryLimit" }, "setting.agentMemory"),
  accountPlain({ kind: "exact", value: "modelOnnxFile" }, "setting.agentMemory", "json"),
  accountPlain({ kind: "exact", value: "modelDtype" }, "setting.agentMemory"),
  accountPlain({ kind: "exact", value: "agentUseMode" }, "setting.agentMemory"),
  accountPlain({ kind: "prefix", value: "legacy." }, "legacy-migrator", "json", "encrypted"),
]);

/** 中文注释：即梦 CLI 是设备本地能力，全部键禁止进入账号 ProfileSync。 */
export function isDeviceLocalProfileSyncKey(key: string): boolean {
  return key.startsWith("dreamina.");
}

export function listProfileSyncRegistrations(): readonly ProfileSyncRegistration[] {
  return REGISTRATIONS;
}

export function findProfileSyncRegistration(key: string): ProfileSyncRegistration | undefined {
  return REGISTRATIONS.find((registration) => matchesRegistration(key, registration));
}

export function isRegisteredProfileSyncKey(key: string): boolean {
  return findProfileSyncRegistration(key) !== undefined;
}

export function assertRegisteredProfileSyncKey(key: string): void {
  if (!isRegisteredProfileSyncKey(key)) {
    throw new Error(`${PROFILE_SYNC_KEY_NOT_REGISTERED}: ${key}`);
  }
}

export function registeredSensitivity(key: string): ProfileSensitivity {
  const registration = findProfileSyncRegistration(key);
  if (!registration) {
    throw new Error(`${PROFILE_SYNC_KEY_NOT_REGISTERED}: ${key}`);
  }
  return registration.sensitivity;
}

export function assertRegistrySensitivity(key: string, sensitive: boolean): void {
  const expected = registeredSensitivity(key) === "encrypted";
  if (expected !== sensitive) {
    throw new Error(`PROFILE_SYNC_SENSITIVITY_MISMATCH: ${key}`);
  }
}

function matchesRegistration(key: string, registration: ProfileSyncRegistration): boolean {
  if (registration.matcher.kind === "exact") return key === registration.matcher.value;
  return key.startsWith(registration.matcher.value) && key.length > registration.matcher.value.length;
}
