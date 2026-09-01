/** 中文注释：通用耐久生成内核，禁止依赖分镜镜头或分镜项目表。 */

export interface DurableGenerationIdentity {
  projectUuid: string;
  runUuid: string;
  requestDigest: string;
  providerIdempotencyKey: string;
  providerId: string;
  deploymentKey: string;
  credentialSlotId: string;
}

export interface DurableGenerationCapabilities {
  canQueryByClientKey: boolean;
  canReplaySameIdempotencyKey: boolean;
  adapterProtocolVersion: string;
}

export type DurableGenerationState =
  | "ready"
  | "leased"
  | "submitting"
  | "submitted"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled"
  | "outcome_unknown";

export function durableGenerationDigest(input: {
  identity: DurableGenerationIdentity;
  capabilities: DurableGenerationCapabilities;
  immutableRequestJson: string;
}): string {
  return `${input.identity.requestDigest}:${input.capabilities.adapterProtocolVersion}`;
}
