export type PlatformReleaseChannel = "stable" | "beta";

export interface PlatformLatestContract {
  schemaVersion: 2;
  channel: PlatformReleaseChannel;
  platform: "windows" | "macos" | "linux";
  arch: "x64" | "arm64";
  version: string;
  release: string;
}

export interface PlatformArtifactContract {
  path: string;
  fileName: string;
  kind: string;
  size: number;
  sha256: string;
}

export interface PlatformReleaseContract {
  schemaVersion: 2;
  channel: PlatformReleaseChannel;
  sourceChannel: PlatformReleaseChannel;
  platform: "windows" | "macos" | "linux";
  arch: "x64" | "arm64";
  version: string;
  tag: string;
  commitSha: string;
  nativeMetadata: string;
  artifacts: PlatformArtifactContract[];
}

export interface PlatformReleaseKeys {
  latest: string;
  release: string;
  nativeMetadata: string;
}

export function compareDesktopVersions(left: string, right: string): number;
export function platformReleaseKeys(
  channel: PlatformReleaseChannel,
  platform: string,
  arch: string,
  version: string,
): PlatformReleaseKeys;
export function parsePlatformLatest(
  raw: unknown,
  expected: { channel: PlatformReleaseChannel; platform: string; arch: string },
): PlatformLatestContract;
export function parsePlatformRelease(
  raw: unknown,
  expected: { channel: PlatformReleaseChannel; platform: string; arch: string },
): PlatformReleaseContract;
