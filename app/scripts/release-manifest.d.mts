import type { ReleaseTargetId } from "./release-targets.mjs";

export type ReleaseArtifactKind =
  | "installer"
  | "disk-image"
  | "archive"
  | "app-image"
  | "blockmap"
  | "metadata";

export interface TargetIndex {
  schemaVersion: 1;
  targetId: ReleaseTargetId;
  platform: "windows" | "macos" | "linux";
  arch: "x64" | "arm64";
  metadataFile: "latest.yml" | "latest-mac.yml" | "latest-linux.yml";
  files: Array<{
    fileName: string;
    kind: ReleaseArtifactKind;
    size: number;
    sha256: string;
  }>;
}

export interface ReleaseManifest {
  schemaVersion: 1;
  version: string;
  tag: string;
  channel: "beta";
  commitSha: string;
  repository: "hyc0122/tianjiang-manchuang" | "hyc0122/tj_app";
  workflow: ".github/workflows/app-release.yml";
  runId: string;
  runAttempt: string;
  generatedAt: string;
  artifacts: Array<{
    path: string;
    fileName: string;
    platform: "windows" | "macos" | "linux";
    arch: "x64" | "arm64";
    kind: string;
    size: number;
    sha256: string;
  }>;
}

export interface ReleaseManifestContext {
  version: string;
  tag: string;
  channel: "beta";
  commitSha: string;
  repository: "hyc0122/tianjiang-manchuang" | "hyc0122/tj_app";
  workflow: ".github/workflows/app-release.yml";
  runId: string;
  runAttempt: string;
  generatedAt: string;
}

export function prepareReleaseTarget(options: {
  sourceRoot: string;
  destinationRoot: string;
  targetId: ReleaseTargetId;
  version: string;
}): TargetIndex;

export function buildReleaseManifest(options: {
  targetsRoot: string;
  outputRoot: string;
  context: ReleaseManifestContext;
}): {
  manifest: ReleaseManifest;
  manifestPath: string;
  sha256SumsPath: string;
};

export function prepareReleasePublication(options: {
  targetsRoot: string;
  manifestPath: string;
  sha256SumsPath: string;
  sigstoreBundlePath: string;
  destinationRoot: string;
}): {
  version: string;
  tag: string;
  commitSha: string;
  releaseRelative: string;
  githubAttachments: string[];
};
