export function syncWeb(source: string, target: string): void;
export function verifyPackage(
  packageRoot: string,
  source: string,
  options?: Record<string, unknown>,
): Promise<Record<string, unknown>>;
export function verifyPackagedBuiltinSkills(
  packageRoot: string,
  options?: Record<string, unknown>,
): { manifestVersion: number; fileCount: number; verifiedSha256Count: number };
export function verifyPackagedSharedModels(
  packageRoot: string,
  options?: Record<string, unknown>,
): { fileCount: number; files: Array<{ path: string; size: number; sha256: string }> };
export function parsePackagedUpdateFeedURL(yaml: string): string;
