import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const mainPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "canvas-task-center-electron-main.cjs");

/** 中文注释：启动真实 Electron BrowserWindow，点击长错误并回读已安全处理文本。 */
export async function launchTaskCenterLongErrorWindow() {
  return await new Promise((resolve, reject) => {
    const child = spawn(electronPath, [mainPath], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."),
      env: {
        ...process.env,
        ELECTRON_ENABLE_LOGGING: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: false,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Electron 长错误窗口超时：${stderr}`));
    }, 45_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      try {
        const start = stdout.lastIndexOf("{");
        const payload = JSON.parse(stdout.slice(start));
        if (code !== 0 && !payload.expanded) {
          reject(new Error(`Electron 退出码 ${code}：${stderr}`));
          return;
        }
        resolve(payload);
      } catch (error) {
        reject(new Error(`无法解析 Electron 窗口观测：${stdout}\n${stderr}\n${error}`));
      }
    });
  });
}
