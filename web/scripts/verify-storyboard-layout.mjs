import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import * as sass from "sass";

const webRoot = path.resolve(import.meta.dirname, "..");
const evidenceRoot = path.resolve(
  process.env.STORYBOARD_LAYOUT_PROBE_DIR
    ?? path.join(webRoot, ".local", "storyboard-layout-probe"),
);

const browserCandidates = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

const browserPath = browserCandidates.find((candidate) => existsSync(candidate));
if (!browserPath) {
  throw new Error("未找到可用于分镜布局验收的 Chromium 浏览器；可通过 CHROME_PATH 指定");
}

await mkdir(evidenceRoot, { recursive: true });

const mainCss = sass.compile(path.join(webRoot, "src", "assets", "main.scss"), {
  style: "expanded",
}).css;
const storyboardCss = sass.compile(
  path.join(webRoot, "src", "views", "storyboardProject", "styles", "storyboard-workspace.scss"),
  { style: "expanded" },
).css;

const fixturePath = path.join(evidenceRoot, "storyboard-layout-probe.html");
const fixture = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>${mainCss}\n${storyboardCss}</style>
  <style>
    html, body { margin: 0; min-width: 0; width: 100%; height: 100%; }
    /* 复刻真实 Electron + workbench 壳层的尺寸合同，防止子页用 100dvh 越过父级可用区。 */
    .probe-titlebar { height: 42px; }
    .probe-workbench { display: flex; overflow: hidden; width: 100vw; height: calc(100vh - 32px); padding: 16px; }
    .probe-menu { flex: 0 0 168px; width: 168px; }
    .probe-view { flex: 1; overflow: auto; min-width: 0; margin-left: 16px; padding: 0 32px; }
    .probe-topbar { height: 50px; }
    .probe-viewbox { width: 100%; height: calc(100% - 6vh); }
    @media (max-width: 760px) {
      .probe-menu { flex-basis: 64px; width: 64px; }
      .probe-view { margin-left: 8px; padding: 0 8px; }
    }
  </style>
</head>
<body>
  <header class="probe-titlebar">天将漫创</header>
  <div class="probe-workbench">
    <nav class="probe-menu">项目导航</nav>
    <section class="probe-view">
      <header class="probe-topbar">当前项目</header>
      <div class="probe-viewbox">
        <main class="storyboard-workspace" data-layout="storyboard-product-workspace">
    <header class="storyboardHero">
      <div class="storyboardHero__identity">
        <span class="storyboardHero__mark">镜</span>
        <div class="storyboardHero__copy">
          <div class="storyboardHero__eyebrow">STORYBOARD WORKSPACE</div>
          <h1>分镜生产工作台</h1>
          <p>验证真实 Chromium 视口中的主操作可达性。</p>
          <div class="storyboardHero__actions"><button>导入分镜</button><button>导出项目</button></div>
        </div>
      </div>
      <div class="storyboardHero__summaries">
        <article><span>分镜总数</span><strong>1</strong><small>1 个分镜</small></article>
        <article><span>预计时长</span><strong>5秒</strong><small>当前累计</small></article>
        <article><span>资产模式</span><strong>独立</strong><small>可编辑</small></article>
      </div>
    </header>
    <nav class="storyboardModules">
      <button class="module-interactive--sm active">分镜管理</button>
      <button class="module-interactive--sm">资产管理</button>
      <button class="module-interactive--sm">分镜设置</button>
    </nav>
    <section class="storyboardModulePanel storyboardModulePanel--shots">
      <div class="storyboardToolbar">
        <div class="storyboardToolbar__title"><strong>连续分镜</strong><span>生产工具栏</span></div>
        <label class="storyboardSearch"><input type="search" placeholder="搜索脚本或画面描述" /></label>
        <div class="storyboardToolbar__actions"><button class="t-button">刷新</button><button class="t-button">新增分镜</button></div>
      </div>
      <div class="storyboardSplit">
        <section class="storyboardShotList">
          <header class="shotListHeader"><div><span>镜头序列</span><strong>1 SHOTS</strong></div></header>
          <div class="shotTableScroll">
            <table><thead><tr><th>镜头</th><th>脚本与画面</th><th>操作</th></tr></thead><tbody><tr><td>01</td><td>雨夜，林夏走进旧剧院。</td><td><button>插入</button></td></tr></tbody></table>
          </div>
        </section>
        <aside class="storyboardDetail">
          <header class="detailHeader"><div><span class="detailHeader__eyebrow">SHOT DETAIL</span><h2>镜头 01</h2><p>编辑当前镜头</p></div><span class="detailHeader__duration">5s</span></header>
          <div class="detailScroll"><section class="detailSection">
            <label class="fieldGroup"><span>脚本原文</span><textarea rows="8">长内容用于验证详情内部滚动。</textarea></label>
            <label class="fieldGroup"><span>画面描述</span><textarea rows="8">画面描述。</textarea></label>
            <label class="fieldGroup"><span>视频提示词</span><textarea rows="8">生成提示词。</textarea></label>
          </section></div>
          <footer class="detailFooter"><button class="t-button" data-action="save-shot">保存分镜</button></footer>
        </aside>
      </div>
    </section>
        </main>
      </div>
    </section>
  </div>
</body>
</html>`;
await writeFile(fixturePath, fixture, "utf8");

// 每次运行使用独立 profile，避免旧 DevToolsActivePort 让连续 Gate 误连已退出进程。
const userDataDir = path.join(evidenceRoot, `chromium-profile-${process.pid}-${Date.now()}`);
await mkdir(userDataDir, { recursive: true });
const browser = spawn(browserPath, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--remote-debugging-port=0",
  `--user-data-dir=${userDataDir}`,
  "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForDebugPort() {
  const activePortPath = path.join(userDataDir, "DevToolsActivePort");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const [port] = (await readFile(activePortPath, "utf8")).trim().split(/\r?\n/);
      if (port) return Number(port);
    } catch {
      // 浏览器启动期间文件尚未生成，继续短轮询。
    }
    await delay(50);
  }
  throw new Error("Chromium 调试端口启动超时");
}

async function createCdpClient(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });

  return {
    send(method, params = {}) {
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
    },
  };
}

async function probeViewport(port, width, height) {
  const target = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent("about:blank")}`, {
    method: "PUT",
  }).then((response) => response.json());
  const cdp = await createCdpClient(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send("Page.navigate", { url: pathToFileURL(fixturePath).href });

  let ready = false;
  for (let attempt = 0; attempt < 100 && !ready; attempt += 1) {
    const result = await cdp.send("Runtime.evaluate", {
      expression: "document.readyState === 'complete'",
      returnByValue: true,
    });
    ready = Boolean(result.result.value);
    if (!ready) await delay(25);
  }
  if (!ready) throw new Error(`${width}×${height} 布局夹具加载超时`);

  const evaluation = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const root = document.documentElement;
      const view = document.querySelector(".probe-view");
      const viewBox = document.querySelector(".probe-viewbox");
      const workspace = document.querySelector(".storyboard-workspace");
      const split = document.querySelector(".storyboardSplit");
      const footer = document.querySelector(".detailFooter");
      const viewBoxRect = viewBox.getBoundingClientRect();
      const workspaceRect = workspace.getBoundingClientRect();
      const footerRect = footer.getBoundingClientRect();
      const splitRect = split.getBoundingClientRect();
      return {
        innerWidth,
        innerHeight,
        documentClientWidth: root.clientWidth,
        documentScrollWidth: root.scrollWidth,
        viewClientWidth: view.clientWidth,
        viewScrollWidth: view.scrollWidth,
        viewBoxClientWidth: viewBox.clientWidth,
        viewBoxClientHeight: viewBox.clientHeight,
        workspaceClientWidth: workspace.clientWidth,
        workspaceScrollWidth: workspace.scrollWidth,
        workspaceClientHeight: workspace.clientHeight,
        workspaceScrollHeight: workspace.scrollHeight,
        workspaceTop: workspaceRect.top,
        workspaceBottom: workspaceRect.bottom,
        viewBoxTop: viewBoxRect.top,
        viewBoxBottom: viewBoxRect.bottom,
        splitClientWidth: split.clientWidth,
        splitScrollWidth: split.scrollWidth,
        splitColumnCount: getComputedStyle(split).gridTemplateColumns.split(/\\s+/).filter(Boolean).length,
        splitTop: splitRect.top,
        splitBottom: splitRect.bottom,
        footerTop: footerRect.top,
        footerBottom: footerRect.bottom,
        footerVisible: footerRect.bottom <= innerHeight + 0.5,
      };
    })()`,
    returnByValue: true,
  });
  cdp.close();
  return evaluation.result.value;
}

let exitCode = 0;
try {
  const port = await waitForDebugPort();
  const wide = await probeViewport(port, 1920, 1080);
  const desktop = await probeViewport(port, 1366, 768);
  const narrow = await probeViewport(port, 360, 800);
  const thresholdCandidates = [];
  for (let width = 1440; width <= 1460; width += 1) {
    const candidate = await probeViewport(port, width, 900);
    thresholdCandidates.push(candidate);
    if (candidate.splitClientWidth >= 1120) break;
  }
  const firstSafeDouble = thresholdCandidates.at(-1);
  const report = { browserPath, wide, desktop, narrow, thresholdCandidates };
  await writeFile(path.join(evidenceRoot, "layout-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));

  const failures = [];
  if (wide.workspaceBottom > wide.viewBoxBottom + 0.5 || !wide.footerVisible) {
    failures.push(`1920×1080 子页未继承父工作区高度：workspaceBottom=${wide.workspaceBottom}, viewBoxBottom=${wide.viewBoxBottom}, footerVisible=${wide.footerVisible}`);
  }
  if (wide.splitColumnCount !== 2) {
    failures.push(`1920×1080 宽工作区必须保持双栏，实际轨道数=${wide.splitColumnCount}`);
  }
  if (desktop.workspaceBottom > desktop.viewBoxBottom + 0.5) {
    failures.push(`1366×768 子页越过父工作区：workspaceBottom=${desktop.workspaceBottom}, viewBoxBottom=${desktop.viewBoxBottom}`);
  }
  if (desktop.splitColumnCount !== 1) {
    failures.push(`1366×768 真实内容宽度不足时必须单栏，实际轨道数=${desktop.splitColumnCount}`);
  }
  if (desktop.splitScrollWidth > desktop.splitClientWidth + 1) {
    failures.push(`1366×768 分镜主区被水平裁剪：scrollWidth=${desktop.splitScrollWidth}, clientWidth=${desktop.splitClientWidth}`);
  }
  const unsafeDouble = thresholdCandidates.find((candidate) => (
    candidate.splitClientWidth < 1120 && candidate.splitColumnCount === 2
  ));
  if (unsafeDouble) {
    failures.push(`${unsafeDouble.innerWidth}px 壳内主区仅 ${unsafeDouble.splitClientWidth}px 时不得启用 1120px 双栏`);
  }
  if (!firstSafeDouble || firstSafeDouble.splitClientWidth < 1120 || firstSafeDouble.splitColumnCount !== 2) {
    failures.push(`未在实测安全宽度启用双栏：${JSON.stringify(firstSafeDouble)}`);
  }
  if (narrow.documentScrollWidth > narrow.innerWidth + 1) {
    failures.push(`360px 页面横向溢出：scrollWidth=${narrow.documentScrollWidth}, viewport=${narrow.innerWidth}`);
  }
  if (narrow.workspaceScrollWidth > narrow.workspaceClientWidth + 1) {
    failures.push(`360px 工作台横向溢出：scrollWidth=${narrow.workspaceScrollWidth}, clientWidth=${narrow.workspaceClientWidth}`);
  }
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    exitCode = 1;
  }
} finally {
  browser.kill();
  if (browser.exitCode === null) {
    await Promise.race([
      new Promise((resolve) => browser.once("exit", resolve)),
      delay(2_000),
    ]);
  }
}

process.exitCode = exitCode;
