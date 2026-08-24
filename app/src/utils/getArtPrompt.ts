import fs from "fs";
import path from "path";
import getPath from "./getPath";
import {
  assertSafeSkillSegment,
  currentAccountSkillsRoot,
  resolveAccountSkillPath,
} from "@/tianjiang/skills/account-skills";

/**
 * 从当前账号 Skills 读取风格 Markdown（含 prefix 前缀拼接）。
 * source 一般为 art_skills 或 story_skills。
 */
export function getArtPrompt(styleName: string, source: string, fileName: string): string {
  const safeSource = assertSafeSkillSegment(source, "Skills 来源");
  const safeStyle = assertSafeSkillSegment(styleName, "风格目录");
  const skillsRoot = currentAccountSkillsRoot(getPath());
  let baseDir: string;
  try {
    baseDir = resolveAccountSkillPath(
      skillsRoot,
      path.posix.join(safeSource, safeStyle),
      { kind: "directory", mustExist: true },
    );
  } catch {
    return "";
  }

  const prefixFile = findFileRecursive(baseDir, "prefix.md");
  const prefixContent = prefixFile ? fs.readFileSync(prefixFile, "utf-8") : "";

  const target = fileName.endsWith(".md") ? fileName : `${fileName}.md`;
  const found = findFileRecursive(baseDir, target);
  if (!found) return prefixContent;
  const fileContent = fs.readFileSync(found, "utf-8");
  return prefixContent ? `${prefixContent}\n${fileContent}` : fileContent;
}

export function getAllArtPrompts(styleName: string, source: string): Record<string, string> {
  const safeSource = assertSafeSkillSegment(source, "Skills 来源");
  const safeStyle = assertSafeSkillSegment(styleName, "风格目录");
  const skillsRoot = currentAccountSkillsRoot(getPath());
  let baseDir: string;
  try {
    baseDir = resolveAccountSkillPath(
      skillsRoot,
      path.posix.join(safeSource, safeStyle),
      { kind: "directory", mustExist: true },
    );
  } catch {
    return {};
  }
  const result: Record<string, string> = {};
  collectMdFiles(baseDir, result);
  return result;
}

function findFileRecursive(dir: string, targetName: string): string | null {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === targetName) return fullPath;
    if (entry.isDirectory()) {
      const found = findFileRecursive(fullPath, targetName);
      if (found) return found;
    }
  }
  return null;
}

function collectMdFiles(dir: string, result: Record<string, string>): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith(".md")) {
      result[entry.name.replace(/\.md$/, "")] = fs.readFileSync(fullPath, "utf-8");
    }
    if (entry.isDirectory()) collectMdFiles(fullPath, result);
  }
}
