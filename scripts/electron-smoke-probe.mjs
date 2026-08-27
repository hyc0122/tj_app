import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function assertRendererObservation(observation) {
  if (!observation || typeof observation !== "object") {
    throw new Error("renderer 观测结果无效");
  }
  if (observation.readyState !== "complete") {
    throw new Error(`renderer DOM 加载未完成：${observation.readyState ?? "unknown"}`);
  }
  if (
    String(observation.location ?? "").startsWith("chrome-error://") ||
    /ERR_[A-Z_]+|This site can.t be reached|无法访问|找不到文件/i.test(
      `${observation.errorText ?? ""}\n${observation.bodyText ?? ""}`,
    )
  ) {
    throw new Error("renderer 进入 Chromium 错误页");
  }
  const bodyText = String(observation.bodyText ?? "").trim();
  if (!bodyText) throw new Error("renderer 页面为空白");
  if (/Network Error|网络连接失败|本地服务连接中断/.test(bodyText)) {
    throw new Error("renderer 显示网络错误提示");
  }
  if (!bodyText.includes("天将漫创") && !String(observation.title ?? "").includes("天将漫创")) {
    throw new Error("renderer 未显示天将漫创品牌");
  }
  if (Number(observation.loginFormCount) < 1) {
    throw new Error("renderer 未渲染登录表单");
  }
}

export function assertStartupFailureObservation(observation) {
  if (!observation || typeof observation !== "object") {
    throw new Error("启动诊断页观测结果无效");
  }
  const bodyText = String(observation.bodyText ?? "");
  const webDiagnostic =
    Number(observation.startupErrorCount) >= 1
    && bodyText.includes("本地服务启动失败");
  const builtInDiagnostic = bodyText.includes("客户端启动资源失败");
  const hasDiagnosticCode = /诊断代码[\s：:]+[A-Z][A-Z0-9_]+/.test(bodyText);
  if (
    observation.readyState !== "complete"
    || (!webDiagnostic && !builtInDiagnostic)
    || !hasDiagnosticCode
    || /Network Error|请.*下载.*VC\+\+|以管理员身份运行/i.test(bodyText)
  ) {
    throw new Error("renderer 未显示合格的启动诊断页");
  }
}

export function assertAcceptanceNavigationObservation(observation, expectedUserData) {
  if (!observation || typeof observation !== "object") {
    throw new Error("验收页面观测结果无效");
  }
  if (!String(observation.login?.location ?? "").includes("#/login")
      || Number(observation.login?.loginFormCount) < 1) {
    throw new Error("CDP 未真实观察登录页");
  }
  if (!String(observation.project?.location ?? "").includes("#/project")
      || Number(observation.project?.projectPageCount) < 1
      || Number(observation.project?.acceptanceProjectCount) < 1) {
    throw new Error("CDP 未真实导航并观察项目页");
  }
  if (!String(observation.settings?.location ?? "").includes("#/settings")
      || Number(observation.settings?.settingsPageCount) < 1) {
    throw new Error("CDP 未真实导航并观察设置页");
  }
  if (Number(observation.update?.aboutPageCount) < 1
      || Number(observation.update?.checkUpdateButtonCount) < 1) {
    throw new Error("CDP 未真实打开并观察更新页");
  }
  if (observation.runtime?.acceptanceMode !== true) {
    throw new Error("候选运行时未处于受控验收模式");
  }
  if (observation.runtime?.trayReady !== true) {
    throw new Error("候选运行时托盘对象未创建");
  }
  if (
    path.win32.resolve(String(observation.runtime?.userData ?? "")).toLowerCase()
    !== path.win32.resolve(expectedUserData).toLowerCase()
  ) {
    throw new Error("候选运行时 userData 与共享验收 profile 不一致");
  }
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]?.replace(/^--/, "");
    if (!name || argv[index + 1] === undefined) throw new Error("启动探针参数不完整");
    result[name] = argv[index + 1];
  }
  return result;
}

async function waitForTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const target = targets.find(
          (item) => item.type === "page" && item.webSocketDebuggerUrl,
        );
        if (target) return target;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `等待 Electron CDP 窗口超时${lastError instanceof Error ? `：${lastError.message}` : ""}`,
  );
}

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
  }

  async open() {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("连接 Electron CDP 超时")), 10_000);
      this.socket.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      this.socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("连接 Electron CDP 失败"));
      }, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "renderer 表达式执行失败");
  }
  return result.result?.value;
}

async function waitForRenderer(
  client,
  timeoutMs,
  assertion = assertRendererObservation,
) {
  const deadline = Date.now() + timeoutMs;
  let observation;
  while (Date.now() < deadline) {
    observation = await evaluate(
      client,
      `(() => {
        const bodyText = document.body?.innerText ?? "";
        return {
          readyState: document.readyState,
          title: document.title,
          bodyText,
          location: location.href,
          loginFormCount: document.querySelectorAll(".login-form").length,
          startupErrorCount: document.querySelectorAll(".startup-error-card").length,
          errorText: bodyText.match(/ERR_[A-Z_]+/)?.[0] ?? ""
        };
      })()`,
    );
    try {
      assertion(observation);
      return observation;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  assertion(observation);
}

async function waitForObservation(client, timeoutMs, expression, assertion) {
  const deadline = Date.now() + timeoutMs;
  let observation;
  let lastError;
  while (Date.now() < deadline) {
    observation = await evaluate(client, expression);
    try {
      assertion(observation);
      return observation;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (lastError) throw lastError;
  throw new Error("等待 CDP 页面观测超时");
}

function parseStartupStatusDocument(observation) {
  if (observation?.readyState !== "complete") {
    throw new Error("结构化启动状态页面尚未加载完成");
  }
  let data;
  try {
    data = JSON.parse(String(observation.bodyText ?? ""));
  } catch {
    throw new Error("结构化启动状态不是有效 JSON");
  }
  if (data?.ok !== false || data?.state !== "failed" || typeof data?.code !== "string") {
    throw new Error("主进程未返回结构化启动失败状态");
  }
  return data;
}

/**
 * data: 故障页不能跨域 Fetch 自定义协议；CDP 先保留截图，再直接导航读取主进程状态。
 */
export async function readStartupStatusViaNavigation(client, timeoutMs) {
  const navigation = await client.send("Page.navigate", {
    url: "tianjiang://getStartupStatus",
  });
  if (navigation?.errorText) {
    throw new Error(`导航结构化启动状态失败：${navigation.errorText}`);
  }
  const observation = await waitForObservation(
    client,
    timeoutMs,
    `({
      readyState: document.readyState,
      bodyText: document.body?.innerText ?? ""
    })`,
    parseStartupStatusDocument,
  );
  return {
    source: "protocol-navigation",
    data: parseStartupStatusDocument(observation),
  };
}

async function runAcceptanceNavigationProbe(client, target, options, timeoutMs) {
  const expectedUserData = path.resolve(options["expected-user-data"] ?? "");
  if (!options["expected-user-data"] || !path.isAbsolute(expectedUserData)) {
    throw new Error("验收导航探针缺少绝对 expected-user-data");
  }
  const login = await waitForRenderer(client, timeoutMs, assertRendererObservation);
  await waitForObservation(
    client,
    timeoutMs,
    `(() => ({
      usernameReady: document.querySelector('input[autocomplete="username"]') instanceof HTMLInputElement,
      passwordReady: document.querySelector('input[autocomplete="current-password"]') instanceof HTMLInputElement,
      buttonReady: document.querySelector('.loginBtn') instanceof HTMLElement
        && !document.querySelector('.loginBtn').hasAttribute('disabled')
    }))()`,
    (value) => {
      if (!value?.usernameReady || !value?.passwordReady || !value?.buttonReady) {
        throw new Error("等待登录表单可交互超时");
      }
    },
  );
  await evaluate(client, `(() => {
    const username = document.querySelector('input[autocomplete="username"]');
    const password = document.querySelector('input[autocomplete="current-password"]');
    const button = document.querySelector('.loginBtn');
    if (!(username instanceof HTMLInputElement)
        || !(password instanceof HTMLInputElement)
        || !(button instanceof HTMLElement)) {
      throw new Error('登录表单结构无效');
    }
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setValue.call(username, 'acceptance-user');
    username.dispatchEvent(new Event('input', { bubbles: true }));
    setValue.call(password, 'non-secret-acceptance-password');
    password.dispatchEvent(new Event('input', { bubbles: true }));
    button.click();
    return true;
  })()`);

  const project = await waitForObservation(
    client,
    timeoutMs,
    `(() => ({
      location: location.href,
      projectPageCount: document.querySelectorAll('.project').length,
      acceptanceProjectCount: Array.from(document.querySelectorAll('[data-testid="cloud-project-card"] .card-name'))
        .filter((item) => item.textContent?.trim() === '升级验收项目').length
    }))()`,
    (value) => {
      if (!String(value?.location ?? "").includes("#/project")
          || Number(value?.projectPageCount) < 1
          || Number(value?.acceptanceProjectCount) < 1) {
        throw new Error("等待项目页与验收项目超时");
      }
    },
  );

  // 直接改变 hash 仍经过真实 Vue Router 导航守卫和中央会话检查。
  await evaluate(client, `(() => { location.hash = '#/settings'; return true; })()`);
  const settings = await waitForObservation(
    client,
    timeoutMs,
    `(() => ({
      location: location.href,
      settingsPageCount: document.querySelectorAll('.settings-page').length
    }))()`,
    (value) => {
      if (!String(value?.location ?? "").includes("#/settings")
          || Number(value?.settingsPageCount) < 1) {
        throw new Error("等待设置页超时");
      }
    },
  );

  await waitForObservation(
    client,
    timeoutMs,
    `(() => {
      const item = Array.from(document.querySelectorAll('.settingMenu .t-menu__item'))
        .find((entry) => /检查更新|关于|Check.*Update|About/i.test(entry.textContent ?? ''));
      if (!item) return { clicked: false };
      item.click();
      return { clicked: true };
    })()`,
    (value) => {
      if (value?.clicked !== true) throw new Error("设置页未找到关于/更新入口");
    },
  );
  const update = await waitForObservation(
    client,
    timeoutMs,
    `(() => ({
      aboutPageCount: document.querySelectorAll('.about').length,
      checkUpdateButtonCount: Array.from(document.querySelectorAll('.about button'))
        .filter((button) => /检查更新|Check.*Update/i.test(button.textContent ?? '')).length
    }))()`,
    (value) => {
      if (Number(value?.aboutPageCount) < 1 || Number(value?.checkUpdateButtonCount) < 1) {
        throw new Error("等待更新页超时");
      }
    },
  );
  const runtime = await evaluate(
    client,
    `fetch('tianjiang://getAcceptanceState').then((response) => response.json())`,
  );
  const observation = {
    checkedAt: new Date().toISOString(),
    mode: "acceptance-navigation",
    target: { title: target.title, type: target.type },
    login,
    project,
    settings,
    update,
    runtime,
  };
  assertAcceptanceNavigationObservation(observation, expectedUserData);

  const screenshot = await client.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  if (!screenshot?.data) throw new Error("Electron 更新页截图失败");
  const screenshotPath = path.resolve(options.screenshot);
  mkdirSync(path.dirname(screenshotPath), { recursive: true });
  writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
  observation.screenshotPath = screenshotPath;
  if (options.output) {
    const outputPath = path.resolve(options.output);
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(observation, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(observation)}\n`);
  return observation;
}

async function runProbe(options) {
  const port = Number(options.port);
  const timeoutMs = Number(options["timeout-ms"] ?? 45_000);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("CDP 端口无效");
  }
  const target = await waitForTarget(port, timeoutMs);
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.open();
  try {
    await client.send("Runtime.enable");
    await client.send("Page.enable");
    if (options.mode === "acceptance-navigation") {
      return await runAcceptanceNavigationProbe(client, target, options, timeoutMs);
    }
    if (options.mode === "close") {
      // 标题栏关闭在托盘可用时只隐藏窗口；烟测必须调用显式退出协议进入 ShutdownGate。
      await evaluate(client, `fetch("tianjiang://appQuit").then(() => true)`);
      process.stdout.write('{"closedThroughApplicationGate":true}\n');
      return { closedThroughApplicationGate: true };
    }
    const startupFailureMode = options.mode === "startup-failure";
    const renderer = await waitForRenderer(
      client,
      timeoutMs,
      startupFailureMode
        ? assertStartupFailureObservation
        : assertRendererObservation,
    );
    // 导航读取启动状态会替换故障页，因此必须先保存用户实际看到的页面截图。
    const screenshot = await client.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    if (!screenshot?.data) throw new Error("Electron 页面截图失败");
    const screenshotPath = path.resolve(options.screenshot);
    mkdirSync(path.dirname(screenshotPath), { recursive: true });
    writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));

    let localService;
    let startupStatus;
    if (startupFailureMode) {
      startupStatus = await readStartupStatusViaNavigation(client, timeoutMs);
    } else {
      const serviceInfo = await evaluate(
        client,
        `fetch("tianjiang://getAppUrl").then(async (response) => ({
          ok: response.ok,
          status: response.status,
          data: await response.json()
        }))`,
      );
      const serviceUrlMatch = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/api$/.exec(
        serviceInfo?.data?.url ?? "",
      );
      if (
        !serviceInfo?.ok
        || !serviceUrlMatch
        || Number(serviceUrlMatch[1]) > 65_535
      ) {
        throw new Error("无法从真实主进程取得本地服务地址");
      }
      const serviceRoot = serviceInfo.data.url.replace(/\/api$/, "/");
      const serviceResponse = await fetch(serviceRoot);
      const serviceHtml = await serviceResponse.text();
      if (!serviceResponse.ok || !serviceHtml.trim() || !serviceHtml.includes("天将漫创")) {
        throw new Error("Electron 本地服务未返回完整天将漫创页面");
      }
      localService = {
        status: serviceResponse.status,
        htmlBytes: Buffer.byteLength(serviceHtml),
      };
    }

    const evidence = {
      checkedAt: new Date().toISOString(),
      target: {
        title: target.title,
        type: target.type,
      },
      renderer,
      ...(localService ? { localService } : {}),
      ...(startupStatus ? { startupStatus } : {}),
      screenshotPath,
    };
    if (options.output) {
      const outputPath = path.resolve(options.output);
      mkdirSync(path.dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    }
    process.stdout.write(`${JSON.stringify(evidence)}\n`);

    if (options.close !== "false") {
      // 通过应用自身的安全退出门关闭，确保同步协调器得到退出通知。
      // 标题栏关闭在托盘可用时只隐藏窗口；烟测必须调用显式退出协议进入 ShutdownGate。
      await evaluate(client, `fetch("tianjiang://appQuit").then(() => true)`);
    }
    return evidence;
  } finally {
    client.close();
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runProbe(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`[electron-smoke] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
