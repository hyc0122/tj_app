/**
 * 即梦 CLI 启停单调 revision 与探测代际。
 * 中文注释：每次探测拿不可变 generation token；end 只能清除自己的 token，旧探测不得删新守卫。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { currentUserStorage } from "@/tianjiang/runtime/user-storage-context";

export interface DreaminaProbeToken {
  readonly generation: number;
  readonly segment: string;
  readonly revision: number;
  readonly epoch: number;
  readonly executablePath: string | null;
  readonly updatedAt: number;
}

const revisionBySegment = new Map<string, number>();
const epochBySegment = new Map<string, number>();
const serialBySegment = new Map<string, Promise<unknown>>();
const probeTokenBySegment = new Map<string, DreaminaProbeToken>();
const probeRefCountBySegment = new Map<string, number>();
const probeTokenAls = new AsyncLocalStorage<DreaminaProbeToken>();
let nextProbeGeneration = 0;

function segmentOrThrow(): string {
  const segment = currentUserStorage()?.segment;
  if (!segment) throw new Error("缺少账号上下文");
  return segment;
}

function stale(): never {
  throw Object.assign(new Error("即梦 CLI 启停状态已变化"), {
    status: 409,
    code: "DREAMINA_CLI_ENABLEMENT_STALE",
  });
}

export function readDreaminaEnablementRevision(segment?: string): number {
  const key = segment ?? currentUserStorage()?.segment;
  if (!key) return 0;
  return revisionBySegment.get(key) ?? 0;
}

export function bumpDreaminaEnablementRevision(): number {
  const segment = segmentOrThrow();
  const next = Math.max(1, (revisionBySegment.get(segment) ?? 0) + 1);
  revisionBySegment.set(segment, next);
  return next;
}

export function readDreaminaProbeEpoch(segment?: string): number {
  const key = segment ?? currentUserStorage()?.segment;
  if (!key) return 0;
  return epochBySegment.get(key) ?? 0;
}

export function bumpDreaminaProbeEpoch(): number {
  const segment = segmentOrThrow();
  const next = Math.max(1, (epochBySegment.get(segment) ?? 0) + 1);
  epochBySegment.set(segment, next);
  return next;
}

function sameProbePath(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  const normalize = (value: string) => (process.platform === "win32"
    ? value.replace(/\\/g, "/").toLocaleLowerCase("en-US")
    : value);
  return normalize(left) === normalize(right);
}

export function currentDreaminaProbeToken(): DreaminaProbeToken | undefined {
  return probeTokenAls.getStore();
}

export interface DreaminaProbeBeginIdentity {
  revision: number;
  epoch: number;
  executablePath: string | null;
  updatedAt?: number;
}

const authoritativeBySegment = new Map<string, {
  executablePath: string | null;
  updatedAt: number;
}>();

export function syncDreaminaAuthoritativeProbeIdentity(identity: {
  executablePath: string | null;
  updatedAt: number;
}): void {
  const segment = currentUserStorage()?.segment;
  if (!segment) return;
  authoritativeBySegment.set(segment, {
    executablePath: identity.executablePath,
    updatedAt: identity.updatedAt,
  });
}

export function readDreaminaAuthoritativeProbeIdentity(segment?: string): {
  executablePath: string | null;
  updatedAt: number;
} | undefined {
  const key = segment ?? currentUserStorage()?.segment;
  if (!key) return undefined;
  return authoritativeBySegment.get(key);
}

export function sameDreaminaProbePath(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  return sameProbePath(left, right);
}

export function dreaminaProbePathKey(value: string | null | undefined): string {
  if (!value) return "";
  return process.platform === "win32"
    ? value.replace(/\\/g, "/").toLocaleLowerCase("en-US")
    : value;
}

export function beginDreaminaEnablementProbe(
  expected: DreaminaProbeBeginIdentity,
): DreaminaProbeToken {
  const segment = segmentOrThrow();
  const currentRevision = readDreaminaEnablementRevision();
  const currentEpoch = readDreaminaProbeEpoch();
  // 中文注释：任何 token/refcount 修改前先做完整身份 CAS，禁止“新 revision/epoch + 旧路径”。
  if (expected.revision !== currentRevision) stale();
  if (expected.epoch !== currentEpoch) stale();
  const existing = probeTokenBySegment.get(segment);
  if (existing && existing.revision === currentRevision && existing.epoch === currentEpoch) {
    if (!sameProbePath(existing.executablePath, expected.executablePath)) stale();
    probeRefCountBySegment.set(segment, (probeRefCountBySegment.get(segment) ?? 1) + 1);
    return existing;
  }
  const authoritative = authoritativeBySegment.get(segment);
  // 中文注释：空 token 也必须核对权威路径，禁止旧路径贴上新 revision/epoch。
  // updatedAt 由 reserve 在锁内对照最新 settings CAS；此处只拦路径身份，避免辅助写入推进 updatedAt 后误伤。
  if (authoritative && !sameProbePath(expected.executablePath, authoritative.executablePath)) stale();
  const token: DreaminaProbeToken = {
    generation: ++nextProbeGeneration,
    segment,
    revision: expected.revision,
    epoch: expected.epoch,
    executablePath: expected.executablePath,
    updatedAt: expected.updatedAt ?? 0,
  };
  probeTokenBySegment.set(segment, token);
  probeRefCountBySegment.set(segment, 1);
  if (beginCreatedHookForTests) beginCreatedHookForTests(token);
  return token;
}

let beginCreatedHookForTests: ((token: DreaminaProbeToken) => void) | null = null;

export function setDreaminaBeginCreatedHookForTests(
  hook: ((token: DreaminaProbeToken) => void) | null,
): void {
  if (!process.env.NODE_TEST_CONTEXT) return;
  beginCreatedHookForTests = hook;
}

export function endDreaminaEnablementProbe(expected?: DreaminaProbeToken): void {
  // 中文注释：只能按传入 token 清除自己的守卫；无 token 或代际不匹配时不得删除新探测。
  if (!expected) return;
  const current = probeTokenBySegment.get(expected.segment);
  if (!current || current.generation !== expected.generation) return;
  const remaining = (probeRefCountBySegment.get(expected.segment) ?? 1) - 1;
  if (remaining > 0) {
    probeRefCountBySegment.set(expected.segment, remaining);
    return;
  }
  probeTokenBySegment.delete(expected.segment);
  probeRefCountBySegment.delete(expected.segment);
}

export function assertDreaminaEnablementRevision(expected?: DreaminaProbeToken | number): void {
  const segment = currentUserStorage()?.segment;
  if (!segment) return;
  const token = expected && typeof expected === "object"
    ? expected
    : probeTokenAls.getStore();
  if (token) {
    const current = probeTokenBySegment.get(token.segment);
    if (!current || current.generation !== token.generation) stale();
    if (readDreaminaEnablementRevision() !== token.revision) stale();
    if (readDreaminaProbeEpoch() !== token.epoch) stale();
    return;
  }
  if (typeof expected === "number") {
    if (readDreaminaEnablementRevision() !== expected) stale();
    return;
  }
  const current = probeTokenBySegment.get(segment);
  if (!current) return;
  if (readDreaminaEnablementRevision() !== current.revision) stale();
}

function isBareExecutableName(value: string): boolean {
  return Boolean(value)
    && !/[\\/]/.test(value)
    && !/\.(exe|cmd|bat|cjs|mjs|js)$/i.test(value);
}

export async function sameDreaminaExecutionTarget(
  left: string | null | undefined,
  right: string | null | undefined,
): Promise<boolean> {
  if (!left && !right) return true;
  if (!left || !right) return false;
  if (sameProbePath(left, right)) return true;
  const resolveIfBare = async (value: string): Promise<string> => {
    if (!isBareExecutableName(value)) return value;
    const { resolveDreaminaExecutable } = await import("./cli-truth");
    try {
      return await resolveDreaminaExecutable(value);
    } catch {
      return value;
    }
  };
  return sameProbePath(await resolveIfBare(left), await resolveIfBare(right));
}

export async function assertDreaminaProbeIdentity(
  expectedPath?: string | null,
  expectedToken?: DreaminaProbeToken,
): Promise<void> {
  const token = expectedToken ?? probeTokenAls.getStore();
  if (!token) {
    assertDreaminaEnablementRevision();
    return;
  }
  assertDreaminaEnablementRevision(token);
  if (readDreaminaProbeEpoch() !== token.epoch) stale();
  const { readDreaminaCliSettings } = await import("./session-store");
  const settings = await readDreaminaCliSettings();
  if (token?.updatedAt && settings.updatedAt !== token.updatedAt) {
    // 中文注释：updatedAt 变化表示设置已被别人改写；裸命令解析成绝对路径除外，由调用方在同一临界区处理。
    const sameTarget = token.executablePath
      ? await sameDreaminaExecutionTarget(token.executablePath, settings.executablePath)
      : false;
    if (!sameTarget) stale();
  }
  if (token?.executablePath && !(await sameDreaminaExecutionTarget(token.executablePath, settings.executablePath))) {
    stale();
  }
  if (expectedPath && token?.executablePath) {
    const expectedMatchesToken = await sameDreaminaExecutionTarget(expectedPath, token.executablePath);
    const expectedMatchesSettings = await sameDreaminaExecutionTarget(expectedPath, settings.executablePath);
    if (!expectedMatchesToken && !expectedMatchesSettings) stale();
  }
}

export async function runWithDreaminaProbeToken<T>(
  token: DreaminaProbeToken,
  work: () => Promise<T>,
): Promise<T> {
  return probeTokenAls.run(token, work);
}

export async function runSerializedDreaminaEnablement<T>(work: () => Promise<T>): Promise<T> {
  const segment = segmentOrThrow();
  const previous = serialBySegment.get(segment) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  serialBySegment.set(segment, previous.then(() => current, () => current));
  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
  }
}

export function isDreaminaEnablementStaleError(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "DREAMINA_CLI_ENABLEMENT_STALE");
}

export function resetDreaminaEnablementForTests(): void {
  if (!process.env.NODE_TEST_CONTEXT) return;
  revisionBySegment.clear();
  epochBySegment.clear();
  probeTokenBySegment.clear();
  probeRefCountBySegment.clear();
  serialBySegment.clear();
  authoritativeBySegment.clear();
  nextProbeGeneration = 0;
  beginCreatedHookForTests = null;
  afterSettingsReadBeforeBeginHookForTests = null;
}

export async function reserveDreaminaProbeForCurrentSettings(
  expected?: { executablePath?: string | null; updatedAt?: number },
): Promise<DreaminaProbeToken | null> {
  return runSerializedDreaminaEnablement(async () => {
    const { readDreaminaCliSettings } = await import("./session-store");
    const settings = await readDreaminaCliSettings();
    if (settings.enabled === false) return null;
    if (expected) {
      if (
        expected.executablePath !== undefined
        && !sameProbePath(expected.executablePath, settings.executablePath)
      ) {
        stale();
      }
      if (expected.updatedAt != null && expected.updatedAt !== settings.updatedAt) stale();
    }
    const identity: DreaminaProbeBeginIdentity = {
      revision: readDreaminaEnablementRevision(),
      epoch: readDreaminaProbeEpoch(),
      executablePath: settings.executablePath,
      updatedAt: settings.updatedAt,
    };
    syncDreaminaAuthoritativeProbeIdentity({
      executablePath: settings.executablePath,
      updatedAt: settings.updatedAt,
    });
    return beginDreaminaEnablementProbe(identity);
  });
}

let afterSettingsReadBeforeBeginHookForTests: (() => Promise<void> | void) | null = null;

export function setDreaminaAfterSettingsReadBeforeBeginHookForTests(
  hook: (() => Promise<void> | void) | null,
): void {
  if (!process.env.NODE_TEST_CONTEXT) return;
  afterSettingsReadBeforeBeginHookForTests = hook;
}

export async function runDreaminaAfterSettingsReadBeforeBeginHookForTests(): Promise<void> {
  if (afterSettingsReadBeforeBeginHookForTests) await afterSettingsReadBeforeBeginHookForTests();
}

export function readDreaminaProbeGuardForTests(): {
  token: DreaminaProbeToken | undefined;
  refCount: number;
} {
  if (!process.env.NODE_TEST_CONTEXT) return { token: undefined, refCount: 0 };
  const segment = currentUserStorage()?.segment;
  if (!segment) return { token: undefined, refCount: 0 };
  return {
    token: probeTokenBySegment.get(segment),
    refCount: probeRefCountBySegment.get(segment) ?? 0,
  };
}
