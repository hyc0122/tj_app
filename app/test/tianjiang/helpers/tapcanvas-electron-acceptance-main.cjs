const fs = require("fs");
const path = require("path");
const origin = String(process.env.TAPCANVAS_ACCEPT_ORIGIN || process.argv[2] || "").replace(/\/$/, "");
const outDir = process.env.TAPCANVAS_ACCEPT_OUT || process.argv[3] || path.resolve(".local/tapcanvas-acceptance");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "boot.txt"), `boot ${new Date().toISOString()} origin=${origin}\n`);

const { app, BrowserWindow } = require("electron");

app.disableHardwareAcceleration();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

app.whenReady().then(async () => {
  fs.appendFileSync(path.join(outDir, "boot.txt"), "ready\n");
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  fs.appendFileSync(path.join(outDir, "boot.txt"), "window\n");
  await win.loadURL(`${origin}/accept`);
  fs.appendFileSync(path.join(outDir, "boot.txt"), "loaded\n");
  const report = await win.webContents.executeJavaScript("window.__tcAccept()", true);
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  // 等待两帧实际绘制；capturePage 在 Windows 首帧可能返回空 NativeImage。
  await win.webContents.executeJavaScript("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))", true);
  let png = Buffer.alloc(0);
  for (let attempt = 0; attempt < 5 && png.length <= 8_000; attempt += 1) {
    png = (await win.webContents.capturePage()).toPNG();
    if (png.length <= 8_000) await sleep(300);
  }
  fs.writeFileSync(path.join(outDir, "window.png"), png);
  const ok = Boolean(report && report.glbStatus === 200 && report.publicStatus === 200 && report.bridgesStatus === 200);
  app.exit(ok ? 0 : 2);
}).catch((error) => {
  fs.appendFileSync(path.join(outDir, "boot.txt"), String(error && error.stack ? error.stack : error) + "\n");
  app.exit(1);
});
