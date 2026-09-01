const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

app.disableHardwareAcceleration();

const origin = String(process.env.TAPCANVAS_VISUAL_ORIGIN || "").replace(/\/$/, "");
const outDir = process.env.TAPCANVAS_VISUAL_OUT || path.resolve(".local/tapcanvas-visual");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function capture(win, name) {
  const file = path.join(outDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let buffer = Buffer.alloc(0);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const image = await win.webContents.capturePage();
    buffer = image.toPNG();
    if (buffer.length > 8000) break;
    await sleep(500);
  }
  fs.writeFileSync(file, buffer);
  return file;
}

async function waitFor(win, expression, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const ok = await win.webContents.executeJavaScript(expression, true);
      if (ok) return true;
    } catch {
      // 页面仍在导航。
    }
    await sleep(250);
  }
  return false;
}

async function dismissFeatureTour(win) {
  // 中文注释：只操作产品真实的新手引导按钮，不向页面注入替代界面。
  await win.webContents.executeJavaScript(`
    (() => {
      const skip = document.querySelector('button.feature-tour-skip');
      if (skip instanceof HTMLElement) skip.click();
      return true;
    })()
  `, true);
  return waitFor(win, `!document.querySelector('.feature-tour')`, 10000);
}

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: true,
    backgroundColor: "#1a1b1e",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      offscreen: false,
    },
  });
  win.webContents.on("console-message", (_event, level, message) => {
    process.stderr.write(`[console:${level}] ${message}\n`);
  });

  await win.loadURL(`${origin}/tapcanvas/?tianjiangVisualAcceptance=1`);
  await waitFor(win, `Boolean(document.querySelector('.canvas-hub-page, .canvas-hub-idea, .tc-portal-shell'))`, 40000);
  await dismissFeatureTour(win);
  await sleep(2000);
  const homeProbe = await win.webContents.executeJavaScript(`({
    title: document.title,
    text: (document.body.innerText || '').slice(0, 400),
    html: document.documentElement.outerHTML.slice(0, 500),
  })`, true).catch(() => ({}));
  const home = await capture(win, "01-home.png");

  await win.webContents.executeJavaScript(`
    localStorage.setItem('tap_user', JSON.stringify({sub:'visual-user',login:'tianjiang',name:'天将视觉验收'}));
    document.cookie = 'tap_session_present=1; Path=/';
  `, true).catch(() => undefined);

  await win.loadURL(`${origin}/tapcanvas/studio?projectId=empty-canvas&tianjiangVisualAcceptance=1`);
  await waitFor(win, `Boolean(document.querySelector('.react-flow, .mantine-AppShell-root, [class*="app-shell"], .github-gate'))`, 50000);
  await dismissFeatureTour(win);
  await sleep(8000);
  const emptyCanvas = await capture(win, "02-empty-canvas.png");

  await win.loadURL(`${origin}/tapcanvas/studio?projectId=nodes-canvas&tianjiangVisualAcceptance=1`);
  await waitFor(win, `Boolean(document.querySelector('.react-flow, .mantine-AppShell-root, [class*="app-shell"], .github-gate'))`, 50000);
  await dismissFeatureTour(win);
  await sleep(8000);
  const nodesCanvas = await capture(win, "03-nodes-canvas.png");

  const chatOpened = await win.webContents.executeJavaScript(`
    (async () => {
      if (!window.__tjVisual?.openChat) throw new Error('missing real visual chat hook');
      await window.__tjVisual.openChat();
      // 中文注释：兼容本轮验收所用的旧编译夹具；调用的仍是产品真实展开入口。
      window.__tcExpandChat?.();
      return true;
    })()
  `, true);
  if (!chatOpened || !await waitFor(win, `Boolean(document.querySelector('.tc-ai-chat--expanded'))`, 10000)) {
    throw new Error('真实 AI 对话框未打开');
  }
  await sleep(2000);
  const ai = await capture(win, "04-right-ai.png");
  const confirmOpened = await win.webContents.executeJavaScript(`
    (() => {
      if (!window.__tjVisual?.openConfirm) throw new Error('missing real visual confirm hook');
      void window.__tjVisual.openConfirm();
      return true;
    })()
  `, true);
  if (!confirmOpened || !await waitFor(win, `Boolean(document.querySelector('[data-tapcanvas-confirm]'))`, 10000)) {
    throw new Error('真实收费确认框未打开');
  }
  await sleep(400);
  const confirm = await capture(win, "05-paid-confirm.png");

  const hasConfirm = await win.webContents.executeJavaScript(
    `Boolean(document.querySelector('[data-tapcanvas-confirm]'))`,
    true,
  );
  process.stdout.write(JSON.stringify({
    windowType: "BrowserWindow",
    origin,
    homeProbe,
    screenshots: { home, emptyCanvas, nodesCanvas, ai, confirm },
    hasConfirm,
  }));
  app.quit();
}).catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error));
  app.exit(1);
});
