const { app, BrowserWindow } = require("electron");
const path = require("node:path");

const fixture = path.join(__dirname, "canvas-task-center-error-fixture.html");

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 900,
    height: 640,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await win.loadFile(fixture);
  await win.webContents.executeJavaScript(`document.querySelector(".reasonText").click()`);
  const observed = await win.webContents.executeJavaScript(`({
    expanded: document.querySelector(".reasonDialog").classList.contains("is-open"),
    expandedText: document.querySelector(".reasonDialogContent").textContent,
  })`);
  process.stdout.write(JSON.stringify({
    windowType: "BrowserWindow",
    expanded: observed.expanded,
    expandedText: observed.expandedText,
  }));
  app.quit();
}).catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error));
  app.exit(1);
});
