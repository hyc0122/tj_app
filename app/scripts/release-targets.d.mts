export type ReleaseTargetId =
  | "windows-x64"
  | "macos-x64"
  | "macos-arm64"
  | "linux-x64"
  | "linux-arm64";

interface ReleaseTargetDefinition<
  Id extends ReleaseTargetId,
  Platform extends "windows" | "macos" | "linux",
  ProcessPlatform extends "win32" | "darwin" | "linux",
  BuilderPlatform extends "win" | "mac" | "linux",
  Arch extends "x64" | "arm64",
  Runner extends "windows-2025" | "macos-15-intel" | "macos-15" | "ubuntu-24.04" | "ubuntu-24.04-arm",
  MetadataFile extends "latest.yml" | "latest-mac.yml" | "latest-linux.yml",
  ReleaseMetadataFile extends
    | "latest-windows-x64.yml"
    | "latest-mac-x64.yml"
    | "latest-mac-arm64.yml"
    | "latest-linux-x64.yml"
    | "latest-linux-arm64.yml",
  BinaryExtensions extends readonly [".exe"] | readonly [".dmg", ".zip"] | readonly [".AppImage"],
> {
  readonly id: Id;
  readonly platform: Platform;
  readonly processPlatform: ProcessPlatform;
  readonly builderPlatform: BuilderPlatform;
  readonly arch: Arch;
  readonly runner: Runner;
  readonly metadataFile: MetadataFile;
  readonly releaseMetadataFile: ReleaseMetadataFile;
  readonly binaryExtensions: BinaryExtensions;
}

export type WindowsX64ReleaseTarget = Readonly<ReleaseTargetDefinition<
  "windows-x64", "windows", "win32", "win", "x64", "windows-2025",
  "latest.yml", "latest-windows-x64.yml", readonly [".exe"]
>>;
export type MacosX64ReleaseTarget = Readonly<ReleaseTargetDefinition<
  "macos-x64", "macos", "darwin", "mac", "x64", "macos-15-intel",
  "latest-mac.yml", "latest-mac-x64.yml", readonly [".dmg", ".zip"]
>>;
export type MacosArm64ReleaseTarget = Readonly<ReleaseTargetDefinition<
  "macos-arm64", "macos", "darwin", "mac", "arm64", "macos-15",
  "latest-mac.yml", "latest-mac-arm64.yml", readonly [".dmg", ".zip"]
>>;
export type LinuxX64ReleaseTarget = Readonly<ReleaseTargetDefinition<
  "linux-x64", "linux", "linux", "linux", "x64", "ubuntu-24.04",
  "latest-linux.yml", "latest-linux-x64.yml", readonly [".AppImage"]
>>;
export type LinuxArm64ReleaseTarget = Readonly<ReleaseTargetDefinition<
  "linux-arm64", "linux", "linux", "linux", "arm64", "ubuntu-24.04-arm",
  "latest-linux.yml", "latest-linux-arm64.yml", readonly [".AppImage"]
>>;

export type ReleaseTarget =
  | WindowsX64ReleaseTarget
  | MacosX64ReleaseTarget
  | MacosArm64ReleaseTarget
  | LinuxX64ReleaseTarget
  | LinuxArm64ReleaseTarget;

export const RELEASE_TARGETS: Readonly<{
  "windows-x64": WindowsX64ReleaseTarget;
  "macos-x64": MacosX64ReleaseTarget;
  "macos-arm64": MacosArm64ReleaseTarget;
  "linux-x64": LinuxX64ReleaseTarget;
  "linux-arm64": LinuxArm64ReleaseTarget;
}>;

export function resolveReleaseTarget(id: ReleaseTargetId): ReleaseTarget;

export function resolveReleaseTargetId(
  platform: "win32" | "darwin" | "linux",
  arch: "x64" | "arm64",
): ReleaseTargetId;
