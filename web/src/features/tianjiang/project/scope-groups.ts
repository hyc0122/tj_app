/**
 * 项目目录按个人/团队名称分组（稳定排序，projectUuid 唯一键）。
 */

export interface ScopedCatalogItem {
  projectUuid: string;
  name: string;
  kind: "personal" | "team";
  teamUuid?: string;
  teamName?: string;
  myRole?: string;
  openMode?: string;
  currentVersion?: number;
  syncState?: string;
  updatedAt?: string;
  lockStatus?: string;
  lockHolderName?: string;
  lastSyncedAt?: string | null;
  businessType?: "novel" | "script" | "storyboard" | string;
  assetSourceProjectUuid?: string;
}

export interface ProjectGroup {
  key: string;
  titleKey: "projectScope.personal" | "projectScope.team";
  titleParams?: { name: string };
  teamUuid?: string;
  items: ScopedCatalogItem[];
}

/**
 * @returns groups 正常分组；skipped 缺团队字段的 team 项目
 */
export function groupProjectsByScope(items: ScopedCatalogItem[]): {
  groups: ProjectGroup[];
  skipped: ScopedCatalogItem[];
} {
  const personal: ScopedCatalogItem[] = [];
  const teamMap = new Map<string, { name: string; items: ScopedCatalogItem[] }>();
  const skipped: ScopedCatalogItem[] = [];

  for (const item of items) {
    if (item.kind === "personal") {
      personal.push(item);
      continue;
    }
    if (item.kind === "team") {
      const teamUuid = item.teamUuid;
      if (!teamUuid) {
        skipped.push(item);
        continue;
      }
      const name = item.teamName || teamUuid;
      const bucket = teamMap.get(teamUuid) ?? { name, items: [] };
      bucket.name = name;
      bucket.items.push(item);
      teamMap.set(teamUuid, bucket);
      continue;
    }
    skipped.push(item);
  }

  const sortByName = (a: ScopedCatalogItem, b: ScopedCatalogItem) => {
    const byName = a.name.localeCompare(b.name, "zh");
    if (byName !== 0) return byName;
    return a.projectUuid.localeCompare(b.projectUuid);
  };

  const groups: ProjectGroup[] = [];
  if (personal.length) {
    groups.push({
      key: "personal",
      titleKey: "projectScope.personal",
      items: personal.slice().sort(sortByName),
    });
  }

  const teamEntries = [...teamMap.entries()].sort((a, b) => {
    const byName = a[1].name.localeCompare(b[1].name, "zh");
    return byName !== 0 ? byName : a[0].localeCompare(b[0]);
  });
  for (const [teamUuid, bucket] of teamEntries) {
    groups.push({
      key: `team:${teamUuid}`,
      titleKey: "projectScope.team",
      titleParams: { name: bucket.name },
      teamUuid,
      items: bucket.items.slice().sort(sortByName),
    });
  }

  return { groups, skipped };
}

export function filterGroupsByScope(
  groups: ProjectGroup[],
  scope: "all" | "personal" | string,
): ProjectGroup[] {
  if (scope === "all") return groups;
  if (scope === "personal") return groups.filter((g) => g.key === "personal");
  return groups.filter((g) => g.teamUuid === scope);
}
