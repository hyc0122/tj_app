import {
  cpSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const MANIFEST_NAME = ".tianjiang-web-package.json";
const require = createRequire(import.meta.url);
const { extractFile, listPackage, statFile } = require("@electron/asar");
const TEXT_SCAN_CHUNK_BYTES = 64 * 1024;
const TEXT_SCAN_OVERLAP_BYTES = 8 * 1024;
const BINARY_SAMPLE_BYTES = 8 * 1024;
const SCANNABLE_TEXT_EXTENSIONS = new Set([
  ".bat",
  ".cjs",
  ".cmd",
  ".conf",
  ".config",
  ".css",
  ".env",
  ".html",
  ".ini",
  ".js",
  ".json",
  ".mjs",
  ".properties",
  ".ps1",
  ".sh",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);
const FIXED_SPAN_SECRET_RULES = [
  {
    id: "PKG_SECRET_PRIVATE_KEY",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
  {
    id: "PKG_SECRET_AWS_ACCESS_KEY",
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    id: "PKG_SECRET_ALIYUN_ACCESS_KEY",
    pattern: /\bLTAI[A-Za-z0-9]{12,30}\b/,
  },
  {
    id: "PKG_SECRET_GITHUB_TOKEN",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  },
];
const ASSIGNED_SECRET_RULE = {
  id: "PKG_SECRET_ASSIGNED_LONG_VALUE",
  pattern:
    /(?:access[_-]?key[_-]?secret|secret[_-]?access[_-]?key|client[_-]?secret|refresh[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9+/_=-]{24,}/i,
};

function fail(message) {
  throw new Error(message);
}

function normalizeRelative(value) {
  return value.split(path.sep).join("/");
}

function resolveControlledPackagePath(packageRoot, relativePathInput, label) {
  if (typeof relativePathInput !== "string" || !relativePathInput.trim()) {
    fail(`${label}必须是非空受控相对路径`);
  }
  const relativePath = relativePathInput.replaceAll("\\", "/");
  const segments = relativePath.split("/");
  if (
    path.posix.isAbsolute(relativePath)
    || path.win32.isAbsolute(relativePath)
    || segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    fail(`${label}必须是无父目录穿越的受控相对路径`);
  }
  const resolved = path.resolve(packageRoot, ...segments);
  const relative = path.relative(packageRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail(`${label}路径越界或指向包根目录`);
  }

  // 逐段使用 lstat，禁止资源目录或可执行文件借符号链接逃逸包根。
  let current = packageRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      fail(`${label}不得包含符号链接：${relativePath}`);
    }
  }
  return { absolutePath: resolved, relativePath };
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

function assertPackagedRegularFile(filePath, label) {
  if (!existsSync(filePath) || !lstatSync(filePath).isFile() || lstatSync(filePath).isSymbolicLink()) {
    fail(`${label}不存在、不是普通文件或是符号链接：${filePath}`);
  }
}

function walkFiles(rootPath) {
  const result = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === MANIFEST_NAME) continue;
      const absolutePath = path.join(directory, entry.name);
      const relativePath = normalizeRelative(path.relative(rootPath, absolutePath));
      const details = lstatSync(absolutePath);
      if (details.isSymbolicLink()) {
        fail(`web 资源禁止使用软链接：${relativePath}`);
      }
      if (details.isDirectory()) {
        visit(absolutePath);
      } else if (details.isFile()) {
        result.push({
          path: relativePath,
          size: details.size,
          sha256: sha256File(absolutePath),
          mtimeMs: details.mtimeMs,
        });
      }
    }
  };
  visit(rootPath);
  return result.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

/**
 * 反向验证 electron-builder 复制到实包的内置 Skills，而不是只检查源码目录。
 */
export function verifyPackagedBuiltinSkills(packageRootInput, options = {}) {
  const packageRoot = path.resolve(packageRootInput);
  const resourcesRelativePath = options.resourcesRelativePath ?? "resources";
  const resourcesRoot = resolveControlledPackagePath(
    packageRoot,
    resourcesRelativePath,
    "Electron resourcesRelativePath",
  ).absolutePath;
  const skillsRoot = path.join(resourcesRoot, "data", "builtin-skills");
  const manifestPath = path.join(
    resourcesRoot,
    "data",
    "builtin-skills-manifest.json",
  );
  assertPackagedRegularFile(manifestPath, "实包内置 Skills 清单");
  if (!existsSync(skillsRoot) || !lstatSync(skillsRoot).isDirectory() || lstatSync(skillsRoot).isSymbolicLink()) {
    fail("实包内置 Skills 根目录不存在或不安全");
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(`实包内置 Skills 清单不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest?.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    fail("实包内置 Skills 清单版本错误或内容为空");
  }

  const realSkillsRoot = realpathSync(skillsRoot);
  const expectedPaths = [];
  const seen = new Set();
  for (const entry of manifest.files) {
    const relativePath = typeof entry?.path === "string" ? normalizeRelative(entry.path) : "";
    if (
      !relativePath
      || relativePath.startsWith("/")
      || relativePath.startsWith("../")
      || relativePath.includes("/../")
      || path.posix.normalize(relativePath) !== relativePath
      || typeof entry.version !== "string"
      || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")
      || seen.has(relativePath)
    ) {
      fail(`实包内置 Skills 清单项无效：${relativePath || "<空路径>"}`);
    }
    seen.add(relativePath);
    expectedPaths.push(relativePath);
    const filePath = path.join(skillsRoot, ...relativePath.split("/"));
    assertPackagedRegularFile(filePath, `实包内置 Skill ${relativePath}`);
    const realFilePath = realpathSync(filePath);
    const realRelative = path.relative(realSkillsRoot, realFilePath);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      fail(`实包内置 Skill 路径越界：${relativePath}`);
    }
    if (sha256File(realFilePath) !== entry.sha256) {
      fail(`实包内置 Skill SHA-256 不一致：${relativePath}`);
    }
  }

  const actualPaths = walkFiles(skillsRoot).map((file) => file.path);
  expectedPaths.sort((left, right) => left.localeCompare(right, "en"));
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    fail("实包内置 Skills 文件树与清单不一致");
  }
  // 清单须含 size 字段时一并校验（兼容旧清单缺 size）。
  for (const entry of manifest.files) {
    if (typeof entry.size === "number") {
      const filePath = path.join(skillsRoot, ...entry.path.split("/"));
      if (statSync(filePath).size !== entry.size) {
        fail(`实包内置 Skill 大小不一致：${entry.path}`);
      }
    }
  }

  return {
    manifestVersion: manifest.version,
    fileCount: expectedPaths.length,
    verifiedSha256Count: expectedPaths.length,
  };
}

const REQUIRED_SHARED_MODEL_FILES = [
  "all-MiniLM-L6-v2/config.json",
  "all-MiniLM-L6-v2/special_tokens_map.json",
  "all-MiniLM-L6-v2/tokenizer_config.json",
  "all-MiniLM-L6-v2/tokenizer.json",
  "all-MiniLM-L6-v2/vocab.txt",
  "all-MiniLM-L6-v2/onnx/model_fp16.onnx",
];

/**
 * 反向验证实包共享模型六件套；禁止 symlink/junction；不得把用户库密钥打进包。
 */
export function verifyPackagedSharedModels(packageRootInput, options = {}) {
  const packageRoot = path.resolve(packageRootInput);
  const resourcesRelativePath = options.resourcesRelativePath ?? "resources";
  const resourcesRoot = resolveControlledPackagePath(
    packageRoot,
    resourcesRelativePath,
    "Electron resourcesRelativePath",
  ).absolutePath;
  const modelsRoot = path.join(resourcesRoot, "data", "models");
  if (!existsSync(modelsRoot) || !lstatSync(modelsRoot).isDirectory() || lstatSync(modelsRoot).isSymbolicLink()) {
    fail("实包共享模型根目录不存在或不安全");
  }
  const verified = [];
  for (const relative of REQUIRED_SHARED_MODEL_FILES) {
    const filePath = path.join(modelsRoot, ...relative.split("/"));
    assertPackagedRegularFile(filePath, `共享模型 ${relative}`);
    verified.push({
      path: relative,
      size: statSync(filePath).size,
      sha256: sha256File(filePath),
    });
  }
  // 禁止用户数据库/密钥误入 models 目录。
  const forbiddenNames = ["db2.sqlite", "inputValues", ".env", "secrets.json"];
  const walkForbidden = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (lstatSync(absolute).isSymbolicLink()) {
        fail(`共享模型目录禁止符号链接：${entry.name}`);
      }
      if (forbiddenNames.includes(entry.name.toLowerCase()) || entry.name.endsWith(".sqlite")) {
        fail(`共享模型目录禁止用户数据或密钥文件：${entry.name}`);
      }
      if (entry.isDirectory()) walkForbidden(absolute);
    }
  };
  walkForbidden(modelsRoot);
  return { fileCount: verified.length, files: verified };
}

function extractRequiredAsarText(asarPath, entryPath, label) {
  try {
    // Windows 大 ASAR 必须把 listPackage 返回的原生分隔符路径原样交回官方 API。
    const listedPath = listPackage(asarPath).find((candidate) => (
      normalizeRelative(candidate).replace(/^\/+/, "") === entryPath
    ));
    if (!listedPath) throw new Error("entry missing");
    const nativeEntryPath = listedPath.replace(/^[/\\]+/, "");
    return extractFile(asarPath, nativeEntryPath, false).toString("utf8");
  } catch {
    fail(`Electron ASAR 缺少或无法读取${label}：${entryPath}`);
  }
}

/** 反向验证实包真正携带 updater 依赖、主进程接线与服务端路由。 */
function collectAstNodes(root, predicate) {
  const matches = [];
  const visit = (node) => {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return matches;
}

function astMemberPath(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (node.kind === ts.SyntaxKind.ThisKeyword) return "this";
  if (ts.isPropertyAccessExpression(node)) {
    const parent = astMemberPath(node.expression);
    return parent ? `${parent}.${node.name.text}` : null;
  }
  return null;
}

function astPropertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  return null;
}

function astPathMatchesImport(pathValue, memberPath) {
  return pathValue === memberPath || pathValue?.endsWith(`.${memberPath}`);
}

function failUpdaterStructure(message) {
  fail(`实包主进程更新结构校验失败：${message}`);
}

function directStatements(node) {
  const statements = node?.statements ? [...node.statements] : [];
  return statements.length === 1 && ts.isBlock(statements[0])
    ? [...statements[0].statements]
    : statements;
}

function directAwaitCall(statement, memberPath) {
  if (!ts.isExpressionStatement(statement) || !ts.isAwaitExpression(statement.expression)) return null;
  const call = statement.expression.expression;
  return ts.isCallExpression(call) && astMemberPath(call.expression) === memberPath ? call : null;
}

function directCall(statement, memberPath) {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return null;
  return astMemberPath(statement.expression.expression) === memberPath ? statement.expression : null;
}

function functionBodyStatements(initializer) {
  return (
    (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
    && ts.isBlock(initializer.body)
  ) ? [...initializer.body.statements] : null;
}

function directThrow(statement) {
  if (ts.isThrowStatement(statement)) return true;
  return ts.isBlock(statement)
    && statement.statements.length === 1
    && ts.isThrowStatement(statement.statements[0]);
}

/**
 * 对编译产物做 fail-closed AST 校验；第三方 electron-updater 可包含自身 quitAndInstall，
 * 这里只审计应用自有 ManualUpdaterService 绑定和主进程装配调用关系。
 */
export function verifyPackagedUpdaterMainStructure(mainSource) {
  const sourceFile = ts.createSourceFile(
    "build/main.js",
    mainSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (sourceFile.parseDiagnostics.length > 0) {
    failUpdaterStructure("JavaScript 解析失败");
  }

  const manualUpdaterClasses = [];
  for (const node of collectAstNodes(sourceFile, (candidate) => (
    ts.isClassDeclaration(candidate) || ts.isVariableDeclaration(candidate)
  ))) {
    if (ts.isClassDeclaration(node) && node.name?.text === "ManualUpdaterService") {
      manualUpdaterClasses.push(node);
    }
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === "ManualUpdaterService"
      && node.initializer
      && ts.isClassExpression(node.initializer)
    ) {
      manualUpdaterClasses.push(node.initializer);
    }
  }
  if (manualUpdaterClasses.length !== 1) {
    failUpdaterStructure("必须存在唯一 ManualUpdaterService 类绑定");
  }
  const manualUpdaterClass = manualUpdaterClasses[0];
  const performActionMethods = manualUpdaterClass.members.filter((member) => (
    ts.isMethodDeclaration(member) && astPropertyName(member.name) === "performAction"
  ));
  if (performActionMethods.length !== 1) {
    failUpdaterStructure("ManualUpdaterService.performAction 缺失或不唯一");
  }
  const performAction = performActionMethods[0];
  const installCases = collectAstNodes(performAction, (node) => (
    ts.isCaseClause(node) && ts.isStringLiteral(node.expression) && node.expression.text === "install"
  ));
  if (installCases.length !== 1) {
    failUpdaterStructure("install 分支缺失或不唯一");
  }
  const installCase = installCases[0];
  const installStatements = directStatements(installCase);
  // 中文注释：install 只接受一条可达的安全主链；唯一 break 必须是退出当前 switch 的末尾语句。
  const trailingBreak = installStatements.at(-1);
  const nestedBreaks = collectAstNodes(installCase, (node) => ts.isBreakStatement(node));
  const abruptEscapes = collectAstNodes(installCase, (node) => (
    ts.isContinueStatement(node) || ts.isReturnStatement(node)
  ));
  if (
    !trailingBreak
    || !ts.isBreakStatement(trailingBreak)
    || nestedBreaks.length !== 1
    || nestedBreaks[0] !== trailingBreak
    || abruptEscapes.length > 0
  ) {
    failUpdaterStructure("install 只允许分支末尾的 switch break，禁止提前 break、continue 或 return");
  }
  if (installStatements.some((statement) => (
    ts.isForStatement(statement)
    || ts.isForInStatement(statement)
    || ts.isForOfStatement(statement)
    || ts.isWhileStatement(statement)
    || ts.isDoStatement(statement)
    || ts.isSwitchStatement(statement)
  ))) {
    failUpdaterStructure("install 安全主链禁止循环或嵌套 switch");
  }
  const candidateDeclarations = [];
  const verifyDeclarations = [];
  for (const [index, statement] of installStatements.entries()) {
    if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
      const declaration = statement.declarationList.declarations[0];
      const initializer = declaration.initializer;
      if (
        ts.isIdentifier(declaration.name)
        && initializer
        && astMemberPath(initializer) === "this.downloadedCandidate"
      ) {
        candidateDeclarations.push({ statement, declaration, index });
      }
      if (
        ts.isIdentifier(declaration.name)
        && initializer
        && ts.isAwaitExpression(initializer)
        && ts.isCallExpression(initializer.expression)
        && astMemberPath(initializer.expression.expression) === "this.deps.verifyDownloadedArtifact"
      ) {
        verifyDeclarations.push({ statement, declaration, call: initializer.expression, index });
      }
    }
  }
  if (candidateDeclarations.length !== 1 || verifyDeclarations.length !== 1) {
    failUpdaterStructure("install 必须唯一绑定下载候选并用它执行二次校验");
  }
  const candidateDeclaration = candidateDeclarations[0];
  const candidateName = candidateDeclaration.declaration.name.text;
  const verifyDeclaration = verifyDeclarations[0];
  const verifiedName = verifyDeclaration.declaration.name.text;
  const verifyArgument = verifyDeclaration.call.arguments[0];
  const expectedVerifyFields = ["filePath", "channel", "size", "sha256"];
  // 中文注释：二次校验与随后 launcher 必须绑定同一个内存候选，禁止拼接或替换任一身份字段。
  const verifyProperties = verifyDeclaration.call.arguments.length === 1
    && verifyArgument
    && ts.isObjectLiteralExpression(verifyArgument)
    ? [...verifyArgument.properties]
    : [];
  const verifyFieldsMatchCandidate = verifyProperties.length === expectedVerifyFields.length
    && expectedVerifyFields.every((field) => verifyProperties.some((property) => (
      ts.isPropertyAssignment(property)
      && astPropertyName(property.name) === field
      && astMemberPath(property.initializer) === `${candidateName}.${field}`
    )));
  if (!verifyFieldsMatchCandidate || candidateDeclaration.index >= verifyDeclaration.index) {
    failUpdaterStructure("install 二次校验的 filePath/channel/size/sha256 必须来自同一下载候选");
  }

  const installerPathDeclarations = collectAstNodes(installCase, (node) => (
    ts.isVariableDeclaration(node)
    && ts.isIdentifier(node.name)
    && Boolean(node.initializer)
    && astMemberPath(node.initializer) === `${candidateName}.filePath`
  ));
  if (installerPathDeclarations.length !== 1) {
    failUpdaterStructure("install launcher 路径必须唯一绑定同一下载候选的 filePath");
  }
  const installerPathDeclaration = installerPathDeclarations[0];
  const installerPathName = installerPathDeclaration.name.text;

  const callNodes = (memberPath) => collectAstNodes(installCase, (node) => (
    ts.isCallExpression(node) && astMemberPath(node.expression) === memberPath
  ));
  const prepareShutdownCalls = callNodes("this.deps.prepareInstallShutdown");
  const legacyFinalizeCalls = callNodes("this.deps.finalizeInstallShutdown");
  const launchCalls = callNodes("this.deps.launchVerifiedInstaller").filter((call) => (
    call.arguments.length === 1
    && ts.isIdentifier(call.arguments[0])
    && call.arguments[0].text === installerPathName
  ));
  const recoveryCalls = callNodes("this.deps.recoverAfterInstallerLaunchFailure");
  const scheduleCalls = callNodes("this.deps.scheduleApplicationQuit");
  const directScheduleCalls = installStatements
    .map((statement) => directCall(statement, "this.deps.scheduleApplicationQuit"))
    .filter(Boolean);
  if (
    prepareShutdownCalls.length !== 1
    || legacyFinalizeCalls.length !== 1
    || launchCalls.length !== 1
    || recoveryCalls.length !== 1
    || scheduleCalls.length !== 1
    || directScheduleCalls.length !== 1
    || directScheduleCalls[0] !== scheduleCalls[0]
  ) {
    failUpdaterStructure("install 必须唯一执行统一关闭、launcher、失败恢复和退出调度");
  }
  const verifyGuards = collectAstNodes(installCase, (node) => {
    if (
      !ts.isIfStatement(node)
      || !ts.isPrefixUnaryExpression(node.expression)
      || node.expression.operator !== ts.SyntaxKind.ExclamationToken
      || !ts.isIdentifier(node.expression.operand)
      || node.expression.operand.text !== verifiedName
    ) return false;
    return collectAstNodes(node.thenStatement, (child) => ts.isThrowStatement(child)).length === 1;
  });
  if (verifyGuards.length !== 1) {
    failUpdaterStructure("install 二次校验失败 guard 必须唯一且抛错终止");
  }

  // 中文注释：launcher 必须是 install 主链直接 try 语句中的直接 await，禁止藏入条件或死分支。
  const launchTryBlocks = installStatements.filter((statement) => {
    if (!ts.isTryStatement(statement) || statement.tryBlock.statements.length !== 1) return false;
    const directLaunch = directAwaitCall(
      statement.tryBlock.statements[0],
      "this.deps.launchVerifiedInstaller",
    );
    return directLaunch === launchCalls[0]
      && directLaunch.arguments.length === 1
      && ts.isIdentifier(directLaunch.arguments[0])
      && directLaunch.arguments[0].text === installerPathName;
  });
  if (launchTryBlocks.length !== 1 || !launchTryBlocks[0].catchClause) {
    failUpdaterStructure("installer launcher 必须由 try/catch 包裹并支持失败恢复");
  }
  const launchCatch = launchTryBlocks[0].catchClause;
  const catchStatements = [...launchCatch.block.statements];
  const catchRecoveryCall = catchStatements.length === 2
    ? directAwaitCall(catchStatements[0], "this.deps.recoverAfterInstallerLaunchFailure")
    : null;
  if (
    catchRecoveryCall !== recoveryCalls[0]
    || !ts.isThrowStatement(catchStatements[1])
  ) {
    failUpdaterStructure("installer 启动失败必须先执行恢复，再重新抛出错误");
  }

  const sourceOrder = [
    candidateDeclaration.declaration.getStart(),
    verifyDeclaration.declaration.getStart(),
    verifyGuards[0].getStart(),
    prepareShutdownCalls[0].getStart(),
    installerPathDeclaration.getStart(),
    launchCalls[0].getStart(),
    scheduleCalls[0].getStart(),
  ];
  if (!sourceOrder.every((value, index) => index === 0 || sourceOrder[index - 1] < value)) {
    failUpdaterStructure("install 必须按候选、二次校验、关闭运行时、launcher、退出调度的顺序执行");
  }

  const legacyFallbacks = collectAstNodes(installCase, (node) => (
    ts.isIfStatement(node)
    && collectAstNodes(node.thenStatement, (child) => child === prepareShutdownCalls[0]).length === 1
    && node.elseStatement !== undefined
    && collectAstNodes(node.elseStatement, (child) => child === legacyFinalizeCalls[0]).length === 1
  ));
  if (legacyFallbacks.length !== 1) {
    failUpdaterStructure("统一安装关闭必须优先，旧 finalize 只能存在于兼容 fallback");
  }
  const unsafeQuitCalls = collectAstNodes(manualUpdaterClass, (node) => (
    ts.isCallExpression(node) && astMemberPath(node.expression)?.endsWith(".quitAndInstall")
  ));
  if (unsafeQuitCalls.length > 0) {
    failUpdaterStructure("应用自有 ManualUpdaterService 禁止调用 quitAndInstall");
  }

  const launcherHelpers = collectAstNodes(sourceFile, (node) => (
    ts.isFunctionDeclaration(node) && node.name?.text === "launchVerifiedInstallerWithShell"
  ));
  if (launcherHelpers.length !== 1) {
    failUpdaterStructure("launchVerifiedInstallerWithShell 缺失或不唯一");
  }
  const launcherHelper = launcherHelpers[0];
  const launcherStatements = launcherHelper.body ? [...launcherHelper.body.statements] : [];
  if (launcherStatements.length !== 2 || launcherStatements.some((statement) => ts.isTryStatement(statement))) {
    failUpdaterStructure("launcher helper 只允许直接 await openPath 与直接错误抛出");
  }
  const awaitedOpenPathDeclarations = launcherStatements
    .map((statement, index) => ({ statement, index }))
    .filter(({ statement }) => {
      if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return false;
      const declaration = statement.declarationList.declarations[0];
      return ts.isIdentifier(declaration.name)
        && declaration.initializer
        && ts.isAwaitExpression(declaration.initializer)
        && ts.isCallExpression(declaration.initializer.expression)
        && astMemberPath(declaration.initializer.expression.expression) === "openPath"
        && declaration.initializer.expression.arguments.length === 1
        && ts.isIdentifier(declaration.initializer.expression.arguments[0])
        && declaration.initializer.expression.arguments[0].text === "filePath";
    });
  if (awaitedOpenPathDeclarations.length !== 1) {
    failUpdaterStructure("launcher helper 必须 await openPath(filePath)");
  }
  const openPathDeclaration = awaitedOpenPathDeclarations[0].statement.declarationList.declarations[0];
  const launchErrorName = openPathDeclaration.name.text;
  const rejectionGuards = launcherStatements
    .map((statement, index) => ({ statement, index }))
    .filter(({ statement }) => {
    if (!ts.isIfStatement(statement) || !ts.isBinaryExpression(statement.expression)) return false;
    const condition = statement.expression;
    const guardsNonEmpty = condition.operatorToken.kind === ts.SyntaxKind.GreaterThanToken
      && astMemberPath(condition.left) === `${launchErrorName}.length`
      && ts.isNumericLiteral(condition.right)
      && condition.right.text === "0";
    return guardsNonEmpty && statement.elseStatement === undefined && directThrow(statement.thenStatement);
  });
  if (
    rejectionGuards.length !== 1
    || awaitedOpenPathDeclarations[0].index >= rejectionGuards[0].index
  ) {
    failUpdaterStructure("launcher helper 必须在 openPath 返回非空错误时抛错");
  }

  const updaterFactoryCalls = collectAstNodes(sourceFile, (node) => (
    ts.isCallExpression(node)
    && astMemberPath(node.expression) === "createDesktopManualUpdater"
    && node.arguments.length >= 1
    && ts.isObjectLiteralExpression(node.arguments[0])
  ));
  const validMainWirings = updaterFactoryCalls.filter((call) => {
    const options = call.arguments[0];
    const property = (name) => options.properties.filter((item) => (
      ts.isPropertyAssignment(item) && astPropertyName(item.name) === name
    ));
    const prepareProperties = property("prepareInstall");
    const prepareShutdownProperties = property("prepareInstallShutdown");
    const launchProperties = property("launchVerifiedInstaller");
    const recoveryProperties = property("recoverAfterInstallerLaunchFailure");
    const legacyFinalizeProperties = property("finalizeInstallShutdown");
    const scheduleProperties = property("scheduleApplicationQuit");
    if ([
      prepareProperties,
      prepareShutdownProperties,
      launchProperties,
      recoveryProperties,
      legacyFinalizeProperties,
      scheduleProperties,
    ].some((matches) => matches.length !== 1)) return false;
    const prepareShutdownStatements = functionBodyStatements(prepareShutdownProperties[0].initializer);
    const launchStatements = functionBodyStatements(launchProperties[0].initializer);
    const recoveryStatements = functionBodyStatements(recoveryProperties[0].initializer);
    const legacyFinalizeStatements = functionBodyStatements(legacyFinalizeProperties[0].initializer);
    const scheduleStatements = functionBodyStatements(scheduleProperties[0].initializer);
    if (
      !prepareShutdownStatements
      || !launchStatements
      || !recoveryStatements
      || !legacyFinalizeStatements
      || !scheduleStatements
    ) return false;
    const awaitedHelpers = launchStatements.filter((statement) => {
      if (!ts.isExpressionStatement(statement) || !ts.isAwaitExpression(statement.expression)) return false;
      const expression = statement.expression.expression;
      return ts.isCallExpression(expression)
      && astMemberPath(expression.expression) === "launchVerifiedInstallerWithShell"
      && expression.arguments.length === 2
      && collectAstNodes(expression.arguments[1], (child) => (
        ts.isCallExpression(child) && astPathMatchesImport(astMemberPath(child.expression), "shell.openPath")
      )).length === 1;
    });
    const detachCall = prepareShutdownStatements.length === 3
      ? directCall(prepareShutdownStatements[0], "detachCurrentServeRequest")
      : null;
    const markCall = prepareShutdownStatements.length === 3
      ? directCall(prepareShutdownStatements[1], "quitIntent.markInstallUpdate")
      : null;
    const closeCall = prepareShutdownStatements.length === 3
      ? directAwaitCall(prepareShutdownStatements[2], "shutdownGate.prepareForInstaller")
      : null;
    const protectionCallback = closeCall?.arguments.length === 1
      ? closeCall.arguments[0]
      : null;
    const protectionStatements = protectionCallback
      ? functionBodyStatements(protectionCallback)
      : null;
    const protectionCall = protectionStatements?.length === 1
      ? directAwaitCall(protectionStatements[0], "protectUserDataBeforeUpdate")
      : null;
    const recoveryRelaunchCalls = collectAstNodes(recoveryProperties[0].initializer, (node) => (
      ts.isCallExpression(node) && astPathMatchesImport(astMemberPath(node.expression), "app.relaunch")
    ));
    const recoveryQuitCalls = collectAstNodes(recoveryProperties[0].initializer, (node) => (
      ts.isCallExpression(node) && astPathMatchesImport(astMemberPath(node.expression), "app.quit")
    ));
    const legacyThrows = collectAstNodes(legacyFinalizeProperties[0].initializer, (node) => ts.isThrowStatement(node));
    const deferredQuits = scheduleStatements.filter((statement) => {
      const immediate = directCall(statement, "setImmediate");
      if (!immediate || immediate.arguments.length !== 1) return false;
      const callback = immediate.arguments[0];
      if (ts.isArrowFunction(callback) && ts.isCallExpression(callback.body)) {
        return astPathMatchesImport(astMemberPath(callback.body.expression), "app.quit");
      }
      const callbackStatements = functionBodyStatements(callback);
      return callbackStatements?.length === 1
        && Boolean(directCall(callbackStatements[0], "app.quit"));
    });
    // 中文注释：关闭、数据保护、launcher 与退出调度都只允许固定的可达直接语句，前置 return/throw 必须失败关闭。
    return launchStatements.length === 1
      && scheduleStatements.length === 1
      && awaitedHelpers.length === 1
      && detachCall?.arguments.length === 0
      && markCall?.arguments.length === 0
      && closeCall?.arguments.length === 1
      && protectionCall?.arguments.length === 1
      && recoveryRelaunchCalls.length === 1
      && recoveryQuitCalls.length === 1
      && legacyThrows.length === 1
      && deferredQuits.length === 1;
  });
  if (validMainWirings.length !== 1) {
    failUpdaterStructure("主进程必须唯一装配统一关闭、数据保护、shell.openPath、失败恢复与 setImmediate app.quit");
  }

  return {
    manualUpdaterInstallOrderVerified: true,
    manualUpdaterQuitAndInstallAbsent: true,
    shellLauncherFailClosedVerified: true,
    mainInstallerWiringVerified: true,
  };
}

export function verifyPackagedUpdaterRuntime(packageRootInput, options = {}) {
  const packageRoot = path.resolve(packageRootInput);
  const resourcesRelativePath = options.resourcesRelativePath ?? "resources";
  const resourcesRoot = resolveControlledPackagePath(
    packageRoot,
    resourcesRelativePath,
    "Electron resourcesRelativePath",
  ).absolutePath;
  const asarPath = path.join(resourcesRoot, "app.asar");
  assertPackagedRegularFile(asarPath, "Electron ASAR");
  const updaterPackageSource = extractRequiredAsarText(
    asarPath,
    "node_modules/electron-updater/package.json",
    " electron-updater 包元数据",
  );
  let updaterPackage;
  try {
    updaterPackage = JSON.parse(updaterPackageSource);
  } catch {
    fail("实包 electron-updater 包元数据不是有效 JSON");
  }
  if (updaterPackage?.version !== "6.8.9") {
    fail(`实包 electron-updater 版本错误：${updaterPackage?.version ?? "<缺失>"}`);
  }

  const mainSource = extractRequiredAsarText(asarPath, "build/main.js", "主进程产物");
  const mainStructure = verifyPackagedUpdaterMainStructure(mainSource);

  const serverPath = path.join(resourcesRoot, "data", "serve", "app.js");
  assertPackagedRegularFile(serverPath, "实包 App 服务产物");
  const serverSource = readFileSync(serverPath, "utf8");
  for (const marker of [
    "bindManualUpdateService",
    "/api/setting/about/checkUpdate",
    "/api/setting/about/downloadApp",
    "download-differential",
    "download-full",
  ]) {
    if (!serverSource.includes(marker)) fail(`实包 App 服务缺少更新路由：${marker}`);
  }

  const updateConfigPath = path.join(resourcesRoot, "app-update.yml");
  assertPackagedRegularFile(updateConfigPath, "实包更新源配置");
  const updateConfig = readFileSync(updateConfigPath, "utf8");
  const feedURL = parsePackagedUpdateFeedURL(updateConfig);
  return {
    dependency: `electron-updater@${updaterPackage.version}`,
    mainStructure,
    serverMarkersVerified: 5,
    generatedFeedConfigVerified: true,
    feedURL,
  };
}

/**
 * 校验 electron-builder 写入实包的真实 feed，而不是只检查源码 publish 配置。
 * native metadata 必须位于规格冻结的 desktop/{channel}/windows/x64 目录。
 */
export function parsePackagedUpdateFeedURL(updateConfig) {
  if (!/^provider:\s*generic\s*$/m.test(updateConfig)) {
    fail("实包更新源配置必须使用 generic provider");
  }
  const match = /^url:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(updateConfig);
  if (!match) fail("实包更新源配置缺少 HTTPS URL");
  let parsed;
  try {
    parsed = new URL(match[1].trim());
  } catch {
    fail("实包更新源 URL 无效");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    fail("实包更新源必须是无凭据、无查询的 HTTPS URL");
  }
  const pathname = parsed.pathname.replace(/\/+$/, "");
  if (
    !/^\/desktop\/(?:stable|beta)\/(?:windows\/x64|macos\/(?:x64|arm64)|linux\/(?:x64|arm64))$/
      .test(pathname)
  ) {
    fail("实包更新源必须位于 desktop/{stable|beta}/{platform}/{arch} 发布目录");
  }
  parsed.pathname = pathname;
  return parsed.toString();
}

function extractLocalReferences(html) {
  const references = new Set();
  const attributePattern = /\b(?:src|href)\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
  const referenceTags = new Set(["script", "link", "img", "source", "video", "audio"]);

  const findTagEnd = (start) => {
    let quote = "";
    for (let index = start; index < html.length; index += 1) {
      const char = html[index];
      if (quote) {
        if (char === quote) quote = "";
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === ">") {
        return index;
      }
    }
    return -1;
  };

  let cursor = 0;
  while (cursor < html.length) {
    const tagStart = html.indexOf("<", cursor);
    if (tagStart < 0) break;
    if (html.startsWith("<!--", tagStart)) {
      const commentEnd = html.indexOf("-->", tagStart + 4);
      cursor = commentEnd < 0 ? html.length : commentEnd + 3;
      continue;
    }
    const tagEnd = findTagEnd(tagStart + 1);
    if (tagEnd < 0) break;
    const tag = html.slice(tagStart, tagEnd + 1);
    const nameMatch = /^<\s*(\/?)\s*([a-zA-Z0-9-]+)/.exec(tag);
    if (!nameMatch) {
      cursor = tagEnd + 1;
      continue;
    }
    const closing = nameMatch[1] === "/";
    const tagName = nameMatch[2].toLowerCase();
    if (!closing && referenceTags.has(tagName)) {
      for (const match of tag.matchAll(attributePattern)) {
        const value = (match[1] ?? match[2] ?? "").trim();
        if (!value || value.startsWith("#") || /^(?:data|blob|https?):/i.test(value)) continue;
        const clean = value.split(/[?#]/, 1)[0];
        if (clean) references.add(clean);
      }
    }
    if (!closing && (tagName === "script" || tagName === "style")) {
      // Vite 单文件构建会内联大量源码，必须整体跳过其文本内容。
      const closePattern = new RegExp(`</\\s*${tagName}\\s*>`, "ig");
      closePattern.lastIndex = tagEnd + 1;
      const closeMatch = closePattern.exec(html);
      cursor = closeMatch ? closePattern.lastIndex : html.length;
    } else {
      cursor = tagEnd + 1;
    }
  }
  return [...references];
}

export function validateWebRoot(webRootInput) {
  const webRoot = path.resolve(webRootInput);
  const indexPath = path.join(webRoot, "index.html");
  if (!existsSync(indexPath) || !statSync(indexPath).isFile()) {
    fail(`web 资源缺少运行时必需的 index.html：${indexPath}`);
  }
  const html = readFileSync(indexPath, "utf8");
  if (!html.trim()) fail("web/index.html 为空");

  for (const reference of extractLocalReferences(html)) {
    if (reference.startsWith("/") || /^[A-Za-z]:[\\/]/.test(reference) || reference.startsWith("\\\\")) {
      fail(`Vite 静态资源必须使用相对路径，发现：${reference}`);
    }
    const resolved = path.resolve(webRoot, reference);
    const relative = path.relative(webRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      fail(`静态资源路径越界：${reference}`);
    }
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      fail(`index.html 引用的静态资源不存在：${reference}`);
    }
  }

  const files = walkFiles(webRoot);
  if (files.length === 0) fail("web 资源目录为空");
  return { webRoot, files };
}

function treeHash(files) {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(`${file.path}\0${file.size}\0${file.sha256}\n`, "utf8");
  }
  return hash.digest("hex");
}

function safeReplaceDirectory(sourceInput, targetInput) {
  const source = path.resolve(sourceInput);
  const target = path.resolve(targetInput);
  const parsed = path.parse(target);
  if (target === parsed.root || source === target) {
    fail(`拒绝清理不安全的目标目录：${target}`);
  }
  const relative = path.relative(target, source);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    fail(`复制源不能位于待清理目标内：${source}`);
  }
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(source, target, { recursive: true, force: true, errorOnExist: false });
}

export function syncWeb(sourceInput, targetInput) {
  const source = path.resolve(sourceInput);
  const target = path.resolve(targetInput);
  const sourceState = validateWebRoot(source);
  const generatedAtMs = Date.now();
  safeReplaceDirectory(source, target);

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date(generatedAtMs).toISOString(),
    generatedAtMs,
    sourceRootName: path.basename(source),
    sourceMaxMtimeMs: Math.max(...sourceState.files.map((file) => file.mtimeMs)),
    sourceTreeSha256: treeHash(sourceState.files),
    sourceFiles: sourceState.files.map(({ path: filePath, size, sha256 }) => ({
      path: filePath,
      size,
      sha256,
    })),
  };
  writeFileSync(path.join(target, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  verifySync(source, target);
  return manifest;
}

function readManifest(target) {
  const manifestPath = path.join(target, MANIFEST_NAME);
  if (!existsSync(manifestPath)) fail(`同步清单不存在：${manifestPath}`);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(`同步清单不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.sourceFiles)) {
    fail("同步清单结构无效");
  }
  return manifest;
}

function comparableFiles(files) {
  return files.map(({ path: filePath, size, sha256 }) => ({ path: filePath, size, sha256 }));
}

export function verifySync(sourceInput, targetInput) {
  const source = path.resolve(sourceInput);
  const target = path.resolve(targetInput);
  const sourceState = validateWebRoot(source);
  const targetState = validateWebRoot(target);
  const manifest = readManifest(target);

  const sourceMaxMtimeMs = Math.max(...sourceState.files.map((file) => file.mtimeMs));
  if (sourceMaxMtimeMs > Number(manifest.generatedAtMs) + 1) {
    fail("业务前端源文件时间晚于同步清单，Electron web 属于旧产物");
  }
  const sourceTreeSha256 = treeHash(sourceState.files);
  if (sourceTreeSha256 !== manifest.sourceTreeSha256) {
    fail("业务前端 dist SHA 摘要与同步清单不一致");
  }
  if (JSON.stringify(comparableFiles(sourceState.files)) !== JSON.stringify(manifest.sourceFiles)) {
    fail("业务前端 dist 文件清单与同步清单不一致");
  }
  if (JSON.stringify(comparableFiles(targetState.files)) !== JSON.stringify(manifest.sourceFiles)) {
    fail("Electron data/web SHA 或文件清单与业务前端不一致");
  }
  return manifest;
}

function pathRule(relativePath, isDirectory = false) {
  const normalized = `/${normalizeRelative(relativePath).replace(/^\/+|\/+$/g, "").toLowerCase()}`;
  const name = path.posix.basename(normalized);
  if (/^(?:db2|profile|project)\.sqlite(?:-(?:wal|shm|journal))?$/.test(name)) {
    return "PKG_PATH_SQLITE";
  }
  if (/^\.env(?:\..*)?$/.test(name)) return "PKG_PATH_ENV";
  if (/\.(?:pem|key|p12|pfx)$/.test(name) || /^(?:id_rsa|id_ed25519)$/.test(name)) {
    return "PKG_PATH_PRIVATE_KEY";
  }
  if (/\.log$/.test(name)) return "PKG_PATH_LOG";
  if (
    /\/(?:credentials|userdata|user-data)(?:\/|$)/.test(normalized) ||
    /\/data\/(?:users|projects|sync)(?:\/|$)/.test(normalized) ||
    /\/recovery(?:\/|$)/.test(normalized) ||
    /\/logs(?:\/|$)/.test(normalized)
  ) {
    return "PKG_PATH_USER_DATA";
  }
  if (isDirectory && ["credentials", "userdata", "user-data", "recovery", "logs"].includes(name)) {
    return "PKG_PATH_USER_DATA";
  }
  return "";
}

function isScannableText(relativePath) {
  const lowerName = path.posix.basename(normalizeRelative(relativePath)).toLowerCase();
  if (["dockerfile", "makefile"].includes(lowerName)) return true;
  return SCANNABLE_TEXT_EXTENSIONS.has(path.posix.extname(lowerName));
}

function createTextScanAudit() {
  return {
    scannedFiles: 0,
    scannedTextBytes: 0,
    largestFile: { path: "", bytes: 0 },
  };
}

function recordTextScan(audit, relativePath, bytes) {
  audit.scannedFiles += 1;
  audit.scannedTextBytes += bytes;
  if (bytes > audit.largestFile.bytes) {
    audit.largestFile = { path: relativePath, bytes };
  }
}

function scanTextWindow(relativePath, bytes, findings, matchedRules, rules, encoding = "utf8") {
  const text = bytes.toString(encoding);
  for (const rule of rules) {
    if (!matchedRules.has(rule.id) && rule.pattern.test(text)) {
      findings.push({ rule: rule.id, path: relativePath });
      matchedRules.add(rule.id);
    }
  }
}

function createTextChunkScanner(relativePath, findings) {
  const matchedRules = new Set();
  let rawCarry = Buffer.alloc(0);
  let normalizedCarry = "";
  let inWhitespace = false;
  let invalidUtf8 = false;
  const decoder = new TextDecoder("utf-8", { fatal: true });

  const markInvalidUtf8 = () => {
    if (!invalidUtf8) {
      findings.push({ rule: "PKG_TEXT_INVALID_UTF8", path: relativePath });
      invalidUtf8 = true;
    }
  };

  const scanNormalizedText = (decoded) => {
    if (!decoded) return;
    // 必须与 JavaScript `\s` 保持同一 Unicode 语义，并跨块合并连续空白。
    let normalized = decoded.replace(/\s+/gu, " ");
    const startsWithWhitespace = /^\s/u.test(decoded);
    const endsWithWhitespace = /\s$/u.test(decoded);
    if (inWhitespace && startsWithWhitespace) normalized = normalized.slice(1);
    inWhitespace = endsWithWhitespace;

    const normalizedWindow = normalizedCarry + normalized;
    if (
      !matchedRules.has(ASSIGNED_SECRET_RULE.id)
      && ASSIGNED_SECRET_RULE.pattern.test(normalizedWindow)
    ) {
      findings.push({ rule: ASSIGNED_SECRET_RULE.id, path: relativePath });
      matchedRules.add(ASSIGNED_SECRET_RULE.id);
    }
    normalizedCarry = normalizedWindow.slice(-TEXT_SCAN_OVERLAP_BYTES);
  };

  return {
    write(chunk) {
      const rawWindow = rawCarry.length > 0 ? Buffer.concat([rawCarry, chunk]) : chunk;
      scanTextWindow(
        relativePath,
        rawWindow,
        findings,
        matchedRules,
        FIXED_SPAN_SECRET_RULES,
      );
      rawCarry = rawWindow.subarray(Math.max(0, rawWindow.length - TEXT_SCAN_OVERLAP_BYTES));

      // fatal 流式解码器会保留块尾不完整码点；非法 UTF-8 一律失败关闭。
      if (invalidUtf8) return;
      try {
        scanNormalizedText(decoder.decode(chunk, { stream: true }));
      } catch {
        markInvalidUtf8();
      }
    },
    finish() {
      if (invalidUtf8) return;
      try {
        scanNormalizedText(decoder.decode());
      } catch {
        markInvalidUtf8();
      }
    },
  };
}

function scanTextBuffer(relativePath, bytes, findings, audit) {
  if (!isScannableText(relativePath)) return;
  // 含 NUL 的内容视为二进制，避免把压缩或原生模块误当成文本。
  if (bytes.subarray(0, Math.min(bytes.length, BINARY_SAMPLE_BYTES)).includes(0)) return;
  const scanner = createTextChunkScanner(relativePath, findings);
  for (let offset = 0; offset < bytes.length; offset += TEXT_SCAN_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + TEXT_SCAN_CHUNK_BYTES));
    scanner.write(chunk);
  }
  scanner.finish();
  recordTextScan(audit, relativePath, bytes.length);
}

async function scanTextFile(relativePath, absolutePath, findings, audit) {
  if (!isScannableText(relativePath)) return;
  const scanner = createTextChunkScanner(relativePath, findings);
  const pending = [];
  let pendingBytes = 0;
  let scannedBytes = 0;
  let binaryDecisionMade = false;

  const processChunk = (chunk) => {
    scannedBytes += chunk.length;
    scanner.write(chunk);
  };

  // 解包文件必须通过流读取；前 8 KiB 判定文本后再扫描，避免一次性载入超大文件。
  for await (const chunk of createReadStream(absolutePath, {
    highWaterMark: TEXT_SCAN_CHUNK_BYTES,
  })) {
    if (!binaryDecisionMade) {
      pending.push(chunk);
      pendingBytes += chunk.length;
      if (pendingBytes < BINARY_SAMPLE_BYTES) continue;
      const prefix = Buffer.concat(pending, pendingBytes);
      if (prefix.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) return;
      binaryDecisionMade = true;
      processChunk(prefix);
      pending.length = 0;
      continue;
    }
    processChunk(chunk);
  }

  if (!binaryDecisionMade) {
    const prefix = Buffer.concat(pending, pendingBytes);
    if (prefix.includes(0)) return;
    processChunk(prefix);
  }
  scanner.finish();
  recordTextScan(audit, relativePath, scannedBytes);
}

async function inspectUnpackedPackage(packageRoot, audit) {
  const findings = [];
  const realPackageRoot = realpathSync(packageRoot);
  const visit = async (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = normalizeRelative(path.relative(packageRoot, absolutePath));
      if (lstatSync(absolutePath).isSymbolicLink()) {
        let realTarget;
        try {
          realTarget = realpathSync(absolutePath);
        } catch {
          findings.push({ rule: "PKG_PATH_SYMLINK_INVALID", path: relativePath });
          continue;
        }
        const targetRelative = path.relative(realPackageRoot, realTarget);
        if (
          targetRelative === ".."
          || targetRelative.startsWith(`..${path.sep}`)
          || path.isAbsolute(targetRelative)
        ) {
          findings.push({ rule: "PKG_PATH_SYMLINK_ESCAPE", path: relativePath });
        }
        // macOS framework 的 Current 等包内链接是正常结构；不沿链接递归以避免环路。
        continue;
      }
      const rule = pathRule(relativePath, entry.isDirectory());
      if (rule) {
        findings.push({ rule, path: relativePath });
        continue;
      }
      if (entry.isDirectory()) await visit(absolutePath);
      else if (entry.isFile() && entry.name !== "app.asar") {
        await scanTextFile(relativePath, absolutePath, findings, audit);
      }
    }
  };
  await visit(packageRoot);
  return findings;
}

function inspectAsar(asarPath, relativeAsarPath, audit) {
  const findings = [];
  let entries;
  try {
    entries = listPackage(asarPath);
  } catch {
    fail(`Electron ASAR 无法解析：${relativeAsarPath}`);
  }
  for (const listedPath of entries) {
    // 官方 API 在 Windows 大包中要求使用原始反斜杠路径；仅展示和规则匹配使用 `/`。
    const nativeEntryPath = listedPath.replace(/^[/\\]+/, "");
    const entryPath = normalizeRelative(nativeEntryPath);
    if (!entryPath || entryPath.startsWith("../") || path.posix.isAbsolute(entryPath)) {
      findings.push({ rule: "PKG_PATH_ASAR_ESCAPE", path: `${relativeAsarPath}!/${entryPath}` });
      continue;
    }
    let details;
    try {
      details = statFile(asarPath, nativeEntryPath, false);
    } catch {
      findings.push({ rule: "PKG_PATH_ASAR_INVALID", path: `${relativeAsarPath}!/${entryPath}` });
      continue;
    }
    const displayPath = `${relativeAsarPath}!/${entryPath}`;
    const isDirectory = Object.hasOwn(details, "files");
    const rule = pathRule(entryPath, isDirectory);
    if (rule) {
      findings.push({ rule, path: displayPath });
      continue;
    }
    if (Object.hasOwn(details, "link")) {
      findings.push({ rule: "PKG_PATH_ASAR_LINK", path: displayPath });
      continue;
    }
    if (!isDirectory && isScannableText(entryPath)) {
      try {
        // ASAR 官方 API 返回 Buffer；按固定块和重叠窗口扫描，任何大小都不得跳过。
        scanTextBuffer(
          displayPath,
          extractFile(asarPath, nativeEntryPath, false),
          findings,
          audit,
        );
      } catch {
        findings.push({ rule: "PKG_PATH_ASAR_INVALID", path: displayPath });
      }
    }
  }
  return findings;
}

function formatFindings(findings) {
  return findings
    .sort((left, right) => `${left.rule}:${left.path}`.localeCompare(`${right.rule}:${right.path}`, "en"))
    .map((finding) => `${finding.rule}:${finding.path}`)
    .join(", ");
}

export async function verifyPackage(packageRootInput, sourceInput, options = {}) {
  const packageRoot = path.resolve(packageRootInput);
  if (
    !existsSync(packageRoot)
    || !lstatSync(packageRoot).isDirectory()
    || lstatSync(packageRoot).isSymbolicLink()
  ) {
    fail(`Electron 解包目录不存在：${packageRoot}`);
  }
  const resourcesRelativePath = options.resourcesRelativePath ?? "resources";
  const executableRelativePath = options.executableRelativePath ?? "天将漫创.exe";
  const resourcesLayout = resolveControlledPackagePath(
    packageRoot,
    resourcesRelativePath,
    "Electron resourcesRelativePath",
  );
  const executableLayout = resolveControlledPackagePath(
    packageRoot,
    executableRelativePath,
    "Electron executableRelativePath",
  );
  const resourcesRoot = resourcesLayout.absolutePath;
  const executable = executableLayout.absolutePath;
  const packagedWeb = path.join(resourcesRoot, "data", "web");
  const manifest = verifySync(sourceInput, packagedWeb);
  const asarPath = path.join(resourcesRoot, "app.asar");
  const audit = createTextScanAudit();
  const forbidden = [
    ...await inspectUnpackedPackage(packageRoot, audit),
    ...inspectAsar(
      asarPath,
      `${normalizeRelative(resourcesLayout.relativePath)}/app.asar`,
      audit,
    ),
  ];
  if (forbidden.length > 0) {
    // 只输出规则编号和相对路径，禁止把命中的敏感内容写入日志。
    fail(`Electron 包安全门禁失败：${formatFindings(forbidden)}`);
  }
  const builtinSkills = verifyPackagedBuiltinSkills(packageRoot, { resourcesRelativePath });
  const sharedModels = verifyPackagedSharedModels(packageRoot, { resourcesRelativePath });
  const updaterRuntime = verifyPackagedUpdaterRuntime(packageRoot, { resourcesRelativePath });
  const requiredFiles = [
    path.join(resourcesRoot, "data", "serve", "app.js"),
    asarPath,
    executable,
  ];
  for (const requiredFile of requiredFiles) {
    if (
      !existsSync(requiredFile)
      || !lstatSync(requiredFile).isFile()
      || lstatSync(requiredFile).isSymbolicLink()
    ) {
      fail(`Electron 包缺少同轮必需文件：${requiredFile}`);
    }
    if (statSync(requiredFile).mtimeMs + 2_000 < Number(manifest.generatedAtMs)) {
      fail(`Electron 包含早于本轮 web 清单的旧产物：${requiredFile}`);
    }
  }

  return {
    executable,
    manifest,
    audit,
    builtinSkills,
    sharedModels,
    updaterRuntime,
  };
}

function usage() {
  return "用法：package-web-assets.mjs validate-web <webRoot> | sync-web <source> <target> | verify-sync <source> <target> | verify-package <packageRoot> <source>";
}

async function main(argv) {
  const [command, first, second] = argv;
  let result;
  if (!command || !first) fail(usage());
  if (command === "validate-web") {
    validateWebRoot(first);
  } else if (command === "sync-web" && second) {
    syncWeb(first, second);
  } else if (command === "verify-sync" && second) {
    verifySync(first, second);
  } else if (command === "verify-package" && second) {
    result = await verifyPackage(first, second);
  } else {
    fail(usage());
  }
  if (result?.audit) {
    const largest = result.audit.largestFile;
    process.stdout.write(
      `[package-web] 文本扫描审计 files=${result.audit.scannedFiles} bytes=${result.audit.scannedTextBytes} largest=${largest.path}:${largest.bytes}\n`,
    );
  }
  process.stdout.write(`[package-web] ${command} 通过\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`[package-web] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
