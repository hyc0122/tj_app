import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import { generateText } from "ai";
import { transform } from "sucrase";

import rawVendorData from "../../src/lib/vendor.json";
import runCode from "../../src/utils/vm";

interface RecordedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

interface TemplateRuntime {
  vendor: {
    name: string;
    version: string;
    description: string;
    inputValues: Record<string, string>;
    models: Array<Record<string, unknown>>;
  };
  textRequest: (model: Record<string, unknown>, think: boolean, thinkLevel: number) => unknown;
  imageRequest: (config: Record<string, unknown>, model: Record<string, unknown>) => Promise<string>;
  videoRequest: (config: Record<string, unknown>, model: Record<string, unknown>) => Promise<string>;
  queryTask: (remoteTaskId: string, context?: { remoteStatusHint?: string; taskClass?: string }) => Promise<Record<string, unknown>>;
  listModels: () => Promise<Array<{ id: string }>>;
}

const appRoot = path.resolve(process.cwd());
const templatePath = path.join(
  appRoot,
  "src",
  "provider-templates",
  "tianjiang.ts.template",
);

function loadTemplate(
  baseUrl: string,
  events: string[] = [],
): TemplateRuntime {
  const source = fs.readFileSync(templatePath, "utf8");
  const javascript = transform(source, { transforms: ["typescript"] }).code;
  const runtime = runCode(javascript, undefined, {
    provider: "tianjiang",
    onRemoteTaskCreated: async (remoteTaskId) => {
      events.push(`persist:${remoteTaskId}`);
    },
  }) as unknown as TemplateRuntime;
  runtime.vendor.inputValues.apiKey = "test-api-key";
  runtime.vendor.inputValues.baseUrl = baseUrl;
  return runtime;
}

async function createMockServer(events?: string[]) {
  const requests: RecordedRequest[] = [];
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method === "GET" && /\/tasks\//.test(requestPath)) events?.push(`query:${requestPath}`);
    requests.push({
      method: request.method ?? "GET",
      path: requestPath,
      headers: request.headers,
      body,
    });

    response.setHeader("content-type", "application/json");
    if (requestPath === "/v1/chat/completions") {
      return response.end(JSON.stringify({
        id: "chat-1",
        object: "chat.completion",
        created: 1,
        model: "example-text-model",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "文本完成" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    }
    if (requestPath === "/v1/images/create") {
      const parsed = JSON.parse(body.toString("utf8")) as { prompt?: string };
      if (parsed.prompt === "触发控制面错误") {
        response.statusCode = 503;
        return response.end(JSON.stringify({
          request_id: "request-control-unavailable",
          error: {
            code: "EDGE_CONTROL_UNAVAILABLE",
            message: "The control plane is unavailable",
            retryable: true,
            retry_after_seconds: 3,
          },
        }));
      }
      if (parsed.prompt === "触发错误") {
        response.statusCode = 400;
        return response.end(JSON.stringify({
          request_id: "request-image-error",
          error: {
            code: "EDGE_BAD_REQUEST",
            message: "图片参数无效",
            retryable: false,
            retry_after_seconds: 0,
          },
        }));
      }
      return response.end(JSON.stringify({
        id: "image-task-1",
        task_id: "image-task-1",
        status: "queued",
        model: "example-image-model",
        created_at: 1,
      }));
    }
    if (request.method === "GET" && requestPath.startsWith("/v1/images/tasks/")) {
      const id = requestPath.split("/").at(-1);
      if (id === "image-task-1") return response.end(JSON.stringify({
        code: "success",
        data: { id: 12345, task_id: id, status: "SUCCESS", progress: "100%", fail_reason: "", result_url: "https://media.example/generated.png" },
      }));
      if (id === "pending-image") return response.end(JSON.stringify({
        code: "success", data: { id: 12346, task_id: id, status: "IN_PROGRESS", progress: "30%", result_url: "", fail_reason: "" },
      }));
      if (id === "failed-image") return response.end(JSON.stringify({
        code: "success", data: { id: 12347, task_id: id, status: "FAILURE", progress: "0%", result_url: "", fail_reason: "图片生成失败" },
      }));
      if (id === "envelope-error") return response.end(JSON.stringify({ code: "error", message: "查询不可用" }));
    }
    if (request.method === "GET" && requestPath === "/v1/models") {
      return response.end(JSON.stringify({
        object: "list",
        data: [
          { id: "video-model-b", object: "model", created: 2, owned_by: "jiasu" },
          { id: "video-model-a", object: "model", created: 1, owned_by: "jiasu" },
          { id: "video-model-b", object: "model", created: 2, owned_by: "jiasu" },
          { id: "", object: "model", created: 0, owned_by: "jiasu" },
        ],
      }));
    }
    if (request.method === "POST" && requestPath === "/v1/video/generations") {
      return response.end(JSON.stringify({
        id: "video-task-1",
        object: "video",
        status: "queued",
        model: "example-video-model",
        progress: 0,
        created_at: 1,
      }));
    }
    if (request.method === "GET" && requestPath === "/v1/videos/tasks/video-task-1") {
      return response.end(JSON.stringify({
          id: "video-task-1",
          object: "video",
          model: "example-video-model",
          status: "completed",
          progress: 100,
          created_at: 1,
          result_urls: ["https://media.example/generated.mp4"],
      }));
    }
    if (requestPath === "/v1/videos/tasks/missing-result") {
      return response.end(JSON.stringify({ id: "missing-result", status: "completed", url: "https://media.example/deprecated.mp4" }));
    }
    if (requestPath === "/v1/videos/tasks/failed-video") {
      return response.end(JSON.stringify({ id: "failed-video", status: "failed", error: { code: "GENERATION_FAILED", message: "视频生成失败" } }));
    }
    if (requestPath === "/v1/videos/tasks/unknown-video") {
      return response.end(JSON.stringify({ id: "unknown-video", status: "unknown", result_urls: [] }));
    }

    response.statusCode = 404;
    response.end(JSON.stringify({
      request_id: "request-not-found",
      error: {
        code: "EDGE_NOT_FOUND",
        message: `未实现路径 ${requestPath}`,
        retryable: false,
        retry_after_seconds: 0,
      },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("佳速 API 模板使用正式 OpenAPI 的文本、图片、视频基准模型", async () => {
  const source = fs.readFileSync(templatePath, "utf8");
  const runtime = loadTemplate("http://127.0.0.1:1/v1");
  assert.equal(runtime.vendor.name, "佳速 API");
  assert.equal(runtime.vendor.version, "5.1");
  assert.match(runtime.vendor.description, /https:\/\/jsapi\.apifox\.cn\//);
  assert.match(runtime.vendor.description, /https:\/\/js\.jiasuapi\.com\//);
  assert.match(runtime.vendor.description, /https:\/\/js\.jiasuapi\.com\/keys/);
  assert.doesNotMatch(runtime.vendor.description, /https:\/\/jiasu\.apifox\.cn\//);
  assert.doesNotMatch(runtime.vendor.description, /api\.tianjiang\.net/);
  assert.match(
    source,
    /const PRODUCTION_BASE_URL = "https:\/\/ai\.jiasuapi\.com\/v1"/,
  );
  assert.match(source, /async function listModels\(\)[\s\S]*?requestJson\(\s*"\/models"/);
  assert.doesNotMatch(source, /LEGACY_BASE_URL|api\.tianjiang\.net/);
  assert.deepEqual(
    runtime.vendor.models.map((model) => model.type),
    ["text", "image", "video"],
  );
  assert.deepEqual(
    runtime.vendor.models.map((model) => model.modelName),
    [
      "deepseek-v4-pro",
      "doubao-seedream-4-0-250828",
      "doubao-seedance-1-0-pro-fast",
    ],
  );
  // Windows 工作树可能使用 CRLF；模板一致性只忽略换行符差异，不放宽正文内容。
  const normalizeLineEndings = (value: string) => value.replace(/\r\n/g, "\n");
  assert.equal(
    normalizeLineEndings(rawVendorData["tianjiang.ts"]),
    normalizeLineEndings(source),
  );
});

test("文本模型通过 POST /v1/chat/completions 完成请求", async () => {
  const fixture = await createMockServer();
  try {
    const runtime = loadTemplate(fixture.baseUrl);
    const model = runtime.vendor.models.find((item) => item.type === "text");
    assert.ok(model);
    const result = await generateText({
      model: runtime.textRequest(model, false, 0) as Parameters<typeof generateText>[0]["model"],
      prompt: "测试文本",
    });
    assert.equal(result.text, "文本完成");
    assert.deepEqual(
      fixture.requests.map((request) => `${request.method} ${request.path}`),
      ["POST /v1/chat/completions"],
    );
  } finally {
    await fixture.close();
  }
});

test("图片先持久化公开任务 ID 再查询，使用 ratio/resolution 而不是旧同步参数", async () => {
  const events: string[] = [];
  const fixture = await createMockServer(events);
  try {
    const runtime = loadTemplate(fixture.baseUrl, events);
    const model = { name: "示例图片", modelName: "example-image-model", type: "image", mode: ["text"] };
    const result = await runtime.imageRequest({
      prompt: "生成角色立绘",
      referenceList: [],
      size: "1K",
      aspectRatio: "16:9",
    }, model);
    assert.equal(result, "https://media.example/generated.png");
    assert.deepEqual(fixture.requests.map((request) => `${request.method} ${request.path}`), [
      "POST /v1/images/create", "GET /v1/images/tasks/image-task-1",
    ]);
    assert.deepEqual(events, ["persist:image-task-1", "query:/v1/images/tasks/image-task-1"]);
    assert.equal(fixture.requests[0].method, "POST");
    assert.equal(fixture.requests[0].path, "/v1/images/create");
    assert.equal(fixture.requests[0].headers.authorization, "Bearer test-api-key");
    assert.deepEqual(JSON.parse(fixture.requests[0].body.toString("utf8")), {
      model: "example-image-model",
      prompt: "生成角色立绘",
      ratio: "16:9",
      resolution: "1k",
    });
  } finally {
    await fixture.close();
  }
});

test("单参考图通过 /v1/images/create 以 images URL 数组发送", async () => {
  const fixture = await createMockServer();
  try {
    const runtime = loadTemplate(fixture.baseUrl);
    const model = {
      name: "示例图片",
      modelName: "example-image-model",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
    };
    const result = await runtime.imageRequest({
      prompt: "保持角色一致并修改服装",
      referenceList: [{
        type: "image",
        sourceType: "base64",
        base64: "https://media.example/first.png",
      }],
      size: "1K",
      aspectRatio: "9:16",
    }, model);
    assert.equal(result, "https://media.example/generated.png");
    assert.equal(fixture.requests.length, 2);
    assert.equal(fixture.requests[0].path, "/v1/images/create");
    assert.equal(fixture.requests[0].headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(fixture.requests[0].body.toString("utf8")), {
      model: "example-image-model",
      prompt: "保持角色一致并修改服装",
      images: ["https://media.example/first.png"],
      ratio: "9:16",
      resolution: "1k",
    });
  } finally {
    await fixture.close();
  }
});

test("多参考图通过 /v1/images/create 以 images 数组保持原顺序", async () => {
  const fixture = await createMockServer();
  try {
    const runtime = loadTemplate(fixture.baseUrl);
    const model = {
      name: "示例图片",
      modelName: "example-image-model",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
    };
    const result = await runtime.imageRequest({
      prompt: "融合角色与场景参考图",
      referenceList: [
        { type: "image", sourceType: "base64", base64: "https://media.example/first.png" },
        { type: "image", sourceType: "base64", base64: "https://media.example/second.png" },
      ],
      size: "1K",
      aspectRatio: "16:9",
    }, model);
    assert.equal(result, "https://media.example/generated.png");
    assert.equal(fixture.requests.length, 2);
    assert.equal(fixture.requests[0].path, "/v1/images/create");
    const requestBody = JSON.parse(fixture.requests[0].body.toString("utf8"));
    assert.deepEqual(requestBody.images, [
      "https://media.example/first.png",
      "https://media.example/second.png",
    ]);
    assert.equal("image" in requestBody, false);
    assert.equal("response_format" in requestBody, false);
  } finally {
    await fixture.close();
  }
});

test("视频只创建一次并在持久化远端 ID 后 GET 查询原任务", async () => {
  const events: string[] = [];
  const fixture = await createMockServer(events);
  try {
    const runtime = loadTemplate(fixture.baseUrl, events);
    const model = {
      name: "示例视频",
      modelName: "example-video-model",
      type: "video",
      mode: ["text", "startFrameOptional"],
      audio: "optional",
      durationResolutionMap: [],
    };
    const result = await runtime.videoRequest({
      prompt: "角色向镜头走来",
      duration: 5,
      resolution: "720p",
      aspectRatio: "16:9",
      mode: ["text"],
      audio: true,
      referenceList: [{
        type: "image",
        sourceType: "base64",
        base64: "https://media.example/reference.png",
      }, {
        type: "video",
        sourceType: "base64",
        base64: "https://media.example/reference.mp4",
      }, {
        type: "audio",
        sourceType: "base64",
        base64: "https://media.example/reference.mp3",
      }],
    }, model);
    assert.equal(result, "https://media.example/generated.mp4");
    assert.deepEqual(
      fixture.requests.map((request) => `${request.method} ${request.path}`),
      [
        "POST /v1/video/generations",
        "GET /v1/videos/tasks/video-task-1",
      ],
    );
    assert.deepEqual(events, ["persist:video-task-1", "query:/v1/videos/tasks/video-task-1"]);
    const createBody = JSON.parse(fixture.requests[0].body.toString("utf8"));
    assert.equal(createBody.model, "example-video-model");
    assert.equal(createBody.prompt, "角色向镜头走来");
    assert.equal(createBody.duration, 5);
    assert.equal(createBody.ratio, "16:9");
    assert.equal(createBody.resolution, "720p");
    assert.deepEqual(createBody.images, [{ url: "https://media.example/reference.png" }]);
    assert.deepEqual(createBody.videos, [{ url: "https://media.example/reference.mp4" }]);
    assert.deepEqual(createBody.audios, [{ url: "https://media.example/reference.mp3" }]);
    assert.equal("generate_audio" in createBody, false);
    assert.equal("content" in createBody, false);
  } finally {
    await fixture.close();
  }
});

test("视频参考保留项目名称、媒体顺序及同 URL 不同名称，空名由上游编号且不重复提交 materials", async () => {
  const fixture = await createMockServer();
  try {
    const runtime = loadTemplate(fixture.baseUrl);
    const prompt = "@角色甲和@角色乙在@场景中，@角色甲的音色用于角色甲";
    await runtime.videoRequest({
      prompt, duration: 5, resolution: "720p", aspectRatio: "16:9", mode: [["imageReference:3", "videoReference:1", "audioReference:1"]],
      referenceList: [
        { type: "image", base64: "https://media.example/shared.png", name: "角色甲" },
        { type: "audio", base64: "https://media.example/voice.mp3", name: "角色甲的音色" },
        { type: "image", base64: "https://media.example/shared.png", name: "角色乙" },
        { type: "video", base64: "https://media.example/ref.mp4", name: "  " },
        { type: "image", base64: "https://media.example/scene.png", name: "场景" },
      ],
    }, { modelName: "existing-user-mapping", type: "video" });
    const body = JSON.parse(fixture.requests[0].body.toString("utf8"));
    assert.equal(body.model, "existing-user-mapping");
    assert.equal(body.prompt, prompt);
    assert.deepEqual(body.images, [
      { url: "https://media.example/shared.png", name: "角色甲" },
      { url: "https://media.example/shared.png", name: "角色乙" },
      { url: "https://media.example/scene.png", name: "场景" },
    ]);
    assert.deepEqual(body.audios, [{ url: "https://media.example/voice.mp3", name: "角色甲的音色" }]);
    assert.deepEqual(body.videos, [{ url: "https://media.example/ref.mp4" }]);
    assert.equal("materials" in body, false);
    assert.equal(fixture.requests.filter((request) => request.method === "POST").length, 1);
  } finally { await fixture.close(); }
});

test("获取模型列表只返回去重后的非空模型 ID", async () => {
  const fixture = await createMockServer();
  try {
    const runtime = loadTemplate(fixture.baseUrl);
    const models = await runtime.listModels();
    assert.deepEqual(models, [
      { id: "video-model-b", object: "model", created: 2, owned_by: "jiasu" },
      { id: "video-model-a", object: "model", created: 1, owned_by: "jiasu" },
    ]);
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0].method, "GET");
    assert.equal(fixture.requests[0].path, "/v1/models");
    assert.equal(fixture.requests[0].headers.authorization, "Bearer test-api-key");
    assert.doesNotMatch(JSON.stringify(models), /test-api-key/);
  } finally {
    await fixture.close();
  }
});

test("图片错误只暴露安全诊断字段，不回显 API Key 或参考素材", async () => {
  const fixture = await createMockServer();
  try {
    const runtime = loadTemplate(fixture.baseUrl);
    const model = { name: "示例图片", modelName: "example-image-model", type: "image", mode: ["text"] };
    await assert.rejects(
      runtime.imageRequest({
        prompt: "触发错误",
        referenceList: [],
        size: "1K",
        aspectRatio: "1:1",
      }, model),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /图片生成请求失败/);
        assert.match(message, /HTTP 400/);
        assert.match(message, /request-image-error/);
        assert.match(message, /EDGE_BAD_REQUEST/);
        assert.match(message, /图片参数无效/);
        assert.doesNotMatch(message, /test-api-key|Authorization|base64/i);
        return true;
      },
    );
  } finally {
    await fixture.close();
  }
});

test("佳速控制面 503 显示中文指引且收费图片请求只发送一次", async () => {
  const fixture = await createMockServer();
  try {
    const runtime = loadTemplate(fixture.baseUrl);
    const model = { name: "示例图片", modelName: "example-image-model", type: "image", mode: ["text"] };
    await assert.rejects(
      runtime.imageRequest({
        prompt: "触发控制面错误",
        referenceList: [],
        size: "1K",
        aspectRatio: "1:1",
      }, model),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /图片生成请求失败/);
        assert.match(message, /HTTP 503/);
        assert.match(message, /request-control-unavailable/);
        assert.match(message, /EDGE_CONTROL_UNAVAILABLE/);
        assert.match(message, /佳速 API 控制面暂不可用/);
        assert.match(message, /3 秒后手动重试/);
        assert.doesNotMatch(message, /The control plane is unavailable/);
        return true;
      },
    );
    assert.equal(fixture.requests.length, 1);
  } finally {
    await fixture.close();
  }
});

test("queryTask 重启恢复只查询原视频任务 ID", async () => {
  const fixture = await createMockServer();
  try {
    const runtime = loadTemplate(fixture.baseUrl);
    const result = await runtime.queryTask("video-task-1");
    assert.equal(result.state, "completed");
    assert.equal((result.artifact as { mediaType: string }).mediaType, "video");
    assert.equal(result.url, "https://media.example/generated.mp4");
    assert.equal((result.output as { url?: string } | undefined)?.url, "https://media.example/generated.mp4");
    assert.deepEqual(
      fixture.requests.map((request) => `${request.method} ${request.path}`),
      ["GET /v1/videos/tasks/video-task-1"],
    );
  } finally {
    await fixture.close();
  }
});

test("queryTask 对不存在的远端任务返回 not_found，禁止误判为处理中", async () => {
  const fixture = await createMockServer();
  try {
    const runtime = loadTemplate(fixture.baseUrl);
    const result = await runtime.queryTask("missing-task");
    assert.deepEqual(result, { state: "not_found", reason: "远端任务不存在" });
    assert.deepEqual(
      fixture.requests.map((request) => `${request.method} ${request.path}`),
      ["GET /v1/videos/tasks/missing-task"],
    );
  } finally {
    await fixture.close();
  }
});

test("图片恢复按创建路径或任务类型选择图片查询，envelope success 不等于任务成功", async () => {
  const fixture = await createMockServer();
  try {
    const runtime = loadTemplate(fixture.baseUrl);
    const context = { remoteStatusHint: "/v1/images/create" };
    assert.equal((await runtime.queryTask("image-task-1", context)).url, "https://media.example/generated.png");
    assert.equal((await runtime.queryTask("pending-image", context)).state, "pending");
    assert.deepEqual(await runtime.queryTask("failed-image", { taskClass: "图片生成" }), { state: "failed", reason: "图片生成失败" });
    assert.equal((await runtime.queryTask("envelope-error", context)).state, "temporary_error");
    assert.ok(fixture.requests.every((request) => request.method === "GET" && request.path.startsWith("/v1/images/tasks/")));
  } finally { await fixture.close(); }
});

test("视频恢复识别失败与未知状态，禁止把已废弃 url 当成 result_urls", async () => {
  const fixture = await createMockServer();
  try {
    const runtime = loadTemplate(fixture.baseUrl);
    assert.equal((await runtime.queryTask("missing-result")).state, "temporary_error");
    assert.equal((await runtime.queryTask("unknown-video")).state, "pending");
    const failed = await runtime.queryTask("failed-video");
    assert.equal(failed.state, "failed");
    assert.match(String(failed.reason), /视频生成失败/);
    assert.ok(fixture.requests.every((request) => request.method === "GET"));
  } finally { await fixture.close(); }
});

test("首尾帧模式用明确字段，未声明的旧参数不发送", async () => {
  const fixture = await createMockServer();
  try {
    const runtime = loadTemplate(fixture.baseUrl);
    await runtime.videoRequest({
      prompt: "首尾帧", duration: 5, resolution: "1080p", aspectRatio: "9:16", mode: ["startEndRequired"],
      referenceList: [
        { type: "image", base64: "https://media.example/first.png" },
        { type: "image", base64: "https://media.example/last.png" },
      ],
    }, { modelName: "my-mapped-video", type: "video" });
    assert.deepEqual(JSON.parse(fixture.requests[0].body.toString("utf8")), {
      model: "my-mapped-video", prompt: "首尾帧", duration: 5, resolution: "1080p", ratio: "9:16",
      first_frame_url: "https://media.example/first.png", end_frame_url: "https://media.example/last.png",
    });
  } finally { await fixture.close(); }
});

test("未暂存的内联参考素材不能进入 URL 数组，拒绝时不发送创建请求", async () => {
  const fixture = await createMockServer();
  try {
    const runtime = loadTemplate(fixture.baseUrl);
    await assert.rejects(runtime.imageRequest({
      prompt: "参考图", size: "2K", aspectRatio: "1:1",
      referenceList: [{ type: "image", base64: "data:image/png;base64,aW1hZ2U=" }],
    }, { type: "image", modelName: "user-image" }), /HTTPS/);
    assert.equal(fixture.requests.length, 0);
  } finally { await fixture.close(); }
});

test("旧工作台字符串模式与新数组模式均把单张尾帧发送到 end_frame_url", async () => {
  const fixture = await createMockServer();
  try {
    const runtime = loadTemplate(fixture.baseUrl);
    for (const mode of ["startFrameOptional", ["startFrameOptional"]]) {
      await runtime.videoRequest({ prompt: "尾帧", duration: 5, resolution: "720p", aspectRatio: "16:9", mode,
        referenceList: [{ type: "image", base64: "https://media.example/last.png" }],
      }, { modelName: "existing-user-model", type: "video" });
    }
    for (const request of fixture.requests.filter((item) => item.method === "POST")) {
      const body = JSON.parse(request.body.toString("utf8"));
      assert.equal(body.end_frame_url, "https://media.example/last.png");
      assert.equal(body.first_frame_url, undefined);
      assert.equal(body.images, undefined);
    }
  } finally { await fixture.close(); }
});
