import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  accountSkillPublicUrl,
  assertSafeSkillSegment,
  currentAccountSkillsRoot,
  ensureCurrentAccountBuiltinSkills,
  resolveAccountSkillFile,
  resolveAccountSkillPath,
} from "../../src/tianjiang/skills/account-skills";
import {
  loadDirectorManuals,
  loadVisualManuals,
} from "../../src/tianjiang/skills/project-manuals";
import { getArtPrompt } from "../../src/utils/getArtPrompt";
import { runWithUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import { buildSessionCookie } from "../../src/tianjiang/auth/central-session";

const alice = { issuer: "https://api.j11.com.cn", userId: 701 };
const bob = { issuer: "https://api.j11.com.cn", userId: 702 };

test("RED→GREEN: 手册封面必须位于登录 Cookie 可达的 /api/skills 路径", () => {
  // 浏览器会将相对地址解析到当前回环服务；路径必须落在 Cookie 的 /api 作用域。
  assert.equal(
    accountSkillPublicUrl("art_skills/style_a/images/cover.png"),
    "/api/skills/art_skills/style_a/images/cover.png",
  );

  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "app.ts"), "utf8");
  assert.match(buildSessionCookie("session", false, 60), /(?:^|; )Path=\/api(?:;|$)/);
  assert.match(appSource, /app\.use\(["']\/api\/skills["']/);
  assert.doesNotMatch(appSource, /app\.use\(["']\/skills["']/);
});

function tempRoot(name: string): string {
  const root = path.join(process.cwd(), "..", ".tmp", `manual-${name}-${Date.now()}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function seedAccountStyle(
  skillsRoot: string,
  category: "art_skills" | "story_skills",
  styleId: string,
  readme: string,
): void {
  const styleDir = path.join(skillsRoot, category, styleId);
  const images = path.join(styleDir, "images");
  fs.mkdirSync(images, { recursive: true });
  fs.writeFileSync(path.join(styleDir, "README.md"), readme, "utf8");
  fs.writeFileSync(path.join(styleDir, "prefix.md"), "PREFIX\n", "utf8");
  fs.writeFileSync(path.join(images, "cover.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]), "utf8");
  if (category === "art_skills") {
    fs.mkdirSync(path.join(styleDir, "art_prompt"), { recursive: true });
    fs.writeFileSync(path.join(styleDir, "art_prompt", "art_character.md"), "CHAR-A", "utf8");
    fs.mkdirSync(path.join(styleDir, "driector_skills"), { recursive: true });
  } else {
    fs.mkdirSync(path.join(styleDir, "driector_skills"), { recursive: true });
    fs.writeFileSync(
      path.join(styleDir, "driector_skills", "director_planning_narrative.md"),
      "PLAN",
      "utf8",
    );
  }
}

test("RED→GREEN: 全局 data/skills 为空时账号内置手册仍可列出", async () => {
  const root = tempRoot("empty-global");
  const dataRoot = path.join(root, "data");
  const globalSkills = path.join(dataRoot, "skills");
  fs.mkdirSync(globalSkills, { recursive: true });
  // 全局为空，模拟旧 bug 场景
  assert.equal(fs.readdirSync(globalSkills).length, 0);

  const builtin = path.join(process.cwd(), "src", "tianjiang", "skills", "builtin");
  const manifest = path.join(process.cwd(), "src", "tianjiang", "skills", "builtin-skills-manifest.json");
  process.env.TJ_BUILTIN_SKILLS_ROOT = builtin;
  process.env.TJ_BUILTIN_SKILLS_MANIFEST = manifest;

  try {
    await runWithUserStorage(alice, async () => {
      await ensureCurrentAccountBuiltinSkills(dataRoot);
      const visual = await loadVisualManuals(dataRoot);
      const director = await loadDirectorManuals(dataRoot);
      assert.ok(visual.length > 0, "账号 art_skills 应列出视觉手册");
      assert.ok(director.length > 0, "账号 story_skills 应列出导演手册");
      const card = visual[0]!;
      assert.ok(card.stylePath);
      assert.ok(card.name);
      assert.ok(Array.isArray(card.image));
      if (card.image.length) {
        assert.match(card.image[0]!, /^(\/|http:\/\/127\.0\.0\.1)/);
        assert.doesNotMatch(card.image[0]!, /^file:/i);
        assert.doesNotMatch(card.image[0]!, /[A-Za-z]:\\/);
      }
    });
  } finally {
    delete process.env.TJ_BUILTIN_SKILLS_ROOT;
    delete process.env.TJ_BUILTIN_SKILLS_MANIFEST;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("账号 A/B 手册隔离，删除 A 不影响 B", async () => {
  const root = tempRoot("ab-iso");
  const dataRoot = path.join(root, "data");
  try {
    const aliceRoot = runWithUserStorage(alice, () => currentAccountSkillsRoot(dataRoot));
    const bobRoot = runWithUserStorage(bob, () => currentAccountSkillsRoot(dataRoot));
    seedAccountStyle(aliceRoot, "art_skills", "style_alice", "AliceStyle\n");
    seedAccountStyle(bobRoot, "art_skills", "style_bob", "BobStyle\n");

    const aliceList = await runWithUserStorage(alice, () => loadVisualManuals(dataRoot));
    const bobList = await runWithUserStorage(bob, () => loadVisualManuals(dataRoot));
    assert.ok(aliceList.some((i) => i.stylePath === "style_alice"));
    assert.ok(!aliceList.some((i) => i.stylePath === "style_bob"));
    assert.ok(bobList.some((i) => i.stylePath === "style_bob"));

    fs.rmSync(path.join(aliceRoot, "art_skills", "style_alice"), { recursive: true, force: true });
    const bobAfter = await runWithUserStorage(bob, () => loadVisualManuals(dataRoot));
    assert.ok(bobAfter.some((i) => i.stylePath === "style_bob"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("getArtPrompt 从当前账号读取选中 Skill 且路径穿越被拒绝", async () => {
  const root = tempRoot("art-prompt");
  const originalCwd = process.cwd();
  try {
    process.chdir(root);
    const dataRoot = path.join(root, "data");
    const skillsRoot = runWithUserStorage(alice, () => {
      const sr = currentAccountSkillsRoot(dataRoot);
      seedAccountStyle(sr, "art_skills", "style_a", "StyleA\n");
      return sr;
    });
    const content = runWithUserStorage(alice, () =>
      getArtPrompt("style_a", "art_skills", "art_character"),
    );
    assert.match(content, /PREFIX/);
    assert.match(content, /CHAR-A/);
    const charPath = resolveAccountSkillFile(
      skillsRoot,
      "art_skills/style_a/art_prompt/art_character.md",
      { mustExist: true },
    );
    assert.equal(fs.readFileSync(charPath, "utf8"), "CHAR-A");

    assert.throws(() => assertSafeSkillSegment("../etc", "视觉手册"), /标识无效/);
    assert.throws(
      () => resolveAccountSkillPath(skillsRoot, "../outside", { kind: "file" }),
      /越界|无效/,
    );
    assert.throws(
      () => resolveAccountSkillPath(skillsRoot, "C:\\Windows\\system32", { kind: "file" }),
      /越界|无效/,
    );
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("手册与 agent 路由源码禁止回退全局 data/skills", () => {
  const files = [
    "src/routes/project/getVisualManual.ts",
    "src/routes/project/queryDirectorManual.ts",
    "src/routes/project/addVisualManual.ts",
    "src/routes/project/editVisualManual.ts",
    "src/routes/project/deleteVisualManual.ts",
    "src/routes/project/addDirectorManual.ts",
    "src/routes/project/editDirectorlManual.ts",
    "src/routes/project/deleteDirectorManual.ts",
    "src/utils/getArtPrompt.ts",
    "src/agents/productionAgent/index.ts",
    "src/agents/scriptAgent/index.ts",
    "src/utils/agent/skillsTools.ts",
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
    assert.doesNotMatch(source, /u\.getPath\(\[?["']skills|getPath\(\[?["']skills/, file);
    assert.match(
      source,
      /currentAccountSkillsRoot|ensureCurrentAccountBuiltinSkills|resolveAccountSkill|loadVisualManuals|loadDirectorManuals|resolveManualStyleDirectory/,
      file,
    );
  }
});

test("内置文件用户修改后 ensure 不覆盖", async () => {
  const root = tempRoot("no-overwrite");
  const dataRoot = path.join(root, "data");
  const builtin = path.join(process.cwd(), "src", "tianjiang", "skills", "builtin");
  const manifest = path.join(process.cwd(), "src", "tianjiang", "skills", "builtin-skills-manifest.json");
  process.env.TJ_BUILTIN_SKILLS_ROOT = builtin;
  process.env.TJ_BUILTIN_SKILLS_MANIFEST = manifest;
  try {
    await runWithUserStorage(alice, async () => {
      const first = await ensureCurrentAccountBuiltinSkills(dataRoot);
      assert.ok(first.copied.length > 0 || first.skipped.length > 0);
      // 修改一个已存在文件
      const target = resolveAccountSkillFile(
        first.skillsRoot,
        first.copied[0] ?? first.skipped[0]!,
        { mustExist: true },
      );
      fs.writeFileSync(target, "user-modified-content", "utf8");
      const second = await ensureCurrentAccountBuiltinSkills(dataRoot);
      assert.equal(fs.readFileSync(target, "utf8"), "user-modified-content");
      assert.ok(second.skipped.includes(path.relative(first.skillsRoot, target).split(path.sep).join("/"))
        || second.copied.every((p) => p !== path.relative(first.skillsRoot, target).split(path.sep).join("/")));
    });
  } finally {
    delete process.env.TJ_BUILTIN_SKILLS_ROOT;
    delete process.env.TJ_BUILTIN_SKILLS_MANIFEST;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
