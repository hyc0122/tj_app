import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appRoot = path.join(webRoot, "tapcanvas");
const dist = path.join(webRoot, "dist", "tapcanvas");

if (!fs.existsSync(path.join(appRoot, "package.json"))) {
  throw new Error("缺少 web/tapcanvas，无法打包无限画布子应用");
}

function runYarn(args) {
  if (process.platform === "win32") {
    // 中文注释：Windows 通过 cmd.exe 执行静态 yarn.cmd 参数，避免 shell:true 的弃用与注入风险。
    return spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `yarn.cmd ${args.join(" ")}`], {
      cwd: appRoot,
      stdio: "inherit",
    });
  }
  return spawnSync("yarn", args, { cwd: appRoot, stdio: "inherit" });
}

const install = runYarn(["install", "--frozen-lockfile", "--non-interactive"]);
if (install.status !== 0) throw new Error("TapCanvas 依赖安装失败");
const build = runYarn(["vite", "build"]);
if (build.status !== 0) throw new Error("TapCanvas 构建失败");
if (!fs.existsSync(path.join(dist, "index.html"))) {
  throw new Error("TapCanvas 构建未产出 dist/tapcanvas/index.html");
}
