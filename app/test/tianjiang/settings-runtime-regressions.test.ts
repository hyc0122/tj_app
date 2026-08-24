import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  hashFileSha256,
  installMissingBuiltinSkills,
  loadBuiltinSkillsManifest,
} from "../../src/tianjiang/skills/builtin-skill-installer";
import { currentAccountSkillsRoot } from "../../src/tianjiang/skills/account-skills";
import { runWithUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import {
  activateUserDatabase,
  destroyAllDatabaseHandles,
  stopGenerationTaskRecovery,
} from "../../src/utils/db";
import { validateFields } from "../../src/middleware/middleware";
import { z } from "zod";

test("任务 API 走账号级聚合且投影 projectUuid/projectName", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "src/routes/task/getTaskApi.ts"),
    "utf8",
  );
  assert.match(source, /taskCenterList/);
  assert.match(source, /projectUuid/);
  assert.doesNotMatch(source, /leftJoin\("o_project"/);
  assert.doesNotMatch(source, /select\("o_tasks\.\*",\s*"o_project\.\*"/);
});

test("字段校验必须把 Zod 规范化结果交给路由处理器", () => {
  const request = { body: { projectId: "12" } } as any;
  const response = {} as any;
  let nextCalls = 0;
  validateFields({ projectId: z.coerce.number().int().positive() })(
    request,
    response,
    () => { nextCalls += 1; },
  );
  assert.equal(nextCalls, 1);
  assert.equal(request.body.projectId, 12);
});

test("任务筛选优先 projectUuid，空值表示不筛选，非法 UUID 拒绝", async () => {
  const taskRoute = await import("../../src/routes/task/getTaskApi");
  const schema = (taskRoute as any).taskListRequestSchema;
  assert.equal(typeof schema?.parse, "function");
  const uuid = "11111111-1111-4111-a111-111111111111";
  assert.equal(schema.parse({ projectUuid: uuid }).projectUuid, uuid);
  assert.equal(schema.parse({ projectUuid: "" }).projectUuid, null);
  assert.equal(schema.parse({ projectId: "12" }).projectId, 12);
  assert.equal(schema.parse({ projectId: "" }).projectId, null);
  assert.throws(() => schema.parse({ projectUuid: "not-a-uuid" }));
  assert.throws(() => schema.parse({ projectId: "0" }));
});

test("内置 Skills 只补缺失不覆盖用户文件", async () => {
  const root = path.join(process.cwd(), "..", ".tmp", `skills-${Date.now()}`);
  const builtin = path.join(root, "builtin");
  const target = path.join(root, "target");
  fs.mkdirSync(path.join(builtin, "demo"), { recursive: true });
  fs.writeFileSync(path.join(builtin, "demo", "a.md"), "builtin");
  fs.mkdirSync(path.join(target, "demo"), { recursive: true });
  fs.writeFileSync(path.join(target, "demo", "a.md"), "user-edit");
  fs.writeFileSync(path.join(builtin, "demo", "b.md"), "new");
  const result = await installMissingBuiltinSkills({
    builtinRoot: builtin,
    targetRoot: target,
    manifest: {
      version: 1,
      files: [
        { path: "demo/a.md", version: "1", sha256: hashFileSha256(path.join(builtin, "demo", "a.md")) },
        { path: "demo/b.md", version: "1", sha256: hashFileSha256(path.join(builtin, "demo", "b.md")) },
      ],
    },
  });
  assert.deepEqual(result.copied, ["demo/b.md"]);
  assert.deepEqual(result.skipped, ["demo/a.md"]);
  assert.equal(fs.readFileSync(path.join(target, "demo", "a.md"), "utf8"), "user-edit");
  fs.rmSync(root, { recursive: true, force: true });
});

test("账号数据库激活后立即只补缺失内置 Skills，路由自愈仍可重复执行", async () => {
  const root = path.resolve(process.cwd(), "..", ".tmp", "skills-account-activation");
  const builtin = path.join(root, "builtin");
  const manifestPath = path.join(root, "builtin-skills-manifest.json");
  const originalCwd = process.cwd();
  const originalNodeEnv = process.env.NODE_ENV;
  const originalBuiltinRoot = process.env.TJ_BUILTIN_SKILLS_ROOT;
  const originalManifest = process.env.TJ_BUILTIN_SKILLS_MANIFEST;
  const identity = { issuer: "https://api.j11.com.cn", userId: 77 };
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(builtin, "demo"), { recursive: true });
  fs.writeFileSync(path.join(builtin, "demo", "a.md"), "builtin-a", "utf8");
  fs.writeFileSync(path.join(builtin, "demo", "b.md"), "builtin-b", "utf8");
  fs.writeFileSync(manifestPath, JSON.stringify({
    version: 1,
    files: ["a.md", "b.md"].map((name) => ({
      path: `demo/${name}`,
      version: "1",
      sha256: hashFileSha256(path.join(builtin, "demo", name)),
    })),
  }), "utf8");

  try {
    process.chdir(root);
    process.env.NODE_ENV = "prod";
    process.env.TJ_BUILTIN_SKILLS_ROOT = builtin;
    process.env.TJ_BUILTIN_SKILLS_MANIFEST = manifestPath;
    const dataRoot = path.join(root, "data");
    const skillsRoot = runWithUserStorage(identity, () => currentAccountSkillsRoot(dataRoot));
    fs.mkdirSync(path.join(skillsRoot, "demo"), { recursive: true });
    fs.writeFileSync(path.join(skillsRoot, "demo", "a.md"), "user-edit", "utf8");

    await activateUserDatabase(identity);
    assert.equal(fs.readFileSync(path.join(skillsRoot, "demo", "a.md"), "utf8"), "user-edit");
    assert.equal(fs.readFileSync(path.join(skillsRoot, "demo", "b.md"), "utf8"), "builtin-b");

    const { ensureCurrentAccountBuiltinSkills } = await import("../../src/tianjiang/skills/account-skills");
    const healed = await runWithUserStorage(identity, () => ensureCurrentAccountBuiltinSkills(dataRoot));
    assert.deepEqual(healed.copied, []);
    assert.deepEqual(healed.skipped, ["demo/a.md", "demo/b.md"]);
  } finally {
    await stopGenerationTaskRecovery();
    await destroyAllDatabaseHandles();
    process.chdir(originalCwd);
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalBuiltinRoot === undefined) delete process.env.TJ_BUILTIN_SKILLS_ROOT;
    else process.env.TJ_BUILTIN_SKILLS_ROOT = originalBuiltinRoot;
    if (originalManifest === undefined) delete process.env.TJ_BUILTIN_SKILLS_MANIFEST;
    else process.env.TJ_BUILTIN_SKILLS_MANIFEST = originalManifest;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("内置 Skills 拒绝摘要不符且正式 manifest 必须非空", async () => {
  const root = path.join(process.cwd(), "..", ".tmp", `skills-hash-${Date.now()}`);
  const builtin = path.join(root, "builtin");
  const target = path.join(root, "target");
  fs.mkdirSync(builtin, { recursive: true });
  fs.writeFileSync(path.join(builtin, "SKILL.md"), "tampered", "utf8");
  await assert.rejects(() => installMissingBuiltinSkills({
    builtinRoot: builtin,
    targetRoot: target,
    manifest: {
      version: 1,
      files: [{ path: "SKILL.md", version: "1", sha256: "0".repeat(64) }],
    },
  }), /SHA-256|摘要/);

  const manifestPath = path.join(
    process.cwd(),
    "src",
    "tianjiang",
    "skills",
    "builtin-skills-manifest.json",
  );
  const manifest = loadBuiltinSkillsManifest(manifestPath);
  assert.ok(manifest.files.length > 0);
  for (const entry of manifest.files) {
    assert.equal(
      hashFileSha256(path.join(process.cwd(), "src", "tianjiang", "skills", "builtin", entry.path)),
      entry.sha256,
    );
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test("Skills 根目录必须绑定当前中央账号", () => {
  const dataRoot = path.join(process.cwd(), "..", ".tmp", "skills-account-root");
  const alice = runWithUserStorage(
    { issuer: "https://api.j11.com.cn", userId: 7 },
    () => currentAccountSkillsRoot(dataRoot),
  );
  const bob = runWithUserStorage(
    { issuer: "https://api.j11.com.cn", userId: 8 },
    () => currentAccountSkillsRoot(dataRoot),
  );
  assert.notEqual(alice, bob);
  assert.match(alice, /runtime-users[\\/].+[\\/]skills$/);
  assert.throws(() => currentAccountSkillsRoot(dataRoot), /账号|上下文/);
});

test("Skills 路由不得回退到全局 userData/data/skills", () => {
  for (const file of ["getSkillList.ts", "getSkillContent.ts", "saveSkillContent.ts"]) {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src", "routes", "setting", "skillManagement", file),
      "utf8",
    );
    assert.doesNotMatch(source, /u\.getPath\(\[?["']skills/);
    assert.match(source, /ensureCurrentAccountBuiltinSkills|currentAccountSkillsRoot/);
  }
});

test("Skills 文件解析拒绝目录联接逃逸当前账号目录", async () => {
  const root = path.join(process.cwd(), "..", ".tmp", "skills-link-escape");
  const skillsRoot = path.join(root, "skills");
  const outsideRoot = path.join(root, "outside");
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(skillsRoot, { recursive: true });
  fs.mkdirSync(outsideRoot, { recursive: true });
  fs.writeFileSync(path.join(outsideRoot, "secret.md"), "outside", "utf8");
  fs.symlinkSync(outsideRoot, path.join(skillsRoot, "linked"), "junction");
  try {
    const accountSkills = await import("../../src/tianjiang/skills/account-skills");
    const resolveAccountSkillFile = (accountSkills as any).resolveAccountSkillFile;
    assert.equal(typeof resolveAccountSkillFile, "function");
    assert.throws(
      () => resolveAccountSkillFile(skillsRoot, "linked/secret.md", { mustExist: true }),
      /符号链接|目录联接|越界/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("内置 Skills 安装拒绝通过目录联接写出账号目录", async () => {
  const root = path.join(process.cwd(), "..", ".tmp", "skills-install-link-escape");
  const builtin = path.join(root, "builtin");
  const target = path.join(root, "target");
  const outside = path.join(root, "outside");
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(builtin, "demo"), { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(builtin, "demo", "SKILL.md"), "builtin", "utf8");
  fs.symlinkSync(outside, path.join(target, "demo"), "junction");
  try {
    await assert.rejects(() => installMissingBuiltinSkills({
      builtinRoot: builtin,
      targetRoot: target,
      manifest: {
        version: 1,
        files: [{
          path: "demo/SKILL.md",
          version: "1",
          sha256: hashFileSha256(path.join(builtin, "demo", "SKILL.md")),
        }],
      },
    }), /符号链接|目录联接|越界/);
    assert.equal(fs.existsSync(path.join(outside, "SKILL.md")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("设置主题源码不得硬编码 #000 作为选中背景", () => {
  const setting = fs.readFileSync(
    path.join(process.cwd(), "../web/src/components/setting/index.vue"),
    "utf8",
  );
  assert.doesNotMatch(setting, /background\s*:\s*#000\b|background-color\s*:\s*#000\b/);
});

test("设置页不得再读取 tianjiang://profileSyncStatus 伪状态", () => {
  const settings = fs.readFileSync(
    path.join(process.cwd(), "../web/src/views/settings/index.vue"),
    "utf8",
  );
  assert.doesNotMatch(settings, /tianjiang:\/\/profileSyncStatus/);
  assert.match(settings, /profile-sync\/status|profile-sync\/retry/);
});

test("内置 Skills manifest 全覆盖全部普通文件且含 size/sha256", () => {
  const manifestPath = path.join(
    process.cwd(),
    "src",
    "tianjiang",
    "skills",
    "builtin-skills-manifest.json",
  );
  const builtinRoot = path.join(process.cwd(), "src", "tianjiang", "skills", "builtin");
  const manifest = loadBuiltinSkillsManifest(manifestPath);
  assert.ok(manifest.files.length >= 200, `manifest 文件数过少: ${manifest.files.length}`);
  assert.ok(
    manifest.files.some((entry) => entry.path.startsWith("tianjiang-project-workflow/")),
    "必须保留 tianjiang-project-workflow",
  );
  for (const entry of manifest.files) {
    assert.match(entry.sha256, /^[a-f0-9]{64}$/i);
    const absolute = path.join(builtinRoot, ...entry.path.split("/"));
    assert.equal(fs.existsSync(absolute), true, entry.path);
    assert.equal(hashFileSha256(absolute), entry.sha256, entry.path);
    if (typeof (entry as { size?: number }).size === "number") {
      assert.equal(fs.statSync(absolute).size, (entry as { size: number }).size, entry.path);
    }
  }
  // 磁盘上每个普通文件都必须出现在 manifest（含图片）。
  const walk: string[] = [];
  const visit = (directory: string) => {
    for (const name of fs.readdirSync(directory)) {
      const absolute = path.join(directory, name);
      const details = fs.lstatSync(absolute);
      if (details.isDirectory()) visit(absolute);
      else if (details.isFile()) {
        walk.push(path.relative(builtinRoot, absolute).split(path.sep).join("/"));
      }
    }
  };
  visit(builtinRoot);
  walk.sort((a, b) => a.localeCompare(b, "en"));
  const manifestPaths = manifest.files.map((entry) => entry.path).sort((a, b) => a.localeCompare(b, "en"));
  assert.deepEqual(manifestPaths, walk);
});

test("共享模型根解析与 embedding 使用解析器", async () => {
  const {
    resolveSharedModelsRoot,
    requiredSharedModelRelativePaths,
  } = await import("../../src/tianjiang/models/shared-models-root");
  const embedding = fs.readFileSync(
    path.join(process.cwd(), "src", "utils", "agent", "embedding.ts"),
    "utf8",
  );
  assert.match(embedding, /requireSharedModelsRoot|resolveSharedModelsRoot/);
  assert.doesNotMatch(embedding, /getPath\(\s*["']models["']\s*\)/);
  const resolved = resolveSharedModelsRoot({
    cwd: process.cwd(),
    override: path.join(process.cwd(), "data", "models"),
  });
  assert.notEqual(resolved.source, "missing");
  assert.equal(requiredSharedModelRelativePaths().length, 6);
  for (const relative of requiredSharedModelRelativePaths()) {
    assert.equal(
      fs.existsSync(path.join(resolved.root, ...relative.split("/"))),
      true,
      relative,
    );
  }
});

test("openFolder 使用固定 allowlist 且禁止 shell 字符串拼接", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "src", "routes", "setting", "fileManagement", "openFolder.ts"),
    "utf8",
  );
  assert.match(source, /FOLDER_ALLOWLIST|allowlist/i);
  assert.match(source, /shell\.openPath/);
  assert.doesNotMatch(source, /exec\s*\(/);
  assert.doesNotMatch(source, /explorer\s+`|xdg-open\s+`/);
  assert.match(source, /currentAccountSkillsRoot|requireSharedModelsRoot/);
});

test("getVendorList 单供应商异常不得删除数据库记录", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "src", "routes", "setting", "vendorConfig", "getVendorList.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /\.delete\(\)/);
  assert.match(source, /loadError/);
  assert.match(source, /try\s*\{/);
});
