import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let viteServer;
let logic;

before(async () => {
  viteServer = await createServer({
    root: process.cwd(),
    configFile: false,
    server: { middlewareMode: true },
    appType: "custom",
  });
  logic = await viteServer.ssrLoadModule(
    "/src/views/project/components/projectDialog/projectDialogLogic.ts",
  );
});

after(async () => {
  await viteServer?.close();
});

test("新建与编辑项目表单使用相同默认值和回显规则", () => {
  const empty = logic.createProjectForm();
  assert.equal(empty.projectType, "novel");
  assert.equal(empty.videoRatio, "16:9");
  assert.equal(empty.mode, "");

  const populated = logic.createProjectForm({
    id: "project-1",
    name: "测试项目",
    intro: "简介",
    type: "科幻",
    artStyle: null,
    directorManual: null,
    videoRatio: null,
    imageModel: "image-model",
    videoModel: "video-model",
    projectType: "",
    imageQuality: "2K",
    mode: "",
  });
  assert.equal(populated.id, "project-1");
  assert.equal(populated.projectType, "novel");
  assert.equal(populated.videoRatio, "16:9");
  assert.equal(populated.mode, "text");
});

test("项目必填项按原页面顺序返回首个缺失字段", () => {
  const form = logic.createProjectForm();
  assert.equal(logic.findMissingProjectField(form), "name");
  form.name = "项目";
  assert.equal(logic.findMissingProjectField(form), "type");
  form.type = "科幻";
  form.imageModel = "image";
  form.videoModel = "video";
  form.artStyle = "visual.md";
  form.directorManual = "director.md";
  form.intro = "简介";
  form.imageQuality = "2K";
  form.mode = "text";
  assert.equal(logic.findMissingProjectField(form), null);
});

test("视频模式数组保持 JSON key 与中文标签组合边界", () => {
  const mixed = ["videoReference:2", "imageReference:1"];
  assert.equal(logic.modeToKey(mixed), JSON.stringify(mixed));
  assert.equal(
    logic.getModeLabel(mixed, {
      videoReference: "视频参考",
      imageReference: "图片参考",
    }),
    "视频参考、图片参考",
  );
});
