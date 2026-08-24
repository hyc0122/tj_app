import fs from "node:fs";
import path from "node:path";

export interface SharedModelsResolution {
  root: string;
  source: "override" | "packaged" | "source" | "missing";
  diagnostics: string[];
}

const REQUIRED_MODEL_FILES = [
  "all-MiniLM-L6-v2/config.json",
  "all-MiniLM-L6-v2/special_tokens_map.json",
  "all-MiniLM-L6-v2/tokenizer_config.json",
  "all-MiniLM-L6-v2/tokenizer.json",
  "all-MiniLM-L6-v2/vocab.txt",
  "all-MiniLM-L6-v2/onnx/model_fp16.onnx",
] as const;

export function requiredSharedModelRelativePaths(): readonly string[] {
  return REQUIRED_MODEL_FILES;
}

function isSafeDirectory(directory: string): boolean {
  if (!fs.existsSync(directory)) return false;
  const details = fs.lstatSync(directory);
  return details.isDirectory() && !details.isSymbolicLink();
}

function hasRequiredModelFiles(root: string): boolean {
  return REQUIRED_MODEL_FILES.every((relative) => {
    const absolute = path.join(root, ...relative.split("/"));
    if (!fs.existsSync(absolute)) return false;
    const details = fs.lstatSync(absolute);
    return details.isFile() && !details.isSymbolicLink();
  });
}

/**
 * 统一共享模型根目录解析：
 * 1) 合法本机共享 override
 * 2) 打包后 resources/data/models
 * 3) 源码开发目录 app/data/models
 * 4) 都不存在时返回 missing 诊断
 */
export function resolveSharedModelsRoot(options: {
  moduleDir?: string;
  cwd?: string;
  execPath?: string;
  resourcesPath?: string;
  override?: string | null;
} = {}): SharedModelsResolution {
  const diagnostics: string[] = [];
  const moduleDir = options.moduleDir ?? __dirname;
  const cwd = options.cwd ?? process.cwd();
  const override = (options.override ?? process.env.TJ_SHARED_MODELS_ROOT ?? "").trim();

  if (override) {
    const resolved = path.resolve(override);
    if (isSafeDirectory(resolved) && hasRequiredModelFiles(resolved)) {
      return { root: resolved, source: "override", diagnostics };
    }
    diagnostics.push(`共享模型 override 无效或不完整：${resolved}`);
  }

  const packagedCandidates: string[] = [];
  if (options.resourcesPath) {
    packagedCandidates.push(path.resolve(options.resourcesPath, "data", "models"));
  }
  // Electron 打包：process.resourcesPath/data/models
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require("electron") as { app?: { isPackaged?: boolean }; process?: { resourcesPath?: string } };
    const resourcesPath = process.resourcesPath
      || electron?.process?.resourcesPath
      || "";
    if (resourcesPath) {
      packagedCandidates.push(path.resolve(resourcesPath, "data", "models"));
    }
  } catch {
    // 非 Electron 进程忽略。
  }
  // serve 脚本相邻 resources
  packagedCandidates.push(
    path.resolve(moduleDir, "..", "..", "..", "data", "models"),
    path.resolve(path.dirname(options.execPath ?? process.execPath), "resources", "data", "models"),
  );

  for (const candidate of packagedCandidates) {
    if (isSafeDirectory(candidate) && hasRequiredModelFiles(candidate)) {
      return { root: candidate, source: "packaged", diagnostics };
    }
    if (fs.existsSync(candidate)) {
      diagnostics.push(`打包模型目录不完整：${candidate}`);
    }
  }

  const sourceCandidates = [
    path.resolve(cwd, "data", "models"),
    path.resolve(cwd, "app", "data", "models"),
    path.resolve(moduleDir, "..", "..", "..", "data", "models"),
  ];
  for (const candidate of sourceCandidates) {
    if (isSafeDirectory(candidate) && hasRequiredModelFiles(candidate)) {
      return { root: candidate, source: "source", diagnostics };
    }
    if (fs.existsSync(candidate)) {
      diagnostics.push(`源码模型目录不完整：${candidate}`);
    }
  }

  diagnostics.push(
    "未找到完整共享模型种子（需要 all-MiniLM-L6-v2 配置/tokenizer/vocab 与 onnx/model_fp16.onnx）",
  );
  return { root: "", source: "missing", diagnostics };
}

/** 解析失败时抛出含诊断的错误，供 embedding 与文件管理失败关闭。 */
export function requireSharedModelsRoot(
  options?: Parameters<typeof resolveSharedModelsRoot>[0],
): string {
  const resolved = resolveSharedModelsRoot(options);
  if (resolved.source === "missing" || !resolved.root) {
    throw new Error(resolved.diagnostics.join("; ") || "共享模型目录不可用");
  }
  return resolved.root;
}

export function assertSharedModelsIntegrity(root: string): void {
  for (const relative of REQUIRED_MODEL_FILES) {
    const absolute = path.join(root, ...relative.split("/"));
    if (!fs.existsSync(absolute)) {
      throw new Error(`共享模型文件缺失：${relative}`);
    }
    const details = fs.lstatSync(absolute);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new Error(`共享模型文件类型无效：${relative}`);
    }
  }
}
