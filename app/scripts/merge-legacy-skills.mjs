/**
 * 将旧版只读 data/skills 树按相对路径合并到当前内置 Skills 基线。
 * 冲突：保留当前天将文件，写入冲突清单，禁止静默覆盖。
 * 用法：node scripts/merge-legacy-skills.mjs <legacySkillsRoot> <builtinRoot> [conflictReport]
 * 注意：不得在源码中硬编码已退役连续旧目录名；legacySkillsRoot 必须由调用方显式传入。
 */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateBuiltinSkillsManifest } from "./generate-builtin-skills-manifest.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fail(message) {
  throw new Error(message);
}

function normalizeRelative(value) {
  return value.split(path.sep).join("/");
}

function walkFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const details = lstatSync(absolute);
      if (details.isSymbolicLink()) {
        fail(`旧 Skills 含符号链接：${normalizeRelative(path.relative(root, absolute))}`);
      }
      if (details.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!details.isFile()) continue;
      files.push({
        absolute,
        relative: normalizeRelative(path.relative(root, absolute)),
        size: details.size,
      });
    }
  };
  visit(root);
  return files.sort((a, b) => a.relative.localeCompare(b.relative, "en"));
}

export function mergeLegacySkills(legacyRootInput, builtinRootInput, options = {}) {
  const legacyRoot = path.resolve(legacyRootInput);
  const builtinRoot = path.resolve(builtinRootInput);
  if (!existsSync(legacyRoot)) fail(`旧 Skills 目录不存在：${legacyRoot}`);
  mkdirSync(builtinRoot, { recursive: true });

  const legacyFiles = walkFiles(legacyRoot);
  const copied = [];
  const conflicts = [];
  const preservedTianjiang = [];

  for (const file of legacyFiles) {
    if (
      file.relative.includes("\0")
      || path.isAbsolute(file.relative)
      || file.relative.split("/").some((s) => s === ".." || s === ".")
    ) {
      fail(`旧 Skills 相对路径非法：${file.relative}`);
    }
    const target = path.join(builtinRoot, ...file.relative.split("/"));
    if (existsSync(target)) {
      const targetStat = lstatSync(target);
      if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
        fail(`目标路径不是普通文件：${file.relative}`);
      }
      // 相对路径冲突：保留当前天将文件。
      conflicts.push({
        path: file.relative,
        action: "keep-current",
        reason: file.relative.startsWith("tianjiang-project-workflow/")
          ? "preserve-tianjiang-project-workflow"
          : "path-conflict-keep-current",
      });
      if (file.relative.startsWith("tianjiang-project-workflow/")) {
        preservedTianjiang.push(file.relative);
      }
      continue;
    }
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(file.absolute, target);
    copied.push(file.relative);
  }

  const manifest = generateBuiltinSkillsManifest(builtinRoot, {
    version: options.manifestVersion ?? 1,
    entryVersion: options.entryVersion ?? "1.0.0",
  });
  const manifestPath = options.manifestPath
    ?? path.resolve(builtinRoot, "..", "builtin-skills-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const report = {
    legacyFileCount: legacyFiles.length,
    copiedCount: copied.length,
    conflictCount: conflicts.length,
    preservedTianjiang,
    conflicts,
    manifestPath,
    manifestFileCount: manifest.files.length,
  };
  if (options.conflictReportPath) {
    writeFileSync(
      options.conflictReportPath,
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
  }
  return report;
}

function main() {
  const legacy = process.argv[2];
  if (!legacy) {
    fail(
      "必须显式传入 legacySkillsRoot（旧版只读 Skills 根目录绝对路径），禁止在源码中写死已退役目录名",
    );
  }
  const builtin = process.argv[3]
    ?? path.resolve(__dirname, "..", "src", "tianjiang", "skills", "builtin");
  const conflictReport = process.argv[4]
    ?? path.resolve(__dirname, "..", "..", ".tmp", "skills-merge-conflicts.json");
  mkdirSync(path.dirname(conflictReport), { recursive: true });
  const report = mergeLegacySkills(legacy, builtin, { conflictReportPath: conflictReport });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
