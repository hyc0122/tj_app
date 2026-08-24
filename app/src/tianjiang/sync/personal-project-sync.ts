export interface PersonalObject {
  relativePath: string;
  md5: string;
  size?: number;
  /** 媒体对象可判定类型；project.sqlite 可省略 */
  mediaType?: "image" | "video" | "audio" | "text" | "binary";
}

export interface PersonalManifest {
  version: number;
  objects: PersonalObject[];
  /**
   * 本地安装回执：证明中央 project.sqlite 的字节已经真实落盘。
   * 旧客户端只写版本/对象清单却没有安装数据库；缺少本字段时在线打开需安全补拉一次。
   * 该字段仅写入本机 manifest，发布中央版本时必须剥离。
   */
  installedDatabaseMD5?: string;
  /**
   * 本地-only mutation capture：
   * - 0：快照无 pending
   * - 正整数：已捕获 generation
   * - "unknown"：探测失败，禁止 finalize
   */
  capturedMutationGeneration?: number | "unknown";
}

export interface PersonalLocal {
  current?: PersonalManifest;
  dirty: boolean;
  /** 是否需要安装已下载快照；旧实现可省略并沿用版本比较。 */
  needsInstall?(remote: PersonalManifest): boolean;
  install(remote: PersonalManifest, changedPaths: string[]): Promise<void>;
  createSnapshot(options?: {
    afterBackup?: () => void | Promise<void>;
  }): Promise<PersonalManifest>;
  createRecovery(reason: string): Promise<void>;
}

export interface PersonalRemote {
  latest(): Promise<PersonalManifest>;
  downloadObjects?(
    manifest: PersonalManifest,
    requiredObjects: Array<{ relativePath: string; size?: number; md5: string }>,
  ): Promise<void>;
  publish(
    baseVersion: number,
    next: PersonalManifest,
    changedPaths: string[],
    reason: string,
  ): Promise<PersonalManifest>;
}

/** Team 项目禁止进入 Personal 上传队列。 */
export function rejectIfTeamWouldEnterPersonalQueue(kind: string): void {
  if (kind === "team") {
    throw new Error("Team 项目不得进入 Personal 上传队列");
  }
}

export class PersonalProjectConflictError extends Error {
  constructor(message = "个人项目远端版本已前进") {
    super(message);
    this.name = "PersonalProjectConflictError";
  }
}

/** 同步/关闭的可判定结果（生产契约，禁止测试伪造不存在的字段） */
export type PersonalSyncResultState =
  | "synced"
  | "unchanged"
  | "offline_pending";

export type PersonalSyncResult = {
  state: PersonalSyncResultState;
  /** 本次上传捕获；finalize 仅清 <= 该值；unknown 禁止 finalize */
  capturedMutationGeneration?: number | "unknown";
  /** 上传期间是否有新编辑（edit epoch 变化） */
  editEpochAdvanced?: boolean;
  remainingPending?: boolean;
};

/** 可取消的调度句柄；生产默认 clearTimeout */
export type ScheduledHandle = {
  cancel(): void;
};

type Schedule = (run: () => void, delay: number) => ScheduledHandle | unknown;

/** 协调器注入：定时器不得直接 this.sync 绕开 finalize */
export type PersonalSyncExecutor = (
  reason: "idle" | "checkpoint" | "close" | "manual",
) => Promise<PersonalSyncResult>;

type Lifecycle = "idle" | "open" | "closing" | "closed";

/** 生产默认：setTimeout + unref（防挂起）+ 真实 cancel（修复本体，仅 unref 不算） */
function defaultSchedule(run: () => void, delay: number): ScheduledHandle {
  const timer = setTimeout(run, delay);
  timer.unref?.();
  return {
    cancel() {
      clearTimeout(timer);
    },
  };
}

function tryCancelHandle(handle: unknown): void {
  if (!handle) return;
  if (typeof (handle as ScheduledHandle).cancel === "function") {
    try {
      (handle as ScheduledHandle).cancel();
    } catch {
      // 取消失败不得阻断关闭
    }
    return;
  }
  // 兼容旧测试返回 NodeJS.Timeout
  if (
    typeof handle === "object"
    && handle !== null
    && "ref" in (handle as object)
  ) {
    try {
      clearTimeout(handle as NodeJS.Timeout);
    } catch {
      // ignore
    }
  }
}

export class PersonalProjectSync {
  private lifecycle: Lifecycle = "idle";
  private opened = false;
  private loaded = false;
  /** 编辑代数：上传期间若递增则不得清 dirty */
  private editEpoch = 0;
  private scheduleToken = 0;
  private checkpointToken = 0;
  private idleHandle: unknown;
  private checkpointHandle: unknown;
  private protectPendingLocal = false;
  private protectFailClosed = false;
  private syncExecutor?: PersonalSyncExecutor;
  /** 单飞：idle/checkpoint/manual/close 串行，publish 并发恒 ≤1 */
  private syncTail: Promise<unknown> = Promise.resolve();
  private lastCloseResult?: PersonalSyncResult;
  private lastCloseError?: Error;
  /**
   * 并发 close 共享同一 Promise（成功结果或 rejection）。
   * 失败后禁止 fallback 为 unchanged。
   */
  private closeInFlight?: Promise<PersonalSyncResult>;

  constructor(
    private readonly local: PersonalLocal,
    private readonly remote: PersonalRemote,
    private readonly isOnline: () => boolean,
    private readonly schedule: Schedule = defaultSchedule,
  ) {}

  /** 由 SyncCoordinator 注入：idle/checkpoint 经协调器 finalize */
  setSyncExecutor(executor: PersonalSyncExecutor | undefined): void {
    this.syncExecutor = executor;
  }

  open(): void {
    this.opened = true;
    this.lifecycle = "open";
    this.lastCloseResult = undefined;
    this.lastCloseError = undefined;
    this.closeInFlight = undefined;
  }

  setProtectPendingLocal(
    protect: boolean,
    options?: { failClosed?: boolean },
  ): void {
    this.protectPendingLocal = protect;
    this.protectFailClosed = options?.failClosed === true;
  }

  /**
   * 中央确认后由协调器应用：剩余 pending 或 epoch 已变则保持 dirty 并调度。
   */
  applyMutationFinalizeResult(input: {
    remainingPending: boolean;
    editEpochUnchanged: boolean;
  }): void {
    if (input.remainingPending || !input.editEpochUnchanged) {
      this.local.dirty = true;
      this.scheduleFollowUpSync();
      return;
    }
    // 无剩余且 epoch 未变：允许保持 clean（由调用方已处理 dirty）
  }

  /** @deprecated 使用 applyMutationFinalizeResult */
  noteRemainingPendingAfterSync(remaining: boolean): void {
    this.applyMutationFinalizeResult({
      remainingPending: remaining,
      editEpochUnchanged: true,
    });
  }

  async ensureLoaded(): Promise<void> {
    if (!this.opened || this.lifecycle === "closed" || this.lifecycle === "closing") {
      throw new Error("个人项目尚未打开");
    }
    if (this.loaded) return;

    // 中文注释：journal 不可读或 manifest 缺失时，本地待提交事实的版本无法证明。
    // 必须在任何远端读取前失败关闭，禁止下载结果覆盖现有 project.sqlite。
    if (this.protectFailClosed) {
      await this.local.createRecovery("mutation_journal_unreadable");
      throw new PersonalProjectConflictError(
        "本地 mutation journal 不可读，已进入恢复状态，禁止远端覆盖",
      );
    }
    if (this.protectPendingLocal && !this.local.current) {
      await this.local.createRecovery("pending_mutation_local_manifest_missing");
      throw new PersonalProjectConflictError(
        "本地有未同步提交但项目清单缺失，已进入恢复状态，禁止远端覆盖",
      );
    }

    if (!this.isOnline() && !this.local.current) throw new Error("离线时本机不存在项目副本");
    if (this.isOnline()) {
      const remote = await this.remote.latest();
      if (this.protectPendingLocal && this.local.current) {
        if (remote.version > this.local.current.version) {
          await this.local.createRecovery("pending_mutation_remote_advanced");
          throw new PersonalProjectConflictError(
            "本地有未同步提交且远端版本已前进，已生成恢复副本，禁止覆盖本地数据",
          );
        }
      } else {
        const changed = changedPaths(this.local.current, remote);
        const needsInstall = !this.local.current
          || remote.version > this.local.current.version
          || this.local.needsInstall?.(remote) === true;
        if (needsInstall) {
          // 中文注释：先按 size/MD5 计划变化对象，再下载；本地一致时 downloadObjects 必须是空集。
          const required = remote.objects.filter((object) => {
            const localObject = this.local.current?.objects.find(
              (item) => item.relativePath === object.relativePath,
            );
            return !localObject
              || localObject.md5.toLowerCase() !== object.md5.toLowerCase()
              || (localObject.size ?? object.size) !== object.size;
          });
          await this.remote.downloadObjects?.(remote, required);
          await this.local.install(remote, changed);
        }
      }
    }
    this.loaded = true;
  }

  markEdited(): void {
    this.local.dirty = true;
    this.editEpoch += 1;
    // 中文注释：closing/closed 保留 dirty/journal 事实，禁止静默恢复定时调度
    if (this.lifecycle === "closing" || this.lifecycle === "closed" || !this.opened) {
      return;
    }
    this.scheduleFollowUpSync();
  }

  private canSchedule(): boolean {
    return this.opened && this.lifecycle === "open";
  }

  /** 读当前生命周期（方法调用避免 await 后 TS 收窄误判） */
  private currentLifecycle(): Lifecycle {
    return this.lifecycle;
  }

  private cancelScheduledWork(): void {
    // 抬高 token：即使 clear 失败，回调入口也不得再执行
    this.scheduleToken += 1;
    this.checkpointToken += 1;
    tryCancelHandle(this.idleHandle);
    tryCancelHandle(this.checkpointHandle);
    this.idleHandle = undefined;
    this.checkpointHandle = undefined;
  }

  private scheduleFollowUpSync(): void {
    if (!this.canSchedule()) return;

    // 中文注释：新一轮 idle 必须取消上一轮，禁止只抬 token 留下空定时器
    tryCancelHandle(this.idleHandle);
    this.idleHandle = undefined;
    const idleToken = ++this.scheduleToken;
    this.idleHandle = this.schedule(() => {
      this.idleHandle = undefined;
      if (idleToken !== this.scheduleToken) return;
      if (!this.canSchedule()) return;
      void this.runScheduled("idle")
        .catch(() => undefined)
        .finally(() => this.rescheduleDirtyProject());
    }, 30_000);

    // checkpoint：生命周期 token；已有未执行的不重复堆叠
    if (!this.checkpointHandle) {
      const cpToken = ++this.checkpointToken;
      this.checkpointHandle = this.schedule(() => {
        this.checkpointHandle = undefined;
        if (cpToken !== this.checkpointToken) return;
        if (!this.canSchedule()) return;
        if (this.local.dirty) {
          void this.runScheduled("checkpoint")
            .catch(() => undefined)
            .finally(() => this.rescheduleDirtyProject());
        }
      }, 120_000);
    }
  }

  /** 同步失败或离线后继续保留自动重试；关闭态不得重新安装定时器。 */
  private rescheduleDirtyProject(): void {
    if (!this.canSchedule() || !this.local.dirty || this.idleHandle) return;
    this.scheduleFollowUpSync();
  }

  private runScheduled(
    reason: "idle" | "checkpoint",
  ): Promise<PersonalSyncResult> {
    // 入口检查；不得在此再套 withSyncLock——executor/生产路径会调用 sync() 自行串行
    if (!this.canSchedule()) {
      return Promise.resolve({ state: "unchanged" });
    }
    if (this.syncExecutor) {
      return Promise.resolve()
        .then(async () => {
          if (!this.canSchedule()) return { state: "unchanged" as const };
          return this.syncExecutor!(reason);
        })
        .then(async (result) => {
          // 异步边界：关闭后丢弃后续副作用（executor 内部已串行）
          return result;
        });
    }
    // 无 executor 时（单元测试）仍允许直接 sync
    return this.sync(reason);
  }

  /** 串行化所有远端同步入口 */
  private withSyncLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.syncTail.then(fn, fn);
    // 吞掉链路错误，避免后续排队永久卡死；调用方仍收到本次 rejection
    this.syncTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async sync(reason: "idle" | "checkpoint" | "close" | "manual"): Promise<PersonalSyncResult> {
    return this.withSyncLock(() => this.syncBody(reason));
  }

  private async syncBody(
    reason: "idle" | "checkpoint" | "close" | "manual",
  ): Promise<PersonalSyncResult> {
    // closed 后拒绝新同步；closing 仅允许 close 原因收尾
    if (this.currentLifecycle() === "closed") {
      return { state: "unchanged" };
    }
    if (this.currentLifecycle() === "closing" && reason !== "close") {
      return { state: "unchanged" };
    }
    if (!this.local.dirty) return { state: "unchanged" };
    if (!this.isOnline()) return { state: "offline_pending" };
    const epochAtStart = this.editEpoch;
    const snapshot = await this.local.createSnapshot();
    // 异步边界：关闭后不得继续远端提交
    if (this.currentLifecycle() === "closed") {
      return { state: "unchanged" };
    }
    if (this.currentLifecycle() === "closing" && reason !== "close") {
      return { state: "unchanged" };
    }
    const capturedMutationGeneration = snapshot.capturedMutationGeneration;
    const uploadManifest: PersonalManifest = {
      version: snapshot.version,
      objects: structuredClone(snapshot.objects),
    };
    const remote = await this.remote.latest();
    if (this.currentLifecycle() === "closed") {
      return { state: "unchanged" };
    }
    if (this.local.current && remote.version !== this.local.current.version) {
      await this.local.createRecovery("remote_version_advanced");
      throw new PersonalProjectConflictError();
    }
    const changed = changedPaths(remote, uploadManifest);
    const epochUnchanged = this.editEpoch === epochAtStart;

    if (
      changed.length === 0
      && this.local.current
      && remote.version === this.local.current.version
      && objectSetEqual(this.local.current, remote)
    ) {
      // 无 capture 字段：纯对象幂等，返回 unchanged
      if (capturedMutationGeneration === undefined) {
        if (epochUnchanged) this.local.dirty = false;
        else {
          this.local.dirty = true;
          this.scheduleFollowUpSync();
        }
        return { state: "unchanged", editEpochAdvanced: !epochUnchanged };
      }
      if (capturedMutationGeneration === "unknown") {
        // unknown：不得清 dirty 伪装成功清理
        this.local.dirty = true;
        return {
          state: "synced",
          capturedMutationGeneration: "unknown",
          editEpochAdvanced: !epochUnchanged,
        };
      }
      // 0 或正整数 capture：需 finalize
      if (epochUnchanged) this.local.dirty = false;
      else {
        this.local.dirty = true;
        this.scheduleFollowUpSync();
      }
      return {
        state: "synced",
        capturedMutationGeneration,
        editEpochAdvanced: !epochUnchanged,
      };
    }

    const committed = await this.remote.publish(
      remote.version,
      uploadManifest,
      changed,
      reason,
    );
    // 已关闭：仍 install 以保持本地与远端已提交事实一致
    await this.local.install(committed, []);
    const epochAfter = this.editEpoch === epochAtStart;
    if (epochAfter) {
      this.local.dirty = false;
    } else {
      // 中文注释：上传期间有新编辑，保留 dirty；仅 open 态才调度
      this.local.dirty = true;
      this.scheduleFollowUpSync();
    }
    return {
      state: "synced",
      capturedMutationGeneration:
        capturedMutationGeneration === undefined
          ? "unknown"
          : capturedMutationGeneration,
      editEpochAdvanced: !epochAfter,
    };
  }

  /** 是否已进入终态 closed（仅 commitTerminalDispose / disposeTerminal 之后） */
  isTerminalClosed(): boolean {
    return this.currentLifecycle() === "closed";
  }

  /**
   * 终端释放：仅取消定时、禁止再同步。
   * 不得解释为中央同步成功；与 close 的同步结果分离；幂等。
   */
  disposeTerminal(): void {
    this.cancelScheduledWork();
    this.opened = false;
    this.lifecycle = "closed";
    this.closeInFlight = undefined;
  }

  /**
   * 协调器在中央成功或耐久入队确认后提交终态。
   * 与 attemptClose（close）分离：禁止在 close finally 无条件 dispose。
   */
  commitTerminalDispose(): void {
    this.disposeTerminal();
  }

  /**
   * 关闭尝试失败/阻断后恢复 open：允许 markEdited / syncNow / 再次 close。
   * 不得在 terminal closed 后静默复活。
   */
  rollbackCloseAttempt(): void {
    if (this.lifecycle === "closed") return;
    this.lifecycle = "open";
    this.opened = true;
    this.lastCloseError = undefined;
    this.lastCloseResult = undefined;
    this.closeInFlight = undefined;
  }

  /** @deprecated 使用 rollbackCloseAttempt */
  resumeOpen(): void {
    this.rollbackCloseAttempt();
  }

  /**
   * 关闭尝试（attemptClose）：单飞执行 close sync，不进入 terminal dispose。
   * - 并发共享 closeInFlight（同一成功结果或同一 rejection）
   * - 成功：保存 lastCloseResult，lifecycle 仍为 closing，待协调器 commit
   * - 失败：保存 lastCloseError，lifecycle 仍为 closing，待协调器 rollback
   * - dirty 失败时不得清除；禁止 fallback unchanged
   */
  async close(): Promise<PersonalSyncResult> {
    if (this.closeInFlight) {
      return this.closeInFlight;
    }
    // 已 terminal：只复述权威结果
    if (this.lifecycle === "closed") {
      if (this.lastCloseError) throw this.lastCloseError;
      if (this.lastCloseResult) return this.lastCloseResult;
      return { state: "unchanged" };
    }
    // 上一轮 attempt 已结束但仍在 closing：复述结果，禁止 unchanged 掩盖失败
    if (this.lifecycle === "closing") {
      if (this.lastCloseError) throw this.lastCloseError;
      if (this.lastCloseResult) return this.lastCloseResult;
    }
    this.closeInFlight = this.executeCloseOnce().finally(() => {
      // 单飞结束后允许协调器 rollback 后再开新 attempt
      this.closeInFlight = undefined;
    });
    return this.closeInFlight;
  }

  private async executeCloseOnce(): Promise<PersonalSyncResult> {
    if (this.lifecycle === "closed") {
      if (this.lastCloseError) throw this.lastCloseError;
      if (this.lastCloseResult) return this.lastCloseResult;
      return { state: "unchanged" };
    }
    if (this.lifecycle === "closing" && (this.lastCloseError || this.lastCloseResult)) {
      if (this.lastCloseError) throw this.lastCloseError;
      return this.lastCloseResult!;
    }

    this.lifecycle = "closing";
    // 中文注释：close 开始先阻止新调度并取消尚未执行的 idle/checkpoint
    this.cancelScheduledWork();

    try {
      const result = await this.withSyncLock(() => this.syncBody("close"));
      this.lastCloseResult = result;
      this.lastCloseError = undefined;
      return result;
    } catch (error) {
      // 失败权威：所有并发调用者共享同一 rejection；dirty 保留；不 dispose
      const err = error instanceof Error ? error : new Error(String(error));
      this.lastCloseError = err;
      this.lastCloseResult = undefined;
      throw err;
    }
    // 中文注释：禁止 finally disposeTerminal——由 PersonalCloseCoordinator 决定 commit/rollback
  }
}

function changedPaths(base: PersonalManifest | undefined, next: PersonalManifest): string[] {
  const baseObjects = new Map((base?.objects ?? []).map((item) => [item.relativePath, item.md5]));
  return next.objects
    .filter((item) => baseObjects.get(item.relativePath) !== item.md5)
    .map((item) => item.relativePath)
    .sort();
}

function objectSetEqual(a: PersonalManifest, b: PersonalManifest): boolean {
  if (a.objects.length !== b.objects.length) return false;
  const map = new Map(a.objects.map((item) => [item.relativePath, item.md5]));
  for (const item of b.objects) {
    if (map.get(item.relativePath) !== item.md5) return false;
  }
  return true;
}
