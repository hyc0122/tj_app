import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { reactive } from "vue";

function moduleUrl(relativePath) {
  return pathToFileURL(path.resolve(relativePath)).href;
}

test("素材拖拽保留完整媒体字段，并补齐轨道消费的 sourceUrl", async () => {
  const { buildMediaDragData } = await import(
    moduleUrl("src/views/production/components/workbench/editVideo/composables/mediaLibraryLogic.ts")
  );

  assert.deepEqual(
    buildMediaDragData({
      id: "video-7",
      name: "镜头 7",
      url: "https://cdn.example/video-7.mp4",
      duration: 12,
      thumbnails: ["thumb-a"],
    }),
    {
      id: "video-7",
      name: "镜头 7",
      url: "https://cdn.example/video-7.mp4",
      duration: 12,
      thumbnails: ["thumb-a"],
      sourceUrl: "https://cdn.example/video-7.mp4",
    },
  );
});

test("属性面板把存储比例转换为整数百分比，并保留播放倍速", async () => {
  const { readVideoPropertyValues } = await import(
    moduleUrl("src/views/production/components/workbench/editVideo/composables/propertyPanelLogic.ts")
  );

  assert.deepEqual(readVideoPropertyValues({ opacity: 0.456, volume: 0.804, playbackRate: 1.25 }), {
    opacity: 46,
    volume: 80,
    playbackRate: 1.25,
  });
});

test("转场时长更新保持原中心点不变", async () => {
  const { calculateCenteredTransitionRange } = await import(
    moduleUrl("src/views/production/components/workbench/editVideo/composables/propertyPanelLogic.ts")
  );

  assert.deepEqual(calculateCenteredTransitionRange(9, 11, 4), {
    startTime: 8,
    endTime: 12,
    transitionDuration: 4,
  });
});

test("新增媒体片段保留类型默认值和归一化时间", async () => {
  const { createMediaClip } = await import(
    moduleUrl("src/views/production/components/workbench/editVideo/composables/editVideoClipFactory.ts")
  );

  assert.deepEqual(
    createMediaClip(
      { id: "audio-3", type: "audio", name: "旁白", url: "/voice.mp3" },
      "track-2",
      1.23456,
      3.33333,
      "clip-fixed",
      (value) => Math.round(value * 1000) / 1000,
      (key) => key,
    ),
    {
      id: "clip-fixed",
      trackId: "track-2",
      startTime: 1.235,
      selected: false,
      type: "audio",
      name: "旁白",
      endTime: 4.568,
      sourceUrl: "/voice.mp3",
      originalDuration: 3.33333,
      trimStart: 0,
      trimEnd: 3.33333,
      playbackRate: 1,
      volume: 1,
      waveformData: [],
    },
  );
});

test("编辑工作台向子区块暴露的素材 props 随父级替换而更新", async () => {
  const { createEditVideoPropBindings } = await import(
    moduleUrl("src/views/production/components/workbench/editVideo/composables/editVideoConfig.ts")
  );
  const props = reactive({
    initialTracks: [],
    initialVideoItems: [{ id: "old" }],
    initialMediaItems: [],
    initialAudioItems: [],
    initialImageItems: [],
    canvasWidth: 1920,
    canvasHeight: 1080,
  });
  const bindings = createEditVideoPropBindings(props);

  props.initialVideoItems = [{ id: "new" }];

  assert.deepEqual(bindings.initialVideoItems.value, [{ id: "new" }]);
});

test("未知素材类型保持原基础片段合同，不伪装成特效", async () => {
  const { createMediaClip } = await import(
    moduleUrl("src/views/production/components/workbench/editVideo/composables/editVideoClipFactory.ts")
  );

  assert.deepEqual(
    createMediaClip(
      { id: "future-1", type: "future", name: "未来素材" },
      "track-9",
      2,
      5,
      "clip-future",
      (value) => value,
      (key) => key,
    ),
    {
      id: "clip-future",
      trackId: "track-9",
      startTime: 2,
      selected: false,
    },
  );
});

test("转场注册表保留别名，未知类型回退到淡入淡出", async () => {
  const { createServer } = await import("vite");
  const server = await createServer({
    root: process.cwd(),
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  try {
    const { fadeTransition, getTransitionRenderer, getSupportedTransitionTypes } = await server.ssrLoadModule(
      "/src/views/production/components/workbench/editVideo/utils/transitionRenderers/registry.ts",
    );
    assert.equal(getTransitionRenderer("slide"), getTransitionRenderer("slide-left"));
    assert.equal(getTransitionRenderer("unknown-transition"), fadeTransition);
    assert.deepEqual(getSupportedTransitionTypes().slice(0, 4), ["fade", "dissolve", "slide", "slide-left"]);
  } finally {
    await server.close();
  }
});
