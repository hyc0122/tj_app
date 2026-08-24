import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import type { Knex } from "knex";

import { accountDb, db as activeDb } from "@/utils/db";
import getPath from "@/utils/getPath";
import { getStableDeviceUUID } from "@/tianjiang/auth/device";
import { currentUserStorage, runWithProjectStorage } from "@/tianjiang/runtime/user-storage-context";
import { registerGenerationRuntimeParticipant } from "@/tianjiang/tasks/generation-runtime-participants";
import { upsertPendingMutationJournalInTrx } from "@/tianjiang/runtime/legacy-mutation-journal";
import { StoryboardService } from "@/tianjiang/storyboard/storyboard-service";
import {
  hashFileStreaming,
  openProjectFileIdentity,
  type OpenProjectFileIdentity,
} from "@/tianjiang/media/project-file-inventory";
import {
  assertManagedPathChainHasNoLinks,
  classifyProjectFile,
  closeProjectFileHandle,
  copyOpenProjectFileHandleToExclusivePath,
  type ExclusiveDestinationIdentity,
} from "@/tianjiang/media/project-file-store";
import {
  parseDreaminaImageModel,
  parseDreaminaVideoModel,
  readWorkbenchGenerationOrigin,
  type ProjectMediaReference,
} from "@/tianjiang/storyboard/storyboard-generation-service";
import { DREAMINA_ERROR, DREAMINA_MODES, type DreaminaMode } from "./contracts";
import { resolveDreaminaExecutable } from "./cli-truth";
import { createDreaminaCliProvider } from "./provider";
import { DreaminaProcessError } from "./process-runner";
import { readDreaminaEnablementRevision, runSerializedDreaminaEnablement } from "./dreamina-enablement";
import {
  readDreaminaCliSettings,
  resolveDreaminaPauseReason,
  writeDreaminaCliSettings,
} from "./session-store";
import {
  claimNextDreaminaDispatch,
  hasUnknownSlot,
  shouldDispatchOnThisDevice,
} from "./task-store";
import { installDreaminaResult } from "./result-installer";
import { assertAcceptedDreaminaEnqueueIntegrity } from "../async-generation-service";

let participantRegistered = false;
let loopTimer: ReturnType<typeof setInterval> | undefined;
type DreaminaTickResult = { claimed: string[] };
let tickInFlight: Promise<DreaminaTickResult> | undefined;
const inFlightSubmits = new Map<string, Promise<void>>();
const lifecycleDrainCountsByUserSegment = new Map<string, number>();
let claimBoundaryInFlight = 0;
let nextClaimBoundaryId = 1;
let claimBoundaryHookDepth = 0;
const activeClaimBoundaryIds = new Set<number>();
const claimBoundaryAls = new AsyncLocalStorage<number>();
const claimBoundaryDrainWaiters = new Set<() => void>();
let afterEnabledReadForTests: (() => Promise<void> | void) | null = null;
let afterLastEnabledCheckForTests: (() => Promise<void> | void) | null = null;

export function setDreaminaSchedulerAfterEnabledReadForTests(
  hook: (() => Promise<void> | void) | null,
): void {
  if (!process.env.NODE_TEST_CONTEXT) return;
  afterEnabledReadForTests = hook;
}

export function setDreaminaSchedulerAfterLastEnabledCheckForTests(
  hook: (() => Promise<void> | void) | null,
): void {
  if (!process.env.NODE_TEST_CONTEXT) return;
  afterLastEnabledCheckForTests = hook;
}

interface DispatchWriteFence {
  queueState: string;
  providerState: string;
  slotHeld: number;
  providerResultJson: unknown;
  updatedAt: number;
}

interface ProjectTaskMirrorPatch {
  [key: string]: unknown;
  status: "failed_fatal" | "failed_retryable" | "completed";
  providerTaskId?: string;
  providerCompletedAt?: number;
  errorCode?: string;
  errorSummary?: string;
}

interface DispatchWriteSnapshot {
  taskUuid: string;
  projectUuid: string;
  queueState: string;
  providerState: string;
  slotHeld: number;
  providerResultJson: unknown;
  updatedAt: number;
}

/** 账号激活后注册退出门参与者：暂停新领取并等待真实 submit 临界区落盘。 */
export function ensureDreaminaSchedulerStarted(): void {
  if (participantRegistered) return;
  participantRegistered = true;
  registerGenerationRuntimeParticipant({
    async pauseNewWorkAndDrainCriticalSection() {
      const context = currentUserStorage();
      if (!context) return;
      // 中文注释：先同步关闭进程内领取门，再做异步设置写入，封死 tick 已越过持久化检查的窗口。
      const leaveLifecycleDrain = enterDreaminaLifecycleDrain(context.segment);
      try {
        await runSerializedDreaminaEnablement(async () => {
          const settings = await readDreaminaCliSettings();
          // 中文注释：生命周期排空不得覆盖用户主动暂停，手动暂停必须跨关闭和重启保留。
          if (settings.pauseReason !== "manual_pause") {
            await writeDreaminaCliSettings({ pauseReason: "lifecycle_drain" });
          }
        });
        await drainDreaminaSubmitCriticalSection();
      } finally {
        leaveLifecycleDrain();
      }
    },
    async resume() {
      if (!currentUserStorage()) return;
      // 中文注释：另一个同账号 pause/drain 尚未结束时，失败补偿不得覆盖它的暂停设置。
      if (isDreaminaLifecycleDrainActiveForCurrentUser()) return;
      await runSerializedDreaminaEnablement(async () => {
        const settings = await readDreaminaCliSettings();
        if (settings.pauseReason === "lifecycle_drain") {
          await writeDreaminaCliSettings({ pauseReason: "none" });
        }
      });
      if (isDreaminaLifecycleDrainActiveForCurrentUser()) {
        await runSerializedDreaminaEnablement(() => writeDreaminaCliSettings({ pauseReason: "lifecycle_drain" }));
        return;
      }
      wakeDreaminaScheduler();
    },
    async stop() {
      stopDreaminaSchedulerLoop();
      const context = currentUserStorage();
      if (!context) return;
      const leaveLifecycleDrain = enterDreaminaLifecycleDrain(context.segment);
      try {
        await runSerializedDreaminaEnablement(async () => {
          const settings = await readDreaminaCliSettings();
          if (settings.pauseReason !== "manual_pause") {
            await writeDreaminaCliSettings({ pauseReason: "lifecycle_drain" });
          }
        });
        await drainDreaminaSubmitCriticalSection();
      } finally {
        leaveLifecycleDrain();
      }
    },
  });
}

/** 启动账号级自动调度循环。测试未设置间隔时不自动跑，避免与手工 tick 竞态。 */
export function startDreaminaSchedulerLoop(): void {
  ensureDreaminaSchedulerStarted();
  if (process.env.NODE_TEST_CONTEXT && !process.env.DREAMINA_SCHEDULER_INTERVAL_MS) return;
  if (loopTimer) {
    void safeTick();
    return;
  }
  const interval = Math.max(50, Number(process.env.DREAMINA_SCHEDULER_INTERVAL_MS || 400));
  loopTimer = setInterval(() => {
    void safeTick();
  }, interval);
  loopTimer.unref?.();
  void safeTick();
}

export function stopDreaminaSchedulerLoop(): void {
  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = undefined;
  }
  resetDreaminaSchedulerWakeCountForTests();
}

let wakeCountForTests = 0;

export function readDreaminaSchedulerWakeCountForTests(): number {
  return process.env.NODE_TEST_CONTEXT ? wakeCountForTests : 0;
}

export function resetDreaminaSchedulerWakeCountForTests(): void {
  if (!process.env.NODE_TEST_CONTEXT) return;
  wakeCountForTests = 0;
}

export function wakeDreaminaScheduler(): void {
  if (process.env.NODE_TEST_CONTEXT) wakeCountForTests += 1;
  startDreaminaSchedulerLoop();
  if (process.env.NODE_TEST_CONTEXT && !process.env.DREAMINA_SCHEDULER_INTERVAL_MS) return;
  void safeTick();
}

/** HTTP/失败补偿只能在当前账号没有 lifecycle drain 时恢复领取。 */
export function isDreaminaLifecycleDrainActiveForCurrentUser(): boolean {
  const segment = currentUserStorage()?.segment;
  return Boolean(segment && (lifecycleDrainCountsByUserSegment.get(segment) ?? 0) > 0);
}

function safeTick(): Promise<void> {
  return tickDreaminaScheduler().then(() => undefined).catch(() => undefined);
}

function startTick(): Promise<DreaminaTickResult> {
  const running = runDreaminaSchedulerTick()
    .finally(() => {
      // 中文注释：旧 Promise 结束时不得清掉已经排入的后继 tick。
      if (tickInFlight === running) tickInFlight = undefined;
    });
  tickInFlight = running;
  return running;
}

/**
 * 等待所有已进入真实 spawn/submit 的 Promise 落到耐久态。
 * 禁止把仍在 submit 的 claiming/not_sent 直接改回 queued。
 */
export async function drainDreaminaSubmitCriticalSection(): Promise<void> {
  // 中文注释：公开 tick 串行后，后继 tick 可能已排队但尚未登记 submit Promise；
  // 退出门必须先等待当前和尾随 tick 都稳定结束，再快照真实 submit。
  while (tickInFlight) {
    const pendingTick = tickInFlight;
    await pendingTick.catch(() => undefined);
  }
  // 中文注释：再等“暂停检查→领取→inFlight 登记”边界清空；边界退出前要么释放领取，要么已经可被下方等待看到。
  await waitForDreaminaClaimBoundaryDrain();
  await Promise.all([...inFlightSubmits.values()].map((item) => item.catch(() => undefined)));
  // 在途 Promise 已结束后，剩余 claiming/not_sent 属于未 spawn 的崩溃残留，可安全回 queued。
  const leftovers = await accountDb("o_dreaminaCliDispatch")
    .where({ queueState: "claiming", providerState: "not_sent" })
    .select("taskUuid", "providerResultJson");
  for (const row of leftovers) {
    if (inFlightSubmits.has(String(row.taskUuid))) continue;
    const parsed = safeJson(row.providerResultJson);
    if (parsed.submitStarted) {
      // 已经进入真实 submit，无法确认远端是否扣费：保持占槽并阻断新领取。
      await persistDispatch(String(row.taskUuid), {
        queueState: "provider_active",
        providerState: "unknown",
        slotHeld: 1,
        providerResultJson: { message: "退出或崩溃时 submit 结果待确认" },
      });
      continue;
    }
    await accountDb("o_dreaminaCliDispatch").where({ taskUuid: row.taskUuid }).update({
      queueState: "queued",
      slotHeld: 0,
      leaseOwner: null,
      updatedAt: Date.now(),
    });
  }
}

/**
 * 一次调度 tick：先推进已提交任务的 query/安装，再按三层限额领取 queued。
 */
export function tickDreaminaScheduler(): Promise<DreaminaTickResult> {
  if (tickInFlight) {
    const waitForCurrent = () => tickInFlight ?? startTick();
    // 中文注释：恢复、自动循环和手工 tick 共用同一串行入口；多个等待者只合并为一个尾随 tick。
    return tickInFlight.then(waitForCurrent, waitForCurrent);
  }
  return startTick();
}

async function runDreaminaSchedulerTick(): Promise<DreaminaTickResult> {
  ensureDreaminaSchedulerStarted();
  await reapExpiredDreaminaClaims();
  await reconcilePendingProjectTaskMirrors();
  await refreshQueuedConcurrencySnapshots();
  await queryActiveDreaminaTasks();
  await installPostprocessingTasks();

  const leaveClaimBoundary = enterDreaminaClaimBoundary();
  if (!leaveClaimBoundary) return { claimed: [] };
  let claimed: Awaited<ReturnType<typeof claimNextDreaminaDispatch>> = null;
  let work: Promise<void> | undefined;
  try {
    const settings = await readDreaminaCliSettings();
    const revisionAtEnabledRead = readDreaminaEnablementRevision();
    if (settings.enabled === false) return { claimed: [] };
    if (afterEnabledReadForTests) {
      // 中文注释：关闭若从领取边界内的测试钩子发出，HTTP 侧看不到 ALS，必须记 hookDepth 以免自等死锁。
      claimBoundaryHookDepth += 1;
      try {
        await afterEnabledReadForTests();
      } finally {
        claimBoundaryHookDepth -= 1;
      }
    }
    // 中文注释：关闭响应返回后必须立刻重读 enabled/领取门，禁止继续走旧的 read→claim 窗口。
    const beforeClaim = await readDreaminaCliSettings();
    if (
      beforeClaim.enabled === false
      || beforeClaim.pauseNewClaims
      || lifecycleClaimsPausedForCurrentUser()
    ) {
      return { claimed: [] };
    }
    if (await hasUnknownSlot()) return { claimed: [] };

    const currentDevice = getStableDeviceUUID(getPath());
    const leaseOwner = `scheduler-${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
    claimed = await claimNextDreaminaDispatch({
      currentDeviceUuid: currentDevice,
      accountLimit: beforeClaim.maxConcurrency,
      leaseOwner,
    });
    if (!claimed) return { claimed: [] };
    const latest = await readDreaminaCliSettings();
    const latestRevision = readDreaminaEnablementRevision();
    // 中文注释：claim 后、真正 spawn 前复查 enabled、transition revision 与生命周期领取门。
    if (
      latest.enabled === false
      || latest.pauseNewClaims
      || lifecycleClaimsPausedForCurrentUser()
      || (latestRevision !== revisionAtEnabledRead && latest.enabled !== true)
    ) {
      await releaseUnsubmittedClaim(claimed.taskUuid, claimed.leaseOwner, new Error("即梦 CLI 已关闭"));
      claimed = null;
      return { claimed: [] };
    }
    if (afterLastEnabledCheckForTests) {
      claimBoundaryHookDepth += 1;
      try {
        await afterLastEnabledCheckForTests();
      } finally {
        claimBoundaryHookDepth -= 1;
      }
    }
    // 中文注释：关闭响应返回后、解析 executable 与 spawn 前必须再读权威 enabled 与领取门。
    const beforeSpawn = await readDreaminaCliSettings();
    if (
      beforeSpawn.enabled === false
      || beforeSpawn.pauseNewClaims
      || lifecycleClaimsPausedForCurrentUser()
    ) {
      await releaseUnsubmittedClaim(claimed.taskUuid, claimed.leaseOwner, new Error("即梦 CLI 已关闭"));
      claimed = null;
      return { claimed: [] };
    }
    if (!shouldDispatchOnThisDevice(claimed.projectUuid ? currentDevice : currentDevice, currentDevice)) {
      // 领取条件已按 originDevice 过滤。
    }

    let executable: string;
    try {
      // 中文注释：调度必须复用唯一解析入口，禁止把裸 dreamina 直接交给 spawn。
      executable = await resolveDreaminaExecutable(beforeSpawn.executablePath);
    } catch (error) {
      await releaseUnsubmittedClaim(
        claimed.taskUuid,
        claimed.leaseOwner,
        error instanceof Error ? error : new Error("未安装即梦 CLI"),
      );
      claimed = null;
      return { claimed: [] };
    }
    const beforeRegister = await readDreaminaCliSettings();
    if (beforeRegister.enabled === false || lifecycleClaimsPausedForCurrentUser()) {
      await releaseUnsubmittedClaim(claimed.taskUuid, claimed.leaseOwner, new Error("即梦 CLI 已关闭"));
      claimed = null;
      return { claimed: [] };
    }
    work = runClaimedTask(
      claimed.taskUuid,
      claimed.projectUuid,
      claimed.mode,
      claimed.leaseOwner,
      executable,
      beforeSpawn.pollSeconds,
    );
    // 中文注释：必须先登记真实 submit Promise，再退出领取边界，drain 才不会观察到两边都为空。
    inFlightSubmits.set(claimed.taskUuid, work);
  } finally {
    leaveClaimBoundary();
  }
  if (!claimed || !work) return { claimed: [] };
  try {
    await work;
  } finally {
    // 中文注释：旧 lease 与 replacement lease 短暂重叠时，旧 Promise 不得误删仍在真实 submit 的新 Promise。
    if (inFlightSubmits.get(claimed.taskUuid) === work) {
      inFlightSubmits.delete(claimed.taskUuid);
    }
  }
  return { claimed: [claimed.taskUuid] };
}

/** 同步进入领取边界；pause 设置门和 tick 进入边界在同一事件循环中不可交错。 */
function enterDreaminaClaimBoundary(): (() => void) | null {
  if (lifecycleClaimsPausedForCurrentUser()) return null;
  const boundaryId = nextClaimBoundaryId++;
  activeClaimBoundaryIds.add(boundaryId);
  claimBoundaryAls.enterWith(boundaryId);
  claimBoundaryInFlight += 1;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    activeClaimBoundaryIds.delete(boundaryId);
    claimBoundaryInFlight -= 1;
    for (const notify of claimBoundaryDrainWaiters) notify();
  };
}

function lifecycleClaimsPausedForCurrentUser(): boolean {
  return isDreaminaLifecycleDrainActiveForCurrentUser();
}

export function pauseDreaminaClaimsForEnablement(): () => void {
  const segment = currentUserStorage()?.segment;
  if (!segment) return () => undefined;
  return enterDreaminaLifecycleDrain(segment);
}

export function isDreaminaClaimBoundaryActive(): boolean {
  return claimBoundaryInFlight > 0;
}

function enterDreaminaLifecycleDrain(segment: string): () => void {
  lifecycleDrainCountsByUserSegment.set(
    segment,
    (lifecycleDrainCountsByUserSegment.get(segment) ?? 0) + 1,
  );
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const remaining = (lifecycleDrainCountsByUserSegment.get(segment) ?? 1) - 1;
    if (remaining > 0) lifecycleDrainCountsByUserSegment.set(segment, remaining);
    else lifecycleDrainCountsByUserSegment.delete(segment);
  };
}

export function waitForDreaminaClaimBoundaryDrain(): Promise<void> {
  // 中文注释：只跳过当前 ALS owner，以及正在同步等待关闭响应的 hook boundary，禁止用任意 active 整段跳过。
  const self = claimBoundaryAls.getStore();
  const othersActive = () => {
    const others = [...activeClaimBoundaryIds].filter((id) => id !== self);
    if (claimBoundaryHookDepth > 0 && others.length <= claimBoundaryHookDepth) return false;
    return others.length > 0;
  };
  if (!othersActive()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const notify = () => {
      if (othersActive()) return;
      claimBoundaryDrainWaiters.delete(notify);
      resolve();
    };
    claimBoundaryDrainWaiters.add(notify);
  });
}

/**
 * 回收已过期且不属于本进程在途 Promise 的领取租约。
 * submitStarted 表示可能已产生收费，只能转 unknown，绝不能自动重提。
 */
export async function reapExpiredDreaminaClaims(now = Date.now()): Promise<number> {
  return recoverDreaminaClaimingSlots({ now, includeUnexpired: false });
}

/**
 * 冷启动与手工恢复共用同一 inFlight 感知 CAS；运行时调用绝不能绕过本进程提交事实。
 * includeUnexpired 仅供显式恢复使用，定时 reaper 仍只处理过期租约。
 */
export async function recoverDreaminaClaimingSlots(options: {
  now?: number;
  includeUnexpired?: boolean;
} = {}): Promise<number> {
  const now = options.now ?? Date.now();
  let candidates = accountDb("o_dreaminaCliDispatch")
    .where({ queueState: "claiming", providerState: "not_sent", slotHeld: 1 });
  if (!options.includeUnexpired) {
    candidates = candidates.whereNotNull("leaseExpiresAt").andWhere("leaseExpiresAt", "<=", now);
  }
  const expired = await candidates.select("taskUuid", "providerResultJson", "leaseOwner");
  let recovered = 0;
  for (const row of expired) {
    const taskUuid = String(row.taskUuid);
    // 中文注释：本进程真实 submit 可能超过 30 秒，过期时间不能越过 inFlight 事实。
    if (inFlightSubmits.has(taskUuid)) continue;
    const parsed = safeJson(row.providerResultJson);
    let guardedUpdate = accountDb("o_dreaminaCliDispatch")
      .where({ taskUuid, queueState: "claiming", providerState: "not_sent", slotHeld: 1 });
    if (!options.includeUnexpired) {
      guardedUpdate = guardedUpdate
        .whereNotNull("leaseExpiresAt")
        .andWhere("leaseExpiresAt", "<=", now);
    }
    // 中文注释：状态未变但 submitStarted 证据已落盘时也不能沿用扫描时的旧判断。
    guardedUpdate = row.providerResultJson === null || row.providerResultJson === undefined
      ? guardedUpdate.whereNull("providerResultJson")
      : guardedUpdate.andWhere("providerResultJson", row.providerResultJson);
    // 中文注释：同状态、同结果也可能已经换过 lease；恢复只能改写扫描时看到的原领取者。
    guardedUpdate = guardedUpdate.whereRaw(
      "COALESCE(leaseOwner, '') = COALESCE(?, '')",
      [row.leaseOwner],
    );
    let updated = 0;
    if (parsed.submitStarted) {
      updated = await guardedUpdate.update({
        queueState: "provider_active",
        providerState: "unknown",
        slotHeld: 1,
        leaseOwner: null,
        leaseExpiresAt: null,
        providerResultJson: JSON.stringify({
          ...parsed,
          message: "领取租约过期且 submit 结果待确认，禁止自动重提",
        }),
        updatedAt: Date.now(),
      });
    } else {
      updated = await guardedUpdate.update({
        queueState: "queued",
        providerState: "not_sent",
        slotHeld: 0,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: Date.now(),
      });
    }
    // 只有完整旧状态仍匹配且实际更新一行，才计为本轮成功回收。
    if (updated === 1) recovered += 1;
  }
  return recovered;
}

async function refreshQueuedConcurrencySnapshots(): Promise<void> {
  const queued = await accountDb("o_dreaminaCliDispatch")
    .where({ queueState: "queued", providerState: "not_sent" })
    .select("taskUuid", "projectUuid", "mediaType");
  const seen = new Set<string>();
  for (const row of queued) {
    const projectUuid = String(row.projectUuid);
    if (seen.has(projectUuid)) continue;
    seen.add(projectUuid);
    try {
      const settings = await new StoryboardService(projectUuid).getSettings();
      const imageLimit = Number(settings.imageConcurrency) || 1;
      const videoLimit = Number(settings.videoConcurrency) || 1;
      await accountDb("o_dreaminaCliDispatch")
        .where({ projectUuid, queueState: "queued" })
        .update({
          projectConcurrencyLimit: imageLimit,
          updatedAt: Date.now(),
        });
      await accountDb("o_dreaminaCliDispatch")
        .where({ projectUuid, queueState: "queued", mediaType: "video" })
        .update({
          projectConcurrencyLimit: videoLimit,
          updatedAt: Date.now(),
        });
    } catch {
      // 刷新失败则本轮仍使用库中快照；领取前不会因单项目失败中断其它项目。
    }
  }
}

async function queryActiveDreaminaTasks(): Promise<void> {
  const active = await accountDb("o_dreaminaCliDispatch")
    // 中文注释：startup 绑定门禁会把缺失/错绑工作台投影置为不可恢复，active 查询不得绕过该门。
    .where({ queueState: "provider_active", dispatchReady: 1 })
    .select();
  const context = currentUserStorage();
  const dataRoot = getPath();
  const fs = await import("node:fs");
  for (const row of active) {
    const parsed = safeJson(row.providerResultJson);
    const submitId = String(parsed.submitId || parsed.submit_id || "");
    if (!submitId) continue;
    if (context) {
      const referencesRoot = path.join(
        dataRoot,
        "runtime-users",
        context.segment,
        "staging",
        String(row.taskUuid),
        "references",
      );
      if (fs.existsSync(referencesRoot)) {
        // 中文注释：重启后 manifest 已丢失，只记录稳定内部状态；marker 也必须走完整 CAS，
        // 禁止用早先扫描结果覆盖并发落下的终态、submitId、结果文件或镜像修复标记。
        await markReferenceSnapshotCleanupPending(
          String(row.taskUuid),
          String(row.leaseOwner ?? ""),
        );
      }
    }
    await queryAndMaybeInstall(String(row.taskUuid), String(row.projectUuid), submitId);
  }
}

async function installPostprocessingTasks(): Promise<void> {
  const rows = await accountDb("o_dreaminaCliDispatch")
    // 中文注释：缺历史绑定的后处理投影保持原状态等待修复，不得继续安装或唤醒。
    .where({ queueState: "postprocessing", dispatchReady: 1 })
    .select();
  for (const row of rows) {
    const parsed = safeJson(row.providerResultJson);
    const files = Array.isArray(parsed.files) ? parsed.files.map(String) : [];
    await finalizeCompletedTask(String(row.taskUuid), String(row.projectUuid), files);
  }
}

async function runClaimedTask(
  taskUuid: string,
  projectUuid: string,
  mode: string,
  leaseOwner: string,
  executablePath: string | null,
  pollSeconds: number,
): Promise<void> {
  const context = currentUserStorage();
  const dataRoot = getPath();
  const stagingDirectory = path.join(
    dataRoot,
    "runtime-users",
    context?.segment ?? "unknown",
    "staging",
    taskUuid,
  );
  const fs = await import("node:fs");
  try {
    assertManagedPathChainHasNoLinks(dataRoot, stagingDirectory);
    fs.mkdirSync(stagingDirectory, { recursive: true });
    assertManagedPathChainHasNoLinks(dataRoot, stagingDirectory);
  } catch (error) {
    // 中文注释：尚未进入 submit 的本机基础设施失败必须释放领取槽，保留任务供下一 tick 重试。
    await releaseUnsubmittedClaim(taskUuid, leaseOwner, error);
    return;
  }
  const projectRoot = path.join(
    dataRoot,
    "runtime-users",
    context?.segment ?? "unknown",
    "projects",
    projectUuid,
  );
  let ownedReferenceSnapshot: OwnedReferenceSnapshotManifest | undefined;
  try {
  let task: Record<string, unknown> | undefined;
  let request: Record<string, unknown> = {};
  let options: Record<string, unknown> = {};
  let modelVersion: string | undefined;
  let capabilityFields: string[] = [];
  let resolvedReferences: ResolvedReferenceSnapshot[] = [];
  let identityMismatch = false;
  try {
    const dispatch = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
    task = await runWithProjectStorage(projectUuid, () =>
      activeDb("o_storyboardGenerationTask").where({ taskUuid }).first());
    const identityValid = Boolean(dispatch && task)
      && String(dispatch?.projectUuid ?? "").toLowerCase() === projectUuid.toLowerCase()
      && String(dispatch?.queueState ?? "") === "claiming"
      && String(dispatch?.providerState ?? "") === "not_sent"
      && Number(dispatch?.slotHeld ?? 0) === 1
      && String(dispatch?.leaseOwner ?? "") === leaseOwner
      && String(task?.status ?? "") === "queued"
      && Number(task?.enqueueReady ?? 1) === 1
      && String(task?.originDeviceUuid ?? "") === String(dispatch?.originDeviceUuid ?? "")
      && String(task?.mediaType ?? "") === String(dispatch?.mediaType ?? "")
      && String(task?.providerId ?? "") === String(dispatch?.providerId ?? "")
      && String(task?.modelName ?? "") === String(dispatch?.modelName ?? "")
      && String(task?.mode ?? "") === String(dispatch?.mode ?? "")
      && String(task?.clientOperationId ?? "").toLowerCase()
        === String(dispatch?.clientOperationId ?? "").toLowerCase()
      && Number(task?.operationItemIndex ?? -1) === Number(dispatch?.operationItemIndex ?? -1);
    if (!identityValid) {
      identityMismatch = true;
      throw new Error("即梦账号投影与项目任务身份不一致");
    }
    const taskClientOperationId = String(task?.clientOperationId ?? "");
    if (taskClientOperationId) {
      try {
        // 中文注释：账号身份相同仍不足以收费，必须重算项目最终请求及整个 ready 批次摘要。
        await assertAcceptedDreaminaEnqueueIntegrity({
          projectUuid,
          clientOperationId: taskClientOperationId,
        });
      } catch {
        identityMismatch = true;
        throw new Error("即梦生成操作最终请求摘要不一致");
      }
    }
    request = safeJson(task?.parametersJson);
    options = request.options && typeof request.options === "object"
      ? request.options as Record<string, unknown>
      : {};
    if (!context || !DREAMINA_MODES.includes(mode as DreaminaMode) || mode === "auto") {
      throw new Error("即梦任务模式未在入队前解析");
    }
    modelVersion = String(task?.mediaType) === "video"
      ? parseDreaminaVideoModel(String(task?.modelName ?? ""))
      : parseDreaminaImageModel(String(task?.modelName ?? ""), { allowLegacyMode: true });
    if (!Array.isArray(request.capabilityFields)
      || request.capabilityFields.some((field) => typeof field !== "string" || !field.startsWith("--"))) {
      throw new Error("即梦任务缺少有效 CLI 能力快照");
    }
    capabilityFields = [...new Set(request.capabilityFields as string[])];
    if (String(task?.mediaType) === "video" && !capabilityFields.includes("--model_version")) {
      throw new Error("即梦任务无法精确传递视频模型");
    }
    const references = Array.isArray(request.references)
      ? request.references as ProjectMediaReference[]
      : [];
    // 中文注释：先核对项目原文件，再复制到任务独占目录并复核快照；CLI 此后不再打开可替换的原路径。
    const referenceSnapshotDirectory = path.join(stagingDirectory, "references", crypto.randomUUID());
    if (references.length > 0) {
      ownedReferenceSnapshot = {
        directoryPath: referenceSnapshotDirectory,
        files: [],
        materialized: false,
      };
      fs.mkdirSync(referenceSnapshotDirectory, { recursive: true });
      assertManagedPathChainHasNoLinks(dataRoot, referenceSnapshotDirectory);
      ownedReferenceSnapshot.directoryIdentity = captureReferenceSnapshotDirectoryIdentity(
        fs,
        dataRoot,
        referenceSnapshotDirectory,
      );
    }
    resolvedReferences = references.map((reference, index) => {
      const opened = openDreaminaProjectReferenceForExecution(
        dataRoot,
        projectUuid,
        context.segment,
        reference,
      );
      const extension = path.extname(reference.relativePath ?? "").toLowerCase();
      const snapshotPath = path.join(
        referenceSnapshotDirectory,
        `${String(index).padStart(3, "0")}${extension}`,
      );
      try {
        // 中文注释：快照复制复用刚完成项目边界与摘要校验的同一个 fd，禁止按路径重新打开源文件。
        const installedIdentity = copyOpenProjectFileHandleToExclusivePath(opened, snapshotPath);
        const snapshotIdentity = hashFileStreaming(snapshotPath);
        if (snapshotIdentity.md5.toLowerCase() !== opened.md5
          || snapshotIdentity.size !== opened.size) {
          throw new Error("即梦参考素材内容已变化");
        }
        return {
          ...reference,
          md5: opened.md5,
          size: opened.size,
          absolutePath: snapshotPath,
          snapshotIdentity: installedIdentity,
        };
      } catch {
        throw new Error("即梦参考素材安全复制失败");
      } finally {
        closeProjectFileHandle(opened.fd);
      }
    });
    // 中文注释：submitStarted 只能在任务独占快照完成最终父链、普通文件和内容身份复核后落盘。
    assertDreaminaReferenceSnapshotsReadyForSubmit(
      fs,
      dataRoot,
      stagingDirectory,
      resolvedReferences,
    );
    if (ownedReferenceSnapshot) {
      ownedReferenceSnapshot.files = resolvedReferences.map((reference) => reference.snapshotIdentity);
      ownedReferenceSnapshot.materialized = true;
    }
  } catch (error) {
    if (identityMismatch) {
      // 中文注释：submitStarted 前最后一次跨库身份校验失败时只隔离并释放槽，绝不调用CLI或改写项目状态。
      await accountDb("o_dreaminaCliDispatch").where({
        taskUuid,
        queueState: "claiming",
        providerState: "not_sent",
        slotHeld: 1,
        leaseOwner,
      }).update({
        queueState: "queued",
        providerState: "not_sent",
        slotHeld: 0,
        leaseOwner: null,
        leaseExpiresAt: null,
        dispatchReady: 0,
        updatedAt: Date.now(),
      });
      return;
    }
    const projectMirrorPending: ProjectTaskMirrorPatch = {
      status: "failed_fatal",
      errorCode: "DREAMINA_PREFLIGHT_FAILED",
      errorSummary: "即梦任务本地预检失败",
    };
    // 中文注释：预检失败先以当前 lease 写入账号终态和耐久镜像；旧执行流无权覆盖 replacement lease。
    const failedCurrentLease = await accountDb("o_dreaminaCliDispatch").where({
      taskUuid,
      queueState: "claiming",
      providerState: "not_sent",
      slotHeld: 1,
      leaseOwner,
      dispatchReady: 1,
    }).update({
      queueState: "terminal",
      providerState: "failed",
      slotHeld: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      providerTerminalAt: Date.now(),
      providerResultJson: JSON.stringify({
        message: "即梦任务本地预检失败",
        projectMirrorPending,
      }),
      updatedAt: Date.now(),
    });
    if (failedCurrentLease !== 1) return;
    try {
      await updateProjectTask(projectUuid, taskUuid, projectMirrorPending);
      await persistDispatch(taskUuid, {
        providerResultJson: { projectMirrorPending: null },
      });
    } catch {
      // 中文注释：项目库暂不可写时保留账号 marker，下一轮只重放镜像，不重提收费请求。
    }
    wakeDreaminaScheduler();
    return;
  }
  const submitStartedJson = JSON.stringify({ submitStarted: true });
  // 中文注释：领取令牌一次性生效；旧 lease 必须在任何项目状态写入和 CLI 调用前退出。
  const submitFence = await accountDb("o_dreaminaCliDispatch").where({
    taskUuid,
    queueState: "claiming",
    providerState: "not_sent",
    slotHeld: 1,
    leaseOwner,
    dispatchReady: 1,
  }).update({
    providerResultJson: submitStartedJson,
    updatedAt: Date.now(),
  });
  if (submitFence !== 1) return;
  try {
    await runWithProjectStorage(projectUuid, async () => {
      await activeDb.transaction(async (trx) => {
        const updated = await trx("o_storyboardGenerationTask").where({
          taskUuid,
          status: "queued",
          enqueueReady: 1,
        }).update({
          status: "submitting",
          updatedAt: Date.now(),
        });
        if (updated !== 1) throw new Error("即梦项目任务状态已变化");
        await upsertPendingMutationJournalInTrx(trx, "dreaminaSubmit");
      });
    });
  } catch (error) {
    // 中文注释：CLI 尚未调用，只有仍持有本 lease 且 marker 未变时才能安全释放；恢复已接管则保持其安全状态。
    const released = await accountDb("o_dreaminaCliDispatch")
      .where({
        taskUuid,
        queueState: "claiming",
        providerState: "not_sent",
        slotHeld: 1,
        leaseOwner,
        dispatchReady: 1,
      })
      .andWhere("providerResultJson", submitStartedJson)
      .update({
        queueState: "queued",
        providerState: "not_sent",
        slotHeld: 0,
        leaseOwner: null,
        leaseExpiresAt: null,
        providerResultJson: JSON.stringify({ message: "即梦项目任务提交准备失败" }),
        updatedAt: Date.now(),
      });
    if (released === 1) wakeDreaminaScheduler();
    return;
  }
  let submitted = false;
  let submitInvoked = false;
  try {
    const provider = await createDreaminaCliProvider({
      executablePath: executablePath ?? undefined,
      projectRoot,
      stagingDirectory,
    });
    // 中文注释：跨库异步准备完成后、spawn 紧邻前重算摘要并复核 manifest 的 dev/ino/nlink/父目录。
    assertDreaminaReferenceSnapshotsReadyForSubmit(fs, dataRoot, stagingDirectory, resolvedReferences);
    submitInvoked = true;
    const result = await provider.submit({
      mode: mode as DreaminaMode,
      prompt: String(request.prompt ?? "storyboard"),
      // 中文注释：只发送入队时真实 CLI help 声明过的可选字段，禁止跨模式附加未知参数。
      ratio: capabilityFields.includes("--ratio")
        ? String(options.aspectRatio || "") || undefined
        : undefined,
      resolutionType: capabilityFields.includes("--resolution_type")
        ? String(options.resolution || "") || undefined
        : undefined,
      videoResolution: capabilityFields.includes("--video_resolution")
        ? String(options.resolution || "") || undefined
        : undefined,
      // 中文注释：分镜持久化为毫秒，CLI --duration 合同为秒。
      duration: capabilityFields.includes("--duration") && Number(options.durationMs) > 0
        ? Number(options.durationMs) / 1_000
        : undefined,
      // 中文注释：视频轮询间隔来自当前账号本机设置；图片模式由 provider 明确忽略。
      pollSeconds,
      modelVersion: capabilityFields.includes("--model_version") || Boolean(modelVersion)
        ? modelVersion
        : undefined,
      image: mode === "image2video"
        ? resolvedReferences.find((item) => item.mediaType === "image")?.absolutePath
        : undefined,
      first: mode === "frames2video"
        ? resolvedReferences.filter((item) => item.mediaType === "image")[0]?.absolutePath
        : undefined,
      last: mode === "frames2video"
        ? resolvedReferences.filter((item) => item.mediaType === "image")[1]?.absolutePath
        : undefined,
      images: mode === "image2image" || mode === "multiframe2video" || mode === "multimodal2video"
        ? resolvedReferences.filter((item) => item.mediaType === "image").map((item) => item.absolutePath)
        : undefined,
      videos: mode === "multimodal2video"
        ? resolvedReferences.filter((item) => item.mediaType === "video").map((item) => item.absolutePath)
        : undefined,
      audios: mode === "multimodal2video"
        ? resolvedReferences.filter((item) => item.mediaType === "audio").map((item) => item.absolutePath)
        : undefined,
    });
    submitted = true;
    if (result.kind === "outcome_unknown") {
      await persistDispatch(taskUuid, {
        queueState: "provider_active",
        providerState: "unknown",
        slotHeld: 1,
        providerResultJson: { message: result.message },
      });
      return;
    }
    if (result.kind === "definite_failure") {
      await persistDispatchWithProjectMirror({
        taskUuid,
        projectUuid,
        dispatch: {
          queueState: "terminal",
          providerState: "failed",
          slotHeld: 0,
          providerResultJson: { code: result.code, message: result.message },
          providerTerminalAt: Date.now(),
        },
        project: {
          status: "failed_fatal",
          errorCode: result.code,
          errorSummary: result.message,
        },
      });
      wakeDreaminaScheduler();
      return;
    }
    const submitId = String(result.submitId || "");
    if (!submitId) {
      await persistDispatch(taskUuid, {
        queueState: "provider_active",
        providerState: "unknown",
        slotHeld: 1,
        providerResultJson: { message: "submit 未返回 submitId" },
      });
      return;
    }
    // submitted / 即使 CLI 同步带回文件，也必须先占槽进入 provider_active，再走 query。
    await persistDispatch(taskUuid, {
      queueState: "provider_active",
      providerState: "submitted",
      slotHeld: 1,
      providerResultJson: {
        submitId,
        submit_id: submitId,
        files: result.kind === "completed" ? result.files : [],
      },
    });
    await updateProjectTask(projectUuid, taskUuid, {
      status: "submitted",
      providerTaskId: submitId,
    });
    await queryAndMaybeInstall(taskUuid, projectUuid, submitId, stagingDirectory);
  } catch (error) {
    const definitelyUnspawned = !submitInvoked
      || (error instanceof DreaminaProcessError && error.code === DREAMINA_ERROR.pathRejected);
    if (!submitted && definitelyUnspawned) {
      // 中文注释：marker 已落盘但仍能证明零 spawn 时，只能由同 lease+同 marker CAS 收口，禁止制造虚假收费未知。
      await settleDefinitelyUnspawnedFailure({
        taskUuid,
        projectUuid,
        leaseOwner,
        submitStartedJson,
        errorCode: error instanceof DreaminaProcessError
          ? error.code
          : "DREAMINA_PREFLIGHT_FAILED",
      });
      return;
    }
    const current = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
    const currentResult = safeJson(current?.providerResultJson);
    const currentQueueState = String(current?.queueState ?? "");
    const durableSubmitId = String(currentResult.submitId || currentResult.submit_id || "");
    const hasDurableProviderResult = currentQueueState === "terminal"
      || currentQueueState === "postprocessing"
      || (currentQueueState === "provider_active" && Boolean(durableSubmitId));
    if (hasDurableProviderResult) {
      // 中文注释：账号队列已经保存供应商确定结果时，项目镜像失败不能倒灌覆盖终态或 submitId。
      if (Number(current?.slotHeld ?? 0) === 0) wakeDreaminaScheduler();
      return;
    }
    const started = submitted || Boolean(currentResult.submitStarted);
    await persistDispatch(taskUuid, {
      queueState: started ? "provider_active" : "queued",
      providerState: started ? "unknown" : "not_sent",
      slotHeld: started ? 1 : 0,
      providerResultJson: {
        // 中文注释：调度异常可能携带绝对路径或底层堆栈，只持久化稳定中文摘要。
        message: "即梦任务调度失败",
      },
    });
    if (!started) {
      await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).update({
        leaseOwner: null,
        updatedAt: Date.now(),
      });
    }
  }
  } finally {
    // 中文注释：Node/Windows 没有可绑定目录句柄的 unlinkat 等原语；即使 manifest 当前匹配，
    // 也不能把随后按路径 unlink 伪装成原子操作。快照统一保留并交给独立的、非阻塞维护流程处理。
    if (ownedReferenceSnapshot) {
      try {
        await markReferenceSnapshotCleanupPending(taskUuid, leaseOwner);
      } catch {
        // 中文注释：待清理 marker 写入失败不能诱发路径回滚，也不能覆盖已耐久 provider 结果。
      }
    }
  }
}

async function markReferenceSnapshotCleanupPending(taskUuid: string, leaseOwner: string): Promise<void> {
  const current = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
  const currentLeaseOwner = String(current?.leaseOwner ?? "");
  // 中文注释：replacement lease 已接管时旧 worker 只能保留残留，不能借清理 marker 改写新租约状态。
  if (!current || (currentLeaseOwner && currentLeaseOwner !== leaseOwner)) return;
  const previousResult = safeJson(current.providerResultJson);
  let update = accountDb("o_dreaminaCliDispatch").where({
    taskUuid,
    queueState: current.queueState,
    providerState: current.providerState,
    slotHeld: current.slotHeld,
    updatedAt: current.updatedAt,
  });
  update = current.providerResultJson === null || current.providerResultJson === undefined
    ? update.whereNull("providerResultJson")
    : update.andWhere("providerResultJson", current.providerResultJson);
  update = currentLeaseOwner
    ? update.andWhere("leaseOwner", currentLeaseOwner)
    : update.whereNull("leaseOwner");
  await update.update({
    providerResultJson: JSON.stringify({
      ...previousResult,
      referenceSnapshotCleanupPending: true,
    }),
    updatedAt: Math.max(Date.now(), Number(current.updatedAt ?? 0) + 1),
  });
}

interface ReferenceSnapshotDirectoryIdentity {
  absolutePath: string;
  parentPath: string;
  device: bigint;
  inode: bigint;
  parentDevice: bigint;
  parentInode: bigint;
}

interface OwnedReferenceSnapshotManifest {
  directoryPath: string;
  directoryIdentity?: ReferenceSnapshotDirectoryIdentity;
  files: ExclusiveDestinationIdentity[];
  materialized: boolean;
}

type ResolvedReferenceSnapshot = ProjectMediaReference & {
  absolutePath: string;
  snapshotIdentity: ExclusiveDestinationIdentity;
};

function openDreaminaProjectReferenceForExecution(
  dataRoot: string,
  projectUuid: string,
  userSegment: string,
  reference: ProjectMediaReference,
): OpenProjectFileIdentity {
  const expectedMd5 = String(reference.md5 ?? "").toLowerCase();
  const expectedSize = reference.size;
  if (!reference.relativePath
    || reference.relativePath.includes("\\")
    || (reference.mediaType !== "image" && reference.mediaType !== "video" && reference.mediaType !== "audio")
    || classifyProjectFile(reference.relativePath).mediaType !== reference.mediaType
    || !/^[a-f0-9]{32}$/.test(expectedMd5)
    || !Number.isSafeInteger(expectedSize)
    || Number(expectedSize) < 0) {
    throw new Error("即梦参考素材缺少持久内容身份");
  }
  let opened: OpenProjectFileIdentity;
  try {
    opened = openProjectFileIdentity(
      dataRoot,
      projectUuid,
      userSegment,
      reference.relativePath,
    );
  } catch {
    // 中文注释：文件系统异常统一收口，不向调度记录泄露设备路径或底层堆栈。
    throw new Error("即梦参考素材内容不可读取");
  }
  if (opened.md5.toLowerCase() !== expectedMd5 || opened.size !== expectedSize) {
    closeProjectFileHandle(opened.fd);
    throw new Error("即梦参考素材内容已变化");
  }
  return opened;
}

function assertDreaminaReferenceSnapshotsReadyForSubmit(
  fsModule: typeof import("node:fs"),
  dataRoot: string,
  stagingDirectory: string,
  references: readonly ResolvedReferenceSnapshot[],
): void {
  for (const reference of references) {
    assertManagedPathChainHasNoLinks(dataRoot, reference.absolutePath);
    assertReferenceSnapshotFileIdentity(fsModule, reference.snapshotIdentity);
    const identity = hashFileStreaming(reference.absolutePath);
    if (typeof reference.md5 !== "string"
      || typeof reference.size !== "number"
      || identity.md5.toLowerCase() !== reference.md5.toLowerCase()
      || identity.size !== reference.size) {
      throw new Error("即梦参考快照内容已变化");
    }
    assertReferenceSnapshotFileIdentity(fsModule, reference.snapshotIdentity);
    assertManagedPathChainHasNoLinks(dataRoot, reference.absolutePath);
    const relative = path.relative(path.resolve(stagingDirectory), path.resolve(reference.absolutePath));
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("即梦参考快照越出任务暂存目录");
    }
  }
}

function captureReferenceSnapshotDirectoryIdentity(
  fsModule: typeof import("node:fs"),
  dataRoot: string,
  snapshotDirectory: string,
): ReferenceSnapshotDirectoryIdentity {
  const absolutePath = path.resolve(snapshotDirectory);
  const parentPath = path.resolve(path.dirname(absolutePath));
  assertManagedPathChainHasNoLinks(dataRoot, absolutePath);
  const parentStat = fsModule.lstatSync(parentPath, { bigint: true });
  const directoryStat = fsModule.lstatSync(absolutePath, { bigint: true });
  assertStableSnapshotNodeIdentity(parentStat);
  assertStableSnapshotNodeIdentity(directoryStat);
  if (!parentStat.isDirectory()
    || parentStat.isSymbolicLink()
    || !directoryStat.isDirectory()
    || directoryStat.isSymbolicLink()
    || !sameNativeSnapshotPath(fsModule.realpathSync.native(parentPath), parentPath)
    || !sameNativeSnapshotPath(fsModule.realpathSync.native(absolutePath), absolutePath)) {
    throw new Error("即梦引用快照目录不安全");
  }
  return {
    absolutePath,
    parentPath,
    device: directoryStat.dev,
    inode: directoryStat.ino,
    parentDevice: parentStat.dev,
    parentInode: parentStat.ino,
  };
}

function assertReferenceSnapshotDirectoryIdentity(
  fsModule: typeof import("node:fs"),
  dataRoot: string,
  identity: ReferenceSnapshotDirectoryIdentity,
): void {
  assertManagedPathChainHasNoLinks(dataRoot, identity.absolutePath);
  const parentStat = fsModule.lstatSync(identity.parentPath, { bigint: true });
  const directoryStat = fsModule.lstatSync(identity.absolutePath, { bigint: true });
  assertStableSnapshotNodeIdentity(parentStat);
  assertStableSnapshotNodeIdentity(directoryStat);
  if (!parentStat.isDirectory()
    || parentStat.isSymbolicLink()
    || parentStat.dev !== identity.parentDevice
    || parentStat.ino !== identity.parentInode
    || !directoryStat.isDirectory()
    || directoryStat.isSymbolicLink()
    || directoryStat.dev !== identity.device
    || directoryStat.ino !== identity.inode
    || !sameNativeSnapshotPath(fsModule.realpathSync.native(identity.parentPath), identity.parentPath)
    || !sameNativeSnapshotPath(fsModule.realpathSync.native(identity.absolutePath), identity.absolutePath)) {
    throw new Error("即梦引用快照目录身份已变化");
  }
}

function assertReferenceSnapshotFileIdentity(
  fsModule: typeof import("node:fs"),
  identity: ExclusiveDestinationIdentity,
): void {
  const parentStat = fsModule.lstatSync(identity.parentPath, { bigint: true });
  const fileStat = fsModule.lstatSync(identity.absolutePath, { bigint: true });
  assertStableSnapshotNodeIdentity(parentStat);
  assertStableSnapshotFileIdentity(fileStat);
  if (!parentStat.isDirectory()
    || parentStat.isSymbolicLink()
    || parentStat.dev !== identity.parentDevice
    || parentStat.ino !== identity.parentInode
    || !fileStat.isFile()
    || fileStat.isSymbolicLink()
    || fileStat.dev !== identity.device
    || fileStat.ino !== identity.inode
    || fileStat.nlink !== identity.nlink
    || fileStat.size !== identity.size
    || fileStat.mtimeNs !== identity.mtimeNs
    || fileStat.ctimeNs !== identity.ctimeNs
    || !sameNativeSnapshotPath(fsModule.realpathSync.native(identity.parentPath), identity.parentPath)
    || !sameNativeSnapshotPath(fsModule.realpathSync.native(identity.absolutePath), identity.absolutePath)) {
    throw new Error("即梦引用快照文件身份已变化");
  }
}

function assertStableSnapshotNodeIdentity(stat: import("node:fs").BigIntStats): void {
  if (stat.dev <= 0n || stat.ino <= 0n) throw new Error("即梦引用快照身份不稳定");
}

function assertStableSnapshotFileIdentity(stat: import("node:fs").BigIntStats): void {
  assertStableSnapshotNodeIdentity(stat);
  if (stat.nlink !== 1n || stat.size < 0n || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("即梦引用快照身份不稳定");
  }
}

function sameNativeSnapshotPath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}

async function queryAndMaybeInstall(
  taskUuid: string,
  projectUuid: string,
  submitId: string,
  stagingDirectory?: string,
): Promise<void> {
  const queryFenceRow = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
  const queryFenceResult = safeJson(queryFenceRow?.providerResultJson);
  const fencedSubmitId = String(queryFenceResult.submitId || queryFenceResult.submit_id || "");
  if (String(queryFenceRow?.queueState ?? "") !== "provider_active"
    || Number(queryFenceRow?.slotHeld ?? 0) !== 1
    || fencedSubmitId !== submitId) {
    return;
  }
  const queryFence: DispatchWriteFence = {
    queueState: String(queryFenceRow.queueState),
    providerState: String(queryFenceRow.providerState),
    slotHeld: Number(queryFenceRow.slotHeld),
    providerResultJson: queryFenceRow.providerResultJson,
    updatedAt: Number(queryFenceRow.updatedAt),
  };
  const context = currentUserStorage();
  const staging = stagingDirectory ?? path.join(
    getPath(),
    "runtime-users",
    context?.segment ?? "unknown",
    "staging",
    taskUuid,
  );
  const fs = await import("node:fs");
  fs.mkdirSync(staging, { recursive: true });
  const projectRoot = path.join(
    getPath(),
    "runtime-users",
    context?.segment ?? "unknown",
    "projects",
    projectUuid,
  );
  const settings = await readDreaminaCliSettings();
  const provider = await createDreaminaCliProvider({
    executablePath: settings.executablePath
      || (process.env.NODE_TEST_CONTEXT ? process.env.DREAMINA_TEST_EXECUTABLE ?? undefined : undefined),
    projectRoot,
    stagingDirectory: staging,
  });
  const queried = await provider.query({ submitId, stagingDirectory: staging });
  if (queried.kind === "running") {
    await persistDispatch(taskUuid, {
      queueState: "provider_active",
      providerState: "querying",
      slotHeld: 1,
      providerResultJson: { submitId },
    }, queryFence);
    return;
  }
  if (queried.kind === "outcome_unknown") {
    await persistDispatch(taskUuid, {
      queueState: "provider_active",
      providerState: "unknown",
      slotHeld: 1,
      providerResultJson: { submitId, message: queried.message },
    }, queryFence);
    return;
  }
  if (queried.kind === "definite_failure") {
    await persistDispatchWithProjectMirror({
      taskUuid,
      projectUuid,
      dispatch: {
        queueState: "terminal",
        providerState: "failed",
        slotHeld: 0,
        providerResultJson: { submitId, code: queried.code, message: queried.message },
        providerTerminalAt: Date.now(),
      },
      project: {
        status: queried.retryable ? "failed_retryable" : "failed_fatal",
        providerTaskId: submitId,
        errorCode: queried.code,
        errorSummary: queried.message,
      },
      expected: queryFence,
    });
    wakeDreaminaScheduler();
    return;
  }
  const files = queried.kind === "completed" ? [...queried.files] : [];
  if (files.length === 0) {
    await persistDispatch(taskUuid, {
      queueState: "provider_active",
      providerState: "querying",
      slotHeld: 1,
      providerResultJson: { submitId, message: "query 完成但没有文件，继续等待" },
    }, queryFence);
    return;
  }
  const movedToPostprocessing = await persistDispatch(taskUuid, {
    queueState: "postprocessing",
    providerState: "completed",
    slotHeld: 0,
    providerResultJson: { submitId, files },
    providerTerminalAt: Date.now(),
  }, queryFence);
  if (!movedToPostprocessing) return;
  await updateProjectTask(projectUuid, taskUuid, {
    status: "provider_completed",
    providerTaskId: submitId,
    providerCompletedAt: Date.now(),
  });
  await finalizeCompletedTask(taskUuid, projectUuid, files, staging);
}

async function finalizeCompletedTask(
  taskUuid: string,
  projectUuid: string,
  files: readonly string[],
  stagingDirectory?: string,
): Promise<void> {
  const context = currentUserStorage();
  const staging = stagingDirectory ?? path.join(
    getPath(),
    "runtime-users",
    context?.segment ?? "unknown",
    "staging",
    taskUuid,
  );
  const task = await runWithProjectStorage(projectUuid, () =>
    activeDb("o_storyboardGenerationTask").where({ taskUuid }).first());
  try {
    const installed = await installDreaminaResult({
      projectUuid,
      taskUuid,
      shotUuid: String(task?.shotUuid ?? ""),
      mediaType: task?.mediaType === "video" ? "video" : "image",
      stagingDirectory: staging,
      files,
    });
    if (!installed) {
      throw Object.assign(new Error("完成证据缺少可安装文件"), { status: 422 });
    }
    await persistDispatchWithProjectMirror({
      taskUuid,
      projectUuid,
      dispatch: {
        queueState: "terminal",
        providerState: "completed",
        slotHeld: 0,
        providerTerminalAt: Date.now(),
      },
      project: {
        status: "completed",
        ...(task?.providerTaskId ? { providerTaskId: String(task.providerTaskId) } : {}),
        providerCompletedAt: Number(task?.providerCompletedAt) || Date.now(),
      },
    });
    wakeDreaminaScheduler();
  } catch (error) {
    const current = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
    if (String(current?.queueState) === "terminal" && String(current?.providerState) === "completed") {
      // 中文注释：候选和账号完成事实已耐久时，项目镜像失败由 marker 重放，禁止退回 postprocessing。
      wakeDreaminaScheduler();
      return;
    }
    const status = Number((error as { status?: number }).status ?? 0);
    await persistDispatch(taskUuid, {
      queueState: "postprocessing",
      providerState: "completed",
      slotHeld: 0,
      providerResultJson: {
        files,
        // 中文注释：安装器底层错误不得进入账号队列持久化字段。
        message: "即梦结果安装失败",
      },
    });
    if (status !== 403) {
      await updateProjectTask(projectUuid, taskUuid, {
        status: "postprocess_failed_retryable",
        errorSummary: "即梦结果安装失败",
      });
    }
  }
}

async function persistDispatch(taskUuid: string, patch: {
  queueState?: string;
  providerState?: string;
  slotHeld?: number;
  providerResultJson?: unknown;
  providerTerminalAt?: number;
}, expected?: DispatchWriteFence): Promise<DispatchWriteSnapshot | null> {
  const current = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
  if (!current) return null;
  let resultJson = patch.providerResultJson;
  if (resultJson && typeof resultJson === "object") {
    const previous = expected
      ? safeJson(expected.providerResultJson)
      : safeJson(current.providerResultJson);
    resultJson = { ...previous, ...(resultJson as Record<string, unknown>) };
  }
  const providerState = patch.providerState === "submitted" || patch.providerState === "querying"
    ? "running"
    : patch.providerState;
  let update = accountDb("o_dreaminaCliDispatch").where({ taskUuid });
  if (expected) {
    update = update.where({
      queueState: expected.queueState,
      providerState: expected.providerState,
      slotHeld: expected.slotHeld,
      updatedAt: expected.updatedAt,
    });
    update = expected.providerResultJson === null || expected.providerResultJson === undefined
      ? update.whereNull("providerResultJson")
      : update.andWhere("providerResultJson", expected.providerResultJson);
  }
  const updatedAt = Math.max(
    Date.now(),
    Number(current.updatedAt ?? 0) + 1,
    expected ? expected.updatedAt + 1 : 0,
  );
  const storedResult = resultJson !== undefined ? JSON.stringify(resultJson) : current.providerResultJson;
  const changed = await update.update({
    ...(patch.queueState ? { queueState: patch.queueState } : {}),
    ...(providerState ? { providerState } : {}),
    ...(patch.slotHeld !== undefined ? { slotHeld: patch.slotHeld } : {}),
    ...(resultJson !== undefined ? { providerResultJson: storedResult } : {}),
    ...(patch.providerTerminalAt ? { providerTerminalAt: patch.providerTerminalAt } : {}),
    updatedAt,
  });
  if (Number(changed) !== 1) return null;
  return {
    taskUuid,
    projectUuid: String(current.projectUuid),
    queueState: patch.queueState ?? String(current.queueState),
    providerState: providerState ?? String(current.providerState),
    slotHeld: patch.slotHeld ?? Number(current.slotHeld),
    providerResultJson: storedResult,
    updatedAt,
  };
}

async function releaseUnsubmittedClaim(
  taskUuid: string,
  leaseOwner: string,
  _error: unknown,
): Promise<void> {
  const released = await accountDb("o_dreaminaCliDispatch")
    .where({
      taskUuid,
      queueState: "claiming",
      providerState: "not_sent",
      slotHeld: 1,
      leaseOwner,
    })
    .update({
      queueState: "queued",
      providerState: "not_sent",
      slotHeld: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      providerResultJson: JSON.stringify({
        // 中文注释：领取阶段的文件系统错误不得把路径、SQL 或令牌写入账号库。
        message: "即梦任务本地准备失败",
      }),
      updatedAt: Date.now(),
    });
  // 中文注释：旧 worker 若已失去 lease，绝不能唤醒或改写 replacement owner。
  if (released === 1) wakeDreaminaScheduler();
}

async function settleDefinitelyUnspawnedFailure(input: {
  taskUuid: string;
  projectUuid: string;
  leaseOwner: string;
  submitStartedJson: string;
  errorCode: string;
}): Promise<void> {
  const projectMirrorPending: ProjectTaskMirrorPatch = {
    status: "failed_fatal",
    errorCode: input.errorCode,
    errorSummary: "即梦任务在 CLI 启动前失败",
  };
  const settled = await accountDb("o_dreaminaCliDispatch")
    .where({
      taskUuid: input.taskUuid,
      queueState: "claiming",
      providerState: "not_sent",
      slotHeld: 1,
      leaseOwner: input.leaseOwner,
      dispatchReady: 1,
    })
    .andWhere("providerResultJson", input.submitStartedJson)
    .update({
      queueState: "terminal",
      providerState: "failed",
      slotHeld: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      providerTerminalAt: Date.now(),
      providerResultJson: JSON.stringify({
        message: "即梦任务在 CLI 启动前失败",
        projectMirrorPending,
      }),
      updatedAt: Date.now(),
    });
  if (settled !== 1) return;
  try {
    await updateProjectTask(input.projectUuid, input.taskUuid, projectMirrorPending);
    await persistDispatch(input.taskUuid, {
      providerResultJson: { projectMirrorPending: null },
    });
  } catch {
    // 中文注释：项目镜像暂不可写时保留账号终态 marker，下一 tick 只补镜像，不会重提。
  }
  wakeDreaminaScheduler();
}

/** 账号库先保存供应商终态及待镜像补丁；项目库失败时由下一 tick 幂等补写。 */
async function persistDispatchWithProjectMirror(input: {
  taskUuid: string;
  projectUuid: string;
  dispatch: {
    queueState: string;
    providerState: string;
    slotHeld: number;
    providerResultJson?: Record<string, unknown>;
    providerTerminalAt?: number;
  };
  project: ProjectTaskMirrorPatch;
  expected?: DispatchWriteFence;
}): Promise<boolean> {
  const persisted = await persistDispatch(input.taskUuid, {
    ...input.dispatch,
    providerResultJson: {
      ...(input.dispatch.providerResultJson ?? {}),
      projectMirrorPending: input.project,
    },
  }, input.expected);
  if (!persisted) return false;
  try {
    await updateProjectTask(input.projectUuid, input.taskUuid, input.project);
    return await clearProjectMirrorMarker(persisted);
  } catch {
    // 中文注释：账号终态是收费事实，项目镜像失败只保留待补标记，禁止倒灌回退账号状态。
    return false;
  }
}

async function clearProjectMirrorMarker(snapshot: DispatchWriteSnapshot): Promise<boolean> {
  const parsed = safeJson(snapshot.providerResultJson);
  if (!parseProjectTaskMirrorPatch(parsed.projectMirrorPending)) return false;
  const cleared = await persistDispatch(snapshot.taskUuid, {
    providerResultJson: { projectMirrorPending: null },
  }, snapshot);
  return cleared !== null;
}

/** 每次 tick/启动恢复都重放账号终态的项目镜像，不触发 provider submit 或候选安装。 */
export async function reconcilePendingProjectTaskMirrors(): Promise<number> {
  const rows = await accountDb("o_dreaminaCliDispatch")
    .whereNotNull("providerResultJson")
    .select(
      "taskUuid",
      "projectUuid",
      "queueState",
      "providerState",
      "slotHeld",
      "providerResultJson",
      "updatedAt",
    );
  let reconciled = 0;
  for (const row of rows) {
    const parsed = safeJson(row.providerResultJson);
    const mirror = parseProjectTaskMirrorPatch(parsed.projectMirrorPending);
    if (!mirror) continue;
    const expectedProviderState = mirror.status === "completed" ? "completed" : "failed";
    if (String(row.queueState) !== "terminal"
      || String(row.providerState) !== expectedProviderState
      || Number(row.slotHeld) !== 0) {
      continue;
    }
    const snapshot: DispatchWriteSnapshot = {
      taskUuid: String(row.taskUuid),
      projectUuid: String(row.projectUuid),
      queueState: String(row.queueState),
      providerState: String(row.providerState),
      slotHeld: Number(row.slotHeld),
      providerResultJson: row.providerResultJson,
      updatedAt: Number(row.updatedAt),
    };
    try {
      await updateProjectTask(String(row.projectUuid), String(row.taskUuid), mirror);
      if (await clearProjectMirrorMarker(snapshot)) reconciled += 1;
    } catch {
      // 项目暂时不可写时保留账号库 marker，下一轮继续重放。
    }
  }
  return reconciled;
}

function parseProjectTaskMirrorPatch(raw: unknown): ProjectTaskMirrorPatch | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const status = String(source.status ?? "");
  if (status !== "failed_fatal" && status !== "failed_retryable" && status !== "completed") return null;
  return {
    status,
    ...(typeof source.providerTaskId === "string" ? { providerTaskId: source.providerTaskId } : {}),
    ...(Number.isFinite(Number(source.providerCompletedAt))
      ? { providerCompletedAt: Number(source.providerCompletedAt) }
      : {}),
    ...(typeof source.errorCode === "string" ? { errorCode: source.errorCode } : {}),
    ...(typeof source.errorSummary === "string" ? { errorSummary: source.errorSummary } : {}),
  };
}

function looksUnsafeHistoryReason(text: string): boolean {
  return /[A-Za-z]:\\/.test(text)
    || /SELECT /i.test(text)
    || /cookie/i.test(text)
    || text.includes("sk-")
    || /SQLITE/i.test(text);
}

function mapDreaminaStatusToWorkbenchVideoState(status: string): "生成中" | "生成成功" | "生成失败" | null {
  if (status === "completed") return "生成成功";
  if (
    status === "failed_fatal"
    || status === "failed_retryable"
    || status === "cancelled_local"
    || status === "postprocess_failed_fatal"
  ) {
    return "生成失败";
  }
  if (!status) return null;
  return "生成中";
}

function safeWorkbenchVideoErrorReason(patch: Record<string, unknown>): string {
  const code = typeof patch.errorCode === "string" ? patch.errorCode : "";
  const mapped: Record<string, string> = {
    DREAMINA_CLI_DISABLED: "即梦 CLI 已关闭",
    DREAMINA_CLI_NOT_INSTALLED: "未安装即梦 CLI 或无法执行",
    DREAMINA_CLI_NOT_LOGGED_IN: "未登录即梦账号",
    STORYBOARD_DREAMINA_CLI_UNAVAILABLE: "即梦 CLI 不可用",
    STORYBOARD_DREAMINA_MODE_UNSUPPORTED: "当前即梦 CLI 不支持当前模式",
    DREAMINA_PREFLIGHT_FAILED: "即梦任务本地预检失败",
  };
  if (mapped[code]) return mapped[code];
  const summary = typeof patch.errorSummary === "string" ? patch.errorSummary.trim() : "";
  if (summary && !looksUnsafeHistoryReason(summary) && /[\u4e00-\u9fff]/.test(summary) && summary.length <= 80) {
    return summary;
  }
  return "视频生成失败";
}

async function syncWorkbenchVideoHistory(
  trx: Knex.Transaction,
  taskUuid: string,
  patch: Record<string, unknown>,
): Promise<void> {
  if (!(await trx.schema.hasColumn("o_video", "generationTaskUuid"))) return;
  const task = await trx("o_storyboardGenerationTask").where({ taskUuid }).first();
  if (!task) return;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(String(task.parametersJson ?? "{}"));
  } catch {
    return;
  }
  if (!readWorkbenchGenerationOrigin(parsed)) return;
  const nextStatus = String(patch.status ?? task.status ?? "");
  const state = mapDreaminaStatusToWorkbenchVideoState(nextStatus);
  if (!state) return;
  const videoPatch: Record<string, unknown> = { state };
  if (state === "生成失败") videoPatch.errorReason = safeWorkbenchVideoErrorReason(patch);
  await trx("o_video").where({ generationTaskUuid: taskUuid }).update(videoPatch);
}

async function updateProjectTask(
  projectUuid: string,
  taskUuid: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await runWithProjectStorage(projectUuid, async () => {
    await activeDb.transaction(async (trx) => {
      const updated = await trx("o_storyboardGenerationTask").where({ taskUuid }).update({
        ...patch,
        updatedAt: Date.now(),
      });
      if (updated !== 1) {
        // 中文注释：缺行不是成功；保留账号 marker，待项目同步/恢复任务行后再次镜像。
        throw Object.assign(new Error("项目任务镜像目标暂不存在"), { status: 409 });
      }
      await syncWorkbenchVideoHistory(trx, taskUuid, patch);
      await upsertPendingMutationJournalInTrx(trx, "dreaminaTask");
    });
  });
}

export async function getDreaminaQueueState() {
  const settings = await readDreaminaCliSettings();
  const queued = await accountDb("o_dreaminaCliDispatch").where({ queueState: "queued" }).select("taskUuid");
  const held = await accountDb("o_dreaminaCliDispatch").where({ slotHeld: 1 }).select("taskUuid");
  return {
    updatedAt: settings.updatedAt,
    maxConcurrentSubmit: settings.maxConcurrency,
    effectiveLimit: settings.maxConcurrency,
    queued: queued.length,
    activeSlots: held.length,
    paused: resolveDreaminaPauseReason(settings) !== "none",
    pauseReason: resolveDreaminaPauseReason(settings),
    blockedByUnknown: await hasUnknownSlot(),
  };
}

function safeJson(raw: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(raw ?? "{}"));
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
