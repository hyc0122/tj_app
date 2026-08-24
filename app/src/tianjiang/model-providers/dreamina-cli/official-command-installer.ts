import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const OFFICIAL_DREAMINA_INSTALL_COMMAND = "curl -s https://jimeng.jianying.com/cli | bash";

const INSTALL_TIMEOUT_MS = 180_000;
const OUTPUT_LIMIT = 64 * 1024;

interface OfficialInstallRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface OfficialInstallTestBinding {
  bashPath: string;
  runner: (input: {
    executablePath: string;
    args: readonly string[];
  }) => Promise<OfficialInstallRunResult>;
}

let testBinding: OfficialInstallTestBinding | undefined;

export function bindOfficialDreaminaInstallTest(input?: OfficialInstallTestBinding): void {
  testBinding = input;
}

function findBashInPath(): string | null {
  const names = process.platform === "win32" ? ["bash.exe", "bash"] : ["bash"];
  for (const directory of String(process.env.PATH ?? "").split(path.delimiter)) {
    const trimmed = directory.trim();
    if (!trimmed) continue;
    for (const name of names) {
      const candidate = path.resolve(trimmed, name);
      try {
        const stat = fs.lstatSync(candidate);
        if (stat.isFile() && !stat.isSymbolicLink()) return candidate;
      } catch {
        // 中文注释：PATH 中不存在的候选直接跳过，不扫描目录树或猜测安装位置。
      }
    }
  }
  return null;
}

function runOfficialInstall(executablePath: string, args: readonly string[]): Promise<OfficialInstallRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const append = (current: string, chunk: Buffer): string => (
      `${current}${chunk.toString("utf8")}`.slice(0, OUTPUT_LIMIT)
    );
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, INSTALL_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut });
    });
  });
}

export async function installDreaminaWithOfficialCommand(input: {
  confirm: true;
}): Promise<{ ok: boolean; command: string; reason?: string }> {
  if (input.confirm !== true) {
    return { ok: false, command: OFFICIAL_DREAMINA_INSTALL_COMMAND, reason: "必须由用户明确确认后安装" };
  }
  const bashPath = testBinding?.bashPath ?? findBashInPath();
  if (!bashPath) {
    return {
      ok: false,
      command: OFFICIAL_DREAMINA_INSTALL_COMMAND,
      reason: "未检测到 bash / Git Bash，无法执行官方安装命令。请先安装 Git for Windows，或手动运行 curl -s https://jimeng.jianying.com/cli | bash",
    };
  }

  try {
    // 中文注释：严格复用参考项目的固定官方命令，不接受前端 URL 或任意命令参数。
    const result = await (testBinding?.runner ?? ((request) => runOfficialInstall(
      request.executablePath,
      request.args,
    )))({
      executablePath: bashPath,
      args: ["-lc", OFFICIAL_DREAMINA_INSTALL_COMMAND],
    });
    if (result.timedOut) {
      return { ok: false, command: OFFICIAL_DREAMINA_INSTALL_COMMAND, reason: "官方安装命令超时" };
    }
    if (result.exitCode !== 0) {
      return {
        ok: false,
        command: OFFICIAL_DREAMINA_INSTALL_COMMAND,
        reason: `官方安装命令执行失败（退出码 ${result.exitCode ?? "unknown"}）`,
      };
    }
    return { ok: true, command: OFFICIAL_DREAMINA_INSTALL_COMMAND };
  } catch {
    return { ok: false, command: OFFICIAL_DREAMINA_INSTALL_COMMAND, reason: "官方安装命令无法启动" };
  }
}
