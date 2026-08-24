import { effectScope, nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useStoryboardGenerationPolling } from "@/views/storyboardProject/useStoryboardGenerationPolling";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("R32 分镜生成五秒轮询生命周期", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("重复通知只保留一个定时器，未完成请求期间跳过后续 tick", async () => {
    const projectUuid = ref("32323232-3232-4232-a232-323232323250");
    const first = deferred<boolean>();
    const refreshShots = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(true);
    let active = true;
    const scope = effectScope();
    const polling = scope.run(() => useStoryboardGenerationPolling({
      projectUuid,
      refreshShots,
      hasActiveTasks: () => active,
    }))!;

    polling.notifyAccepted();
    polling.notifyAccepted();
    await nextTick();
    expect(refreshShots).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(refreshShots).toHaveBeenCalledTimes(1);

    first.resolve(true);
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(refreshShots).toHaveBeenCalledTimes(2);

    active = false;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(refreshShots).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refreshShots).toHaveBeenCalledTimes(3);
    polling.stop();
    scope.stop();
  });

  it("项目切换和组件卸载都会清理定时器，旧请求结束后不得重新启动", async () => {
    const projectUuid = ref("32323232-3232-4232-a232-323232323251");
    const pending = deferred<boolean>();
    const refreshShots = vi.fn().mockReturnValue(pending.promise);
    const scope = effectScope();
    const polling = scope.run(() => useStoryboardGenerationPolling({
      projectUuid,
      refreshShots,
      hasActiveTasks: () => true,
    }))!;

    polling.notifyAccepted();
    await nextTick();
    expect(refreshShots).toHaveBeenCalledTimes(1);
    projectUuid.value = "32323232-3232-4232-a232-323232323252";
    await nextTick();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refreshShots).toHaveBeenCalledTimes(1);

    pending.resolve(true);
    await vi.runAllTicks();
    scope.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refreshShots).toHaveBeenCalledTimes(1);
  });

  it("旧项目刷新永久悬挂时，新项目受理仍必须立即开始自己的刷新", async () => {
    const projectUuid = ref("32323232-3232-4232-a232-323232323253");
    const oldPending = deferred<boolean>();
    const refreshShots = vi.fn()
      .mockReturnValueOnce(oldPending.promise)
      .mockResolvedValue(true);
    const scope = effectScope();
    const polling = scope.run(() => useStoryboardGenerationPolling({
      projectUuid,
      refreshShots,
      hasActiveTasks: () => true,
    }))!;

    polling.notifyAccepted();
    await nextTick();
    expect(refreshShots).toHaveBeenCalledTimes(1);

    projectUuid.value = "32323232-3232-4232-a232-323232323254";
    await nextTick();
    polling.notifyAccepted();
    await nextTick();
    expect(refreshShots).toHaveBeenCalledTimes(2);

    scope.stop();
    oldPending.resolve(true);
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refreshShots).toHaveBeenCalledTimes(2);
  });

  it("首次加载到已有活动任务时必须自动启动轮询", async () => {
    const projectUuid = ref("32323232-3232-4232-a232-323232323255");
    const active = ref(true);
    const refreshShots = vi.fn().mockResolvedValue(true);
    const scope = effectScope();
    scope.run(() => useStoryboardGenerationPolling({
      projectUuid,
      refreshShots,
      hasActiveTasks: () => active.value,
    }));

    await nextTick();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(refreshShots).toHaveBeenCalledTimes(1);

    active.value = false;
    await nextTick();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refreshShots).toHaveBeenCalledTimes(1);
    scope.stop();
  });

  it("受理后的首次刷新失败必须保留提交完成语义", async () => {
    const projectUuid = ref("32323232-3232-4232-a232-323232323256");
    const onAcceptedRefreshError = vi.fn();
    const scope = effectScope();
    const polling = scope.run(() => useStoryboardGenerationPolling({
      projectUuid,
      refreshShots: vi.fn().mockResolvedValue(false),
      hasActiveTasks: () => true,
      onAcceptedRefreshError,
    }))!;

    polling.notifyAccepted();
    await vi.runAllTicks();
    await Promise.resolve();
    await Promise.resolve();
    expect(onAcceptedRefreshError).toHaveBeenCalledTimes(1);
    scope.stop();
  });

  it("旧刷新在途期间收到受理通知，旧响应结束后必须补跑一次新刷新", async () => {
    const projectUuid = ref("32323232-3232-4232-a232-323232323257");
    const active = ref(true);
    const oldRefresh = deferred<boolean>();
    const refreshShots = vi.fn()
      .mockReturnValueOnce(oldRefresh.promise)
      .mockResolvedValue(true);
    const scope = effectScope();
    const polling = scope.run(() => useStoryboardGenerationPolling({
      projectUuid,
      refreshShots,
      hasActiveTasks: () => active.value,
    }))!;

    await nextTick();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(refreshShots).toHaveBeenCalledTimes(1);
    active.value = false;
    polling.notifyAccepted();
    oldRefresh.resolve(true);
    await vi.runAllTicks();
    await Promise.resolve();
    await Promise.resolve();
    expect(refreshShots).toHaveBeenCalledTimes(2);
    scope.stop();
  });

  it("真实恢复与后处理重试状态必须被识别为活动任务", async () => {
    const module = await import("@/views/storyboardProject/useStoryboardGenerationPolling");
    const isActive = (module as unknown as {
      isStoryboardGenerationTaskStatusActive?: (status: string) => boolean;
    }).isStoryboardGenerationTaskStatusActive;
    expect(typeof isActive).toBe("function");
    if (!isActive) return;
    expect(isActive("recovering")).toBe(true);
    expect(isActive("postprocess_failed_retryable")).toBe(true);
    expect(isActive("completed")).toBe(false);
  });
});
