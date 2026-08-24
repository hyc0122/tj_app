#!/usr/bin/env node
/**
 * 即梦 CLI 测试替身。只按 argv 模拟官方命令，禁止访问真实网络或收费接口。
 * 由测试通过 DREAMINA_FAKE_SCENARIO / DREAMINA_FAKE_LOG 控制场景与调用记录。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const scenario = String(process.env.DREAMINA_FAKE_SCENARIO || "default");
const logPath = process.env.DREAMINA_FAKE_LOG;
const authMarker = process.env.DREAMINA_FAKE_AUTH_MARKER;

function readReferenceContents(argv) {
  const singleFlags = ["--image=", "--video=", "--audio=", "--first=", "--last="];
  const paths = [];
  for (const argument of argv) {
    const single = singleFlags.find((prefix) => argument.startsWith(prefix));
    if (single) paths.push(argument.slice(single.length));
    if (argument.startsWith("--images=")) {
      paths.push(...argument.slice("--images=".length).split(",").filter(Boolean));
    }
  }
  return paths.map((filename) => {
    try {
      // 中文注释：在 fake CLI 进程内读取，证明收费边界实际打开的是快照内容。
      return fs.readFileSync(filename, "utf8");
    } catch {
      return null;
    }
  });
}

if (logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(
    logPath,
    `${JSON.stringify({
      ts: Date.now(),
      args,
      scenario,
      cwd: process.cwd(),
      referenceContents: readReferenceContents(args),
    })}\n`,
  );
}

if (scenario === "not_installed") {
  process.stderr.write("dreamina: command not found\n");
  process.exit(127);
}

if (scenario === "timeout") {
  const timer = setTimeout(() => undefined, 300_000);
  if (typeof timer.unref === "function") timer.unref();
  return;
}

if (scenario === "truncate") {
  process.stdout.write(`${"SENSITIVE_COOKIE=abc.secret.token\n".repeat(80)}${"X".repeat(5 * 1024 * 1024)}`);
  process.exit(0);
}

function writeOut(value) {
  process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
  process.stdout.write("\n");
}

function helpTop() {
  writeOut(`Usage: dreamina <command>

Commands:
  version
  user_credit
  text2image
  image2image
  text2video
  image2video
  frames2video
  multiframe2video
  multimodal2video
  query_result
  list_task
  session
  logout
  login
  relogin
`);
}

function helpMode(mode) {
  // 中文注释：只有 text2video help 声明视频模型，避免测试从其他模式误读枚举。
  const isVideoMode = String(mode).endsWith("video");
  const omitModelVersion = isVideoMode && (
    scenario === "missing_video_model_version"
    || (scenario === "model_version_text_only" && mode !== "text2video")
  );
  let modelVersion = omitModelVersion ? "" : "--model_version";
  if (mode === "text2video" && !omitModelVersion && scenario !== "missing_model_values") {
    if (["partial_model_values", "nonzero_with_partial_stdout", "timeout_with_partial_stdout"].includes(scenario)) {
      modelVersion = "--model_version string supported values: seedance2.0fast, seedance2.0mini";
    } else if (scenario === "similar_invalid_suffix") {
      modelVersion = "--model_version string supported values: seedance2.0fast_extra";
    } else {
      modelVersion = "--model_version string supported values: seedance2.0, seedance2.0fast, seedance2.0_vip, seedance2.0fast_vip, seedance2.0mini";
    }
  }
  const common = [
    ...(scenario === "missing_prompt_help" ? [] : ["--prompt"]),
    ...(modelVersion ? [modelVersion] : []),
    "--poll",
  ];
  const extra = {
    text2image: ["--ratio", "--resolution_type", "--generate_num", "--width", "--height"],
    image2image: ["--images", "--ratio", "--resolution_type", "--generate_num", "--width", "--height"],
    text2video: ["--ratio", "--video_resolution", "--duration"],
    image2video: ["--image", "--ratio", "--video_resolution", "--duration"],
    frames2video: ["--first", "--last", "--ratio", "--video_resolution", "--duration"],
    multiframe2video: ["--images", "--ratio", "--video_resolution", "--duration"],
    multimodal2video: [
      scenario === "legacy_multimodal_plural" ? "--images" : "--image",
      "--video",
      "--audio",
      "--ratio",
      "--video_resolution",
      "--duration",
    ],
  };
  const fields = extra[mode] || [];
  const hidden = scenario === "missing_ratio_help" ? new Set(["--ratio"]) : new Set();
  writeOut(`Usage: dreamina ${mode} [options]\n${[...common, ...fields].filter((item) => !hidden.has(item)).join("\n")}\n`);
}

const command = args[0];
const rest = args.slice(1);
const wantsHelp = rest.includes("-h") || rest.includes("--help");

function maybeProbeDelay() {
  // 中文注释：仅测试并发合并使用，默认 0，避免拖慢其他用例。
  const ms = Number(process.env.DREAMINA_FAKE_PROBE_DELAY_MS || 0);
  if (!Number.isFinite(ms) || ms <= 0) return;
  const started = Date.now();
  while (Date.now() - started < ms) {
    // 子进程内忙等，保证并发 getStatus 能撞上同一 inFlight。
  }
}

if (command === "version") {
  maybeProbeDelay();
  if (scenario === "reference_output") {
    // 中文注释：复刻当前本机 dreamina.exe 的真实非付费输出格式。
    writeOut({
      version: "54f1bdf-dirty",
      commit: "54f1bdf",
      build_time: "2026-08-15T00:00:00Z",
    });
    process.exit(0);
  }
  writeOut("dreamina 1.4.4");
  process.exit(0);
}

if (command === "-h" || command === "--help" || command === undefined) {
  helpTop();
  if (scenario === "top_help_nonzero_partial") {
    process.stderr.write("incomplete top help\n");
    process.exit(9);
  }
  if (scenario === "top_help_timeout_partial") {
    // 中文注释：先输出部分顶层帮助再挂起，验证调用方不能信任超时前的 stdout。
    setInterval(() => undefined, 1_000);
    return;
  }
  process.exit(0);
}

if (wantsHelp && [
  "text2image",
  "image2image",
  "text2video",
  "image2video",
  "frames2video",
  "multiframe2video",
  "multimodal2video",
  "query_result",
  "list_task",
  "session",
  "user_credit",
  "logout",
].includes(command)) {
  if (command === "session") {
    writeOut("Usage: dreamina session <list|search|create>\n--name\n");
  } else if ([
    "text2image",
    "image2image",
    "text2video",
    "image2video",
    "frames2video",
    "multiframe2video",
    "multimodal2video",
  ].includes(command)) {
    helpMode(command);
    if (command === "text2video" && scenario === "nonzero_with_partial_stdout") {
      process.stderr.write("incomplete help\n");
      process.exit(9);
    }
    if (command === "text2video" && scenario === "timeout_with_partial_stdout") {
      // 中文注释：先输出不完整帮助再保持进程存活，复现超时前已收到部分 stdout。
      setInterval(() => undefined, 1_000);
      return;
    }
  } else {
    writeOut(`Usage: dreamina ${command}\n`);
  }
  process.exit(0);
}

if (command === "user_credit") {
  maybeProbeDelay();
  const authorizationPending = scenario === "authorization_then_logged_in"
    && (!authMarker || !fs.existsSync(authMarker));
  if (["not_logged_in", "mixed_authorization", "spaced_authorization", "false_positive_check"].includes(scenario)
    || authorizationPending) {
    process.stderr.write("login required\n");
    process.exit(1);
  }
  if (scenario === "logged_in_no_credit") {
    writeOut({ ok: true });
    process.exit(0);
  }
  if (scenario === "reference_output") {
    // 中文注释：参考实现和当前本机 CLI 都使用 total_credit 字段。
    writeOut({ total_credit: 29, user_id: "fixture-user", user_name: "fixture", vip_level: 0 });
    process.exit(0);
  }
  writeOut({ credit_balance: 1280, vip: false, currency: "CNY" });
  process.exit(0);
}

if (command === "logout") {
  writeOut({ ok: true });
  process.exit(0);
}

if (command === "login") {
  if (rest[0] === "--headless") {
    if (scenario === "mixed_authorization") {
      writeOut([
        "OAuth Device Flow ready",
        "verification_uri: https://jimeng.jianying.com/auth",
        "user_code=ABCD-1234",
        "device_code=device-secret-not-for-ui",
        "expires_in=300",
        "interval=5",
      ].join("\n"));
      process.exit(0);
    }
    if (scenario === "spaced_authorization") {
      // 中文注释：模拟部分 CLI 使用空格分隔的人类可读设备授权标签。
      writeOut([
        "OAuth Device Flow ready",
        "Verification URI: https://jimeng.jianying.com/auth",
        "User Code: WXYZ-9876",
        "Device Code: device-secret-not-for-ui",
        "Expires In: 300",
        "Poll Interval: 5",
      ].join("\n"));
      process.exit(0);
    }
    writeOut({
      verification_uri: "https://jimeng.jianying.com/auth",
      user_code: "ABCD-1234",
      device_code: "device-secret-not-for-ui",
      expires_in: 300,
      interval: 5,
    });
    process.exit(0);
  }
  if (rest[0] === "checklogin") {
    if (scenario === "false_positive_check") {
      writeOut({ ok: true, status: "authorization_pending" });
      process.exit(0);
    }
    if (scenario === "authorization_then_logged_in" && authMarker) {
      fs.mkdirSync(path.dirname(authMarker), { recursive: true });
      fs.writeFileSync(authMarker, "authorized");
    }
    writeOut({ ok: true, status: "logged_in" });
    process.exit(0);
  }
  process.stderr.write("unsupported login action\n");
  process.exit(2);
}

if (command === "session") {
  const action = rest[0];
  if (action === "list") {
    writeOut({ sessions: [{ id: "sess-existing", name: "天将-已有会话" }] });
    process.exit(0);
  }
  if (action === "search") {
    writeOut({ sessions: [{ id: "sess-search", name: "天将-搜索会话" }] });
    process.exit(0);
  }
  if (action === "create") {
    writeOut({ id: "sess-created", name: "天将-新建会话" });
    process.exit(0);
  }
  process.stderr.write("unknown session action\n");
  process.exit(2);
}

if (command === "query_result") {
  const submit = rest.find((item) => item.startsWith("--submit_id="))?.slice("--submit_id=".length);
  const queryBarrier = String(process.env.DREAMINA_FAKE_QUERY_BARRIER || "");
  if (queryBarrier) {
    fs.mkdirSync(path.dirname(queryBarrier), { recursive: true });
    let firstQuery = false;
    try {
      const fd = fs.openSync(`${queryBarrier}.first.lock`, "wx");
      fs.closeSync(fd);
      firstQuery = true;
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
    }
    if (firstQuery) {
      // 中文注释：第一个 query 固定阻塞并最终返回 running，复现旧结果晚于新终态落盘。
      fs.writeFileSync(`${queryBarrier}.first.ready`, "ready");
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(`${queryBarrier}.release`) && Date.now() < deadline) {
        // fake CLI 子进程独立阻塞，不占用测试主进程事件循环。
      }
      if (!fs.existsSync(`${queryBarrier}.release`)) {
        process.stderr.write("query barrier timeout\n");
        process.exit(70);
      }
      fs.writeFileSync(`${queryBarrier}.first.finished`, "running");
      writeOut({ status: "running", submit_id: submit || "sub-unknown" });
      process.exit(0);
    }

    // 中文注释：并发的第二个 query 立即返回完成，用来证明恢复入口是否绕过 scheduler 串行器。
    const downloadDir = rest.find((item) => item.startsWith("--download_dir="))?.slice("--download_dir=".length)
      || process.cwd();
    const filePath = path.join(downloadDir, "result.png");
    fs.mkdirSync(downloadDir, { recursive: true });
    fs.writeFileSync(filePath, "fake-image");
    fs.writeFileSync(`${queryBarrier}.second.finished`, "completed");
    writeOut({
      status: "success",
      submit_id: submit || "sub-unknown",
      files: [filePath],
    });
    process.exit(0);
  }

  if (scenario === "delay_query") {
    // 中文注释：在查询结果写回前制造确定窗口，用于验证人工终结与在途 query 的 CAS。
    const delayMs = Number(process.env.DREAMINA_FAKE_DELAY_MS || 1_000);
    const startedAt = Date.now();
    while (Date.now() - startedAt < delayMs) {
      // 测试子进程内忙等，避免定时器被 unref 后提前退出。
    }
  }
  const forcedQueryStatus = String(process.env.DREAMINA_FAKE_QUERY_STATUS || "").trim();
  if (forcedQueryStatus) {
    // 中文注释：真实即梦 CLI 使用 gen_status；允许测试覆盖运行、取消、失败及未知状态。
    writeOut({
      gen_status: forcedQueryStatus,
      submit_id: submit || "sub-unknown",
      // 中文注释：可注入残留文件列表，证明取消状态不会被旧文件误判成完成。
      ...(process.env.DREAMINA_FAKE_QUERY_WITH_STALE_FILE === "1" ? { files: ["stale-result.mp4"] } : {}),
    });
    process.exit(0);
  }
  const downloadDir = rest.find((item) => item.startsWith("--download_dir="))?.slice("--download_dir=".length)
    || process.cwd();
  const filePath = path.join(downloadDir, "result.png");
  try {
    fs.mkdirSync(downloadDir, { recursive: true });
    fs.writeFileSync(filePath, "fake-image");
  } catch {
    // 由调用方校验文件
  }
  writeOut({
    status: "success",
    submit_id: submit || "sub-unknown",
    files: [filePath],
  });
  process.exit(0);
}

if (command === "list_task") {
  writeOut({ tasks: [{ submit_id: "sub-123", gen_status: "success" }] });
  process.exit(0);
}

const generateCommands = new Set([
  "text2image",
  "image2image",
  "text2video",
  "image2video",
  "frames2video",
  "multiframe2video",
  "multimodal2video",
]);

const GENERATION_FLAGS = {
  text2image: new Set(["prompt", "ratio", "resolution_type", "model_version", "generate_num", "width", "height", "poll", "session_id"]),
  image2image: new Set(["prompt", "images", "ratio", "resolution_type", "model_version", "generate_num", "width", "height", "poll", "session_id"]),
  text2video: new Set(["prompt", "duration", "ratio", "video_resolution", "model_version", "poll", "session_id"]),
  image2video: new Set(["prompt", "image", "duration", "ratio", "video_resolution", "model_version", "poll", "session_id"]),
  frames2video: new Set(["prompt", "first", "last", "duration", "ratio", "video_resolution", "model_version", "poll", "session_id"]),
  multiframe2video: new Set(["prompt", "images", "duration", "ratio", "video_resolution", "model_version", "poll", "session_id"]),
  multimodal2video: new Set(["prompt", "image", "video", "audio", "duration", "ratio", "video_resolution", "model_version", "poll", "session_id"]),
};

const REQUIRED_GENERATION_FLAGS = {
  text2image: ["prompt", "resolution_type"],
  image2image: ["prompt", "images", "resolution_type"],
  text2video: ["prompt", "duration", "ratio", "video_resolution"],
  image2video: ["prompt", "image", "duration"],
  frames2video: ["prompt", "first", "last", "duration"],
  multiframe2video: ["prompt", "images", "duration"],
  multimodal2video: ["prompt", "duration", "model_version"],
};

function parseGenerationFlags(values) {
  const parsed = new Map();
  for (const value of values) {
    // 中文注释：视频指令模板含换行；必须按完整 argv 取值，不能用 .* 截断。
    const match = /^--([a-z0-9_]+)=([\s\S]*)$/i.exec(value);
    if (!match) return { error: `invalid flag: ${value}` };
    const [, name, flagValue] = match;
    const list = parsed.get(name) || [];
    list.push(flagValue);
    parsed.set(name, list);
  }
  return { parsed };
}

function validateGenerationArgs(mode, values) {
  // 中文注释：默认及普通成功场景严格校验参数；旧版多模态复数参数只能在显式 legacy 场景使用。
  const allowed = new Set(GENERATION_FLAGS[mode]);
  if (mode === "multimodal2video" && scenario === "legacy_multimodal_plural") {
    allowed.delete("image");
    allowed.add("images");
  }
  const parsedResult = parseGenerationFlags(values);
  if (parsedResult.error) return parsedResult.error;
  const parsed = parsedResult.parsed;
  for (const name of parsed.keys()) {
    if (!allowed.has(name)) return `unknown flag: --${name}`;
  }
  for (const name of REQUIRED_GENERATION_FLAGS[mode]) {
    if (!parsed.has(name)) return `missing required flag: --${name}`;
  }
  if (mode === "text2image") {
    // 中文注释：图片尺寸可用比例或成对宽高表达，两种形式互斥且宽高不能只给一边。
    const hasRatio = parsed.has("ratio");
    const hasWidth = parsed.has("width");
    const hasHeight = parsed.has("height");
    if (hasWidth !== hasHeight) return "--width and --height must be provided together";
    if (hasRatio && hasWidth) return "--ratio conflicts with --width/--height";
    if (!hasRatio && !hasWidth) return "missing required image dimensions";
  }
  if (mode === "multimodal2video") {
    const referenceField = scenario === "legacy_multimodal_plural" ? "images" : "image";
    if (!parsed.has(referenceField) && !parsed.has("video") && !parsed.has("audio")) {
      return "missing required multimodal2video flags";
    }
  }
  return null;
}

if (generateCommands.has(command)) {
  if (scenario === "definite_failure") {
    writeOut({ error: "invalid_param", message: "参数不被当前 CLI 接受" });
    process.exit(2);
  }
  if (scenario === "outcome_unknown") {
    process.stderr.write("connection reset after accept\n");
    process.exit(1);
  }
  if (scenario === "delay_submit") {
    const delayMs = Number(process.env.DREAMINA_FAKE_DELAY_MS || 1500);
    const start = Date.now();
    while (Date.now() - start < delayMs) {
      // 阻塞提交临界区，模拟远端尚未返回 submitId。
    }
    writeOut({ submit_id: "sub-delayed", status: "querying" });
    process.exit(0);
  }
  if (scenario === "submit_id") {
    const validationError = validateGenerationArgs(command, rest);
    if (validationError) {
      writeOut({ error: "invalid_param", message: validationError });
      process.exit(2);
    }
    writeOut({ submit_id: "sub-123", status: "querying" });
    process.exit(0);
  }
  if (!["definite_failure", "outcome_unknown", "delay_submit"].includes(scenario)) {
    const validationError = validateGenerationArgs(command, rest);
    if (validationError) {
      writeOut({ error: "invalid_param", message: validationError });
      process.exit(2);
    }
  }
  const downloadDir = rest.find((item) => item.startsWith("--download_dir="))?.slice("--download_dir=".length)
    || process.cwd();
  const fileName = command.includes("video") ? "result.mp4" : "result.png";
  const filePath = path.join(downloadDir, fileName);
  try {
    fs.mkdirSync(downloadDir, { recursive: true });
    fs.writeFileSync(
      filePath,
      command.includes("video")
        ? fs.readFileSync(path.join(__dirname, "minimal-adoptable.mp4"))
        : "fake-image",
    );
  } catch {
    // 目录不可写时仍返回完成合同，由调用方校验文件。
  }
  writeOut({ status: "success", files: [filePath] });
  process.exit(0);
}

process.stderr.write(`unsupported command: ${String(command)}\n`);
process.exit(2);
