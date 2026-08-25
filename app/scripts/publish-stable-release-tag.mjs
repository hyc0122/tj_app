import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultAppRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const stableSemver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * Stable Tag 只能由 package.json 的正式版版本号派生。
 */
export function deriveStableReleaseTag(packageVersion) {
  if (typeof packageVersion !== "string" || !stableSemver.test(packageVersion)) {
    throw new Error("package.json.version 必须是严格的 Stable X.Y.Z 版本");
  }
  return `v${packageVersion}`;
}

function executeGit(argumentsList, repositoryRoot) {
  try {
    return execFileSync("git", argumentsList, {
      cwd: repositoryRoot,
      encoding: "utf8",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = String(error?.stderr ?? "").trim().split(/\r?\n/)[0];
    throw new Error(`Git 命令失败：git ${argumentsList.join(" ")}：${stderr || error.message}`);
  }
}

function parseRemoteTagTarget(output, tag) {
  const peeledReference = `refs/tags/${tag}^{}`;
  for (const line of output.trim().split(/\r?\n/)) {
    if (!line) continue;
    const [commit, reference] = line.split(/\s+/, 2);
    if (reference === peeledReference) return commit;
  }
  return "";
}

/**
 * 在干净的 public main 上创建并推送注解 Stable Tag。
 * 失败时保留本地证据，不自动删除或改写任何 Tag。
 */
export function publishStableReleaseTag({
  appRoot = defaultAppRoot,
  argv = [],
  runGit,
} = {}) {
  if (argv.length !== 0) {
    throw new Error("Stable Tag 命令不接受版本参数；版本只读取 package.json");
  }

  const repositoryRoot = path.resolve(appRoot, "..");
  const packageDocument = JSON.parse(
    readFileSync(path.join(appRoot, "package.json"), "utf8"),
  );
  const version = packageDocument.version;
  const tag = deriveStableReleaseTag(version);
  const git = runGit ?? ((argumentsList) => executeGit(argumentsList, repositoryRoot));
  const invoke = (argumentsList) => String(git(argumentsList, {
    cwd: repositoryRoot,
  }) ?? "").trim();

  if (invoke(["status", "--porcelain=v1"]) !== "") {
    throw new Error("创建发布 Tag 前工作树必须干净");
  }
  if (invoke(["branch", "--show-current"]) !== "main") {
    throw new Error("创建 Stable Tag 时必须位于 main 分支");
  }

  invoke(["fetch", "origin", "main", "--tags"]);
  const commit = invoke(["rev-parse", "HEAD"]);
  const remoteMain = invoke(["rev-parse", "origin/main"]);
  if (!commit || commit !== remoteMain) {
    throw new Error("本地 main HEAD 必须与 origin/main 完全一致");
  }
  if (invoke(["tag", "--list", tag]) !== "") {
    throw new Error(`本地 Tag 已存在，禁止改写：${tag}`);
  }

  const tagReferences = [
    `refs/tags/${tag}`,
    `refs/tags/${tag}^{}`,
  ];
  if (invoke(["ls-remote", "--tags", "origin", ...tagReferences]) !== "") {
    throw new Error(`远端 Tag 已存在，禁止改写：${tag}`);
  }

  invoke([
    "tag",
    "-a",
    tag,
    "HEAD",
    "-m",
    `Stable release ${tag}: Tianjiang desktop client`,
  ]);
  invoke(["push", "origin", tag]);

  const publishedReferences = invoke([
    "ls-remote",
    "--tags",
    "origin",
    ...tagReferences,
  ]);
  if (parseRemoteTagTarget(publishedReferences, tag) !== commit) {
    throw new Error(`远端注解 Tag 未指向预期 main 提交：${tag}`);
  }
  return { version, tag, commit };
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  try {
    const evidence = publishStableReleaseTag({ argv: process.argv.slice(2) });
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
  } catch (error) {
    process.stderr.write(
      `[Stable Tag 发布] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
