import type { Buffer } from "node:buffer";

export type PlatformReleaseChannel = "stable" | "beta";

export interface PlatformObjectMetadata {
  contentType: string;
  cacheControl: string;
}

export interface PlatformMutableObjectState {
  bytes: Buffer | null;
}

export interface PlatformPublicObjectSummary {
  size: number;
  sha256: string;
}

export interface PlatformPublicRangeSummary {
  status: number;
  contentRange: string | null;
  bytes: Buffer;
}

/** Stable Windows 发布事务所需的最小远端能力合同。 */
export interface PlatformPublicationRemote {
  assertImmutableUploadMode(): Promise<void>;
  readObject(key: string): Promise<Buffer | null>;
  readMutable(key: string): Promise<PlatformMutableObjectState>;
  putImmutable(
    key: string,
    bytes: Buffer,
    metadata: PlatformObjectMetadata,
  ): Promise<"created" | "exists">;
  putAtomic(key: string, bytes: Buffer, metadata: PlatformObjectMetadata): Promise<void>;
  readPublicObject(
    key: string,
    expectedSize: number,
    expectedSha256: string,
  ): Promise<PlatformPublicObjectSummary | null>;
  readPublicRange(key: string, start: number, end: number): Promise<PlatformPublicRangeSummary>;
}

export interface PublishStableWindowsTransactionOptions {
  publicationRoot: string;
  version: string;
  remote: PlatformPublicationRemote;
  singleWriterProof?: string;
}

export interface PublishStableWindowsTransactionResult {
  version: string;
  channels: PlatformReleaseChannel[];
}

export interface PlatformFetchResponse {
  status: number;
  headers: Pick<Headers, "get">;
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> | null;
}

export type PlatformFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<PlatformFetchResponse>;

/** OSS SDK 模块由运行时动态加载；泛型保留离线夹具的精确模块类型。 */
export interface PlatformOssDependencies<OssModule = unknown> {
  loadOss?: () => Promise<OssModule>;
  fetch?: PlatformFetch;
}

export function publishStableWindowsTransaction(
  options: PublishStableWindowsTransactionOptions,
): Promise<PublishStableWindowsTransactionResult>;

export function createPlatformOssRemoteFromEnvironment<OssModule = unknown>(
  environment?: Readonly<Record<string, string | undefined>>,
  dependencies?: PlatformOssDependencies<OssModule>,
): Promise<PlatformPublicationRemote>;
