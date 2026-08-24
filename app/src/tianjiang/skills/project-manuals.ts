/**
 * 项目视觉/导演手册：只读当前账号 Skills 根下的 art_skills / story_skills。
 * 保留真实子目录名 driector_skills，不做品牌回退。
 */
import fs from "node:fs";
import path from "node:path";

import {
  accountSkillPublicUrl,
  assertSafeSkillSegment,
  ensureCurrentAccountBuiltinSkills,
  resolveAccountSkillPath,
} from "./account-skills";

export type ManualFieldMap = { label: string; value: string; subDir?: string };

const VISUAL_FIELDS: ManualFieldMap[] = [
  { label: "README", value: "README" },
  { label: "前缀", value: "prefix" },
  { label: "角色", value: "art_character", subDir: "art_prompt" },
  { label: "角色衍生", value: "art_character_derivative", subDir: "art_prompt" },
  { label: "道具", value: "art_prop", subDir: "art_prompt" },
  { label: "道具衍生", value: "art_prop_derivative", subDir: "art_prompt" },
  { label: "场景", value: "art_scene", subDir: "art_prompt" },
  { label: "场景衍生", value: "art_scene_derivative", subDir: "art_prompt" },
  { label: "分镜", value: "director_storyboard", subDir: "driector_skills" },
  { label: "分镜视频", value: "art_storyboard_video", subDir: "art_prompt" },
  { label: "技法-导演规划", value: "director_planning_style", subDir: "driector_skills" },
  { label: "技法-分镜表设计", value: "director_storyboard_table_style", subDir: "driector_skills" },
];

const DIRECTOR_FIELDS: ManualFieldMap[] = [
  { label: "README", value: "README" },
  { label: "导演规划", value: "director_planning_narrative", subDir: "driector_skills" },
  { label: "分镜表", value: "director_storyboard_table_narrative", subDir: "driector_skills" },
];

function readMd(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

function listStyleDirectories(parentDir: string): string[] {
  if (!fs.existsSync(parentDir)) return [];
  return fs
    .readdirSync(parentDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => {
      try {
        assertSafeSkillSegment(name);
        return true;
      } catch {
        return false;
      }
    });
}

function coverUrls(
  skillsRoot: string,
  category: "art_skills" | "story_skills",
  styleId: string,
): string[] {
  try {
    const imagesDir = resolveAccountSkillPath(
      skillsRoot,
      path.posix.join(category, styleId, "images"),
      { kind: "directory", mustExist: true },
    );
    return fs
      .readdirSync(imagesDir)
      .filter((name) => /\.(png|jpe?g|gif|webp|svg)$/i.test(name))
      .map((name) => accountSkillPublicUrl(path.posix.join(category, styleId, "images", name)));
  } catch {
    return [];
  }
}

function mapFields(styleDir: string, fields: ManualFieldMap[]) {
  return fields.map(({ label, value, subDir }) => {
    const mdPath = subDir
      ? path.join(styleDir, subDir, `${value}.md`)
      : path.join(styleDir, `${value}.md`);
    return { label, value, data: readMd(mdPath) };
  });
}

export async function loadVisualManuals(dataRoot: string) {
  const { skillsRoot } = await ensureCurrentAccountBuiltinSkills(dataRoot);
  const artRoot = resolveAccountSkillPath(skillsRoot, "art_skills", {
    kind: "directory",
    mustExist: false,
  });
  if (!fs.existsSync(artRoot)) return [];
  const styles = listStyleDirectories(artRoot);
  return styles.map((stylePath) => {
    const styleDir = path.join(artRoot, stylePath);
    const readme = readMd(path.join(styleDir, "README.md"));
    const name = readme.split("\n")[0]?.replace(/--/g, "") || stylePath;
    return {
      name,
      image: coverUrls(skillsRoot, "art_skills", stylePath),
      stylePath,
      data: mapFields(styleDir, VISUAL_FIELDS),
    };
  });
}

export async function loadDirectorManuals(dataRoot: string) {
  const { skillsRoot } = await ensureCurrentAccountBuiltinSkills(dataRoot);
  const storyRoot = resolveAccountSkillPath(skillsRoot, "story_skills", {
    kind: "directory",
    mustExist: false,
  });
  if (!fs.existsSync(storyRoot)) return [];
  const styles = listStyleDirectories(storyRoot);
  return styles.map((directorManual) => {
    const styleDir = path.join(storyRoot, directorManual);
    const readme = readMd(path.join(styleDir, "README.md"));
    const name = readme.split("\n")[0]?.replace(/--/g, "") || directorManual;
    return {
      name,
      image: coverUrls(skillsRoot, "story_skills", directorManual),
      directorManual,
      data: mapFields(styleDir, DIRECTOR_FIELDS),
    };
  });
}

/** 手册增删改：解析当前账号下 art_skills|story_skills/<id> 目录。 */
export async function resolveManualStyleDirectory(
  dataRoot: string,
  category: "art_skills" | "story_skills",
  styleId: string,
  options: { mustExist?: boolean } = {},
): Promise<{ skillsRoot: string; styleDir: string; styleId: string }> {
  const safeId = assertSafeSkillSegment(styleId, category === "art_skills" ? "视觉手册" : "导演手册");
  const { skillsRoot } = await ensureCurrentAccountBuiltinSkills(dataRoot);
  const styleDir = resolveAccountSkillPath(
    skillsRoot,
    path.posix.join(category, safeId),
    { kind: "directory", mustExist: options.mustExist !== false },
  );
  return { skillsRoot, styleDir, styleId: safeId };
}

export { VISUAL_FIELDS, DIRECTOR_FIELDS };
