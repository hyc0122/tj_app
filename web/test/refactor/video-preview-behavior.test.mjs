import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import path from "node:path";

const moduleUrl = pathToFileURL(
  path.resolve("src/views/production/components/workbench/editVideo/composables/videoPreviewLogic.ts"),
).href;

test("视频预览逻辑模块可独立执行", async () => {
  const logic = await import(moduleUrl);
  assert.equal(typeof logic.calculatePreviewRect, "function");
});

test("媒体按画布比例等比居中且不超出画布", async () => {
  const { calculatePreviewRect } = await import(moduleUrl);
  assert.deepEqual(calculatePreviewRect(1920, 1080, 1080, 1080), {
    x: 0,
    y: 236.25,
    width: 1080,
    height: 607.5,
  });
});

test("字幕轨道始终位于普通媒体轨道之上", async () => {
  const { calculateTrackZIndex } = await import(moduleUrl);
  assert.ok(calculateTrackZIndex(2, true) > calculateTrackZIndex(999, false));
});

test("播放时间在秒与微秒之间双向换算且不丢失小数", async () => {
  const { secondsToMicroseconds, microsecondsToSeconds } = await import(moduleUrl);

  assert.equal(secondsToMicroseconds(1.234567), 1_234_567);
  assert.equal(microsecondsToSeconds(9_876_543), 9.876543);
});

test("导出前置条件区分画布未初始化与无可导出 sprite", async () => {
  const { assertExportReady } = await import(moduleUrl);
  const translate = (key) => key;

  assert.throws(
    () => assertExportReady(null, 0, translate),
    /workbench\.production\.editVideo\.avCanvasNotInit/,
  );
  assert.throws(
    () => assertExportReady({ id: "canvas" }, 0, translate),
    /workbench\.production\.editVideo\.noExportContent/,
  );
  assert.deepEqual(assertExportReady({ id: "canvas" }, 2, translate), { id: "canvas" });
});

test("Canvas 时间回调与时间轴 seek 保持双向同步", async () => {
  const { syncCanvasTimeToStore, syncStoreTimeToCanvas } = await import(moduleUrl);
  const previews = [];
  const state = {
    currentTime: { value: 0 },
    isPlaying: { value: false },
    flags: { updatingFromCanvas: false, updatingFromStore: false },
    debugData: { currentTime: 0 },
    seekTo: (time) => previews.push(["seek", time]),
    canvas: { previewFrame: (time) => previews.push(["preview", time]) },
  };

  syncCanvasTimeToStore(2_500_000, state);
  assert.equal(state.currentTime.value, 2_500_000);
  assert.equal(state.debugData.currentTime, 2_500_000);
  assert.deepEqual(previews[0], ["seek", 2.5]);

  state.flags.updatingFromCanvas = false;
  syncStoreTimeToCanvas(3.25, state);
  assert.equal(state.currentTime.value, 3_250_000);
  assert.deepEqual(previews[1], ["preview", 3_250_000]);
});

test("播放中导出先暂停 Canvas 与时间轴，静止时不重复暂停", async () => {
  const { pausePreviewForExport } = await import(moduleUrl);
  const events = [];
  const playing = { value: true };

  pausePreviewForExport(
    playing,
    () => events.push("canvas-pause"),
    () => events.push("store-pause"),
  );
  pausePreviewForExport(
    playing,
    () => events.push("unexpected-canvas-pause"),
    () => events.push("unexpected-store-pause"),
  );

  assert.deepEqual(events, ["canvas-pause", "store-pause"]);
  assert.equal(playing.value, false);
});

test("转场窗口按前后片段分别计算进度", async () => {
  const { createServer } = await import("vite");
  const server = await createServer({
    root: process.cwd(),
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  try {
    const { detectTransitions, getActiveTransitionAtTime } = await server.ssrLoadModule(
      "/src/views/production/components/workbench/editVideo/composables/videoTransitions.ts",
    );
    const context = {
      tracksStore: {
        tracks: [{
          id: "track-1",
          visible: true,
          clips: [
            { id: "before", type: "video", startTime: 0, endTime: 5 },
            { id: "after", type: "video", startTime: 5, endTime: 10 },
            { id: "transition", type: "transition", startTime: 4, endTime: 6, transitionType: "fade" },
          ],
        }],
      },
      transitionInfoMap: new Map(),
      clipTransitionsMap: new Map(),
    };

    detectTransitions(context);

    assert.deepEqual(getActiveTransitionAtTime(context, 4.5, "before"), {
      transition: context.transitionInfoMap.get("transition"),
      progress: 0.5,
      isBeforeClip: true,
    });
    assert.deepEqual(getActiveTransitionAtTime(context, 5.5, "after"), {
      transition: context.transitionInfoMap.get("transition"),
      progress: 0.5,
      isBeforeClip: false,
    });
  } finally {
    await server.close();
  }
});

test("source、裁剪、音量、倍速或字幕变化都会触发 sprite 重建", async () => {
  const { createServer } = await import("vite");
  const server = await createServer({
    root: process.cwd(),
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  try {
    const { getClipSnapshot, needsRebuildSprite } = await server.ssrLoadModule(
      "/src/views/production/components/workbench/editVideo/composables/videoSpriteRegistry.ts",
    );
    const base = {
      id: "clip-1",
      type: "video",
      trimStart: 1,
      trimEnd: 8,
      playbackRate: 1,
      sourceUrl: "/a.mp4",
      text: "",
      volume: 1,
    };
    const context = { clipSnapshotMap: new Map([["clip-1", getClipSnapshot(base)]]) };

    for (const change of [
      { sourceUrl: "/b.mp4" },
      { trimStart: 2 },
      { trimEnd: 7 },
      { playbackRate: 1.5 },
      { volume: 0.5 },
      { text: "新字幕" },
    ]) {
      assert.equal(needsRebuildSprite(context, { ...base, ...change }), true);
    }
    assert.equal(needsRebuildSprite(context, { ...base, startTime: 3, endTime: 9 }), false);
  } finally {
    await server.close();
  }
});

test("卸载清理按监听器、帧缓存、Canvas 顺序释放资源", async () => {
  const cleanupUrl = pathToFileURL(
    path.resolve("src/views/production/components/workbench/editVideo/composables/videoLifecycleCleanup.ts"),
  ).href;
  const { disposeVideoPreviewResources } = await import(cleanupUrl);
  const events = [];
  const context = {
    spriteListenerMap: new Map([["clip-1", () => events.push("unsubscribe")]]),
    clipSpriteMap: new Map([["clip-1", {}]]),
    clipSnapshotMap: new Map([["clip-1", {}]]),
    clipTrackMap: new Map([["clip-1", {}]]),
    transitionInfoMap: new Map([["transition", {}]]),
    clipTransitionsMap: new Map([["clip-1", []]]),
    clipFrameCache: new Map([["clip-1", { close: () => events.push("frame-close") }]]),
    avCanvas: { value: { destroy: () => events.push("canvas-destroy") } },
  };

  disposeVideoPreviewResources(context);

  assert.deepEqual(events, ["unsubscribe", "frame-close", "canvas-destroy"]);
  assert.equal(context.clipSpriteMap.size, 0);
  assert.equal(context.clipFrameCache.size, 0);
  assert.equal(context.avCanvas.value, null);
});
