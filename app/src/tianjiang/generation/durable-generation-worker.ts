import type {
  DurableGenerationCapabilities,
  DurableGenerationIdentity,
  DurableGenerationState,
} from "./durable-generation-operation";

export interface DurableGenerationRecoveryDecision {
  nextState: DurableGenerationState;
  maySubmit: boolean;
  mayQuery: boolean;
}

/** 中文注释：submitting 遗留不得回到 ready/leased；无可信能力则 outcome_unknown。 */
export function decideDurableGenerationRecovery(input: {
  state: DurableGenerationState;
  capabilities: DurableGenerationCapabilities;
  hasRemoteTaskId: boolean;
}): DurableGenerationRecoveryDecision {
  if (input.state === "submitting") {
    if (input.capabilities.canQueryByClientKey) {
      return { nextState: "running", maySubmit: false, mayQuery: true };
    }
    if (input.capabilities.canReplaySameIdempotencyKey) {
      return { nextState: "submitting", maySubmit: true, mayQuery: false };
    }
    return { nextState: "outcome_unknown", maySubmit: false, mayQuery: false };
  }
  if (input.hasRemoteTaskId) {
    return { nextState: "running", maySubmit: false, mayQuery: true };
  }
  return { nextState: input.state, maySubmit: false, mayQuery: false };
}

export function assertDurableIdentity(identity: DurableGenerationIdentity): void {
  if (!identity.projectUuid || !identity.runUuid || !identity.requestDigest) {
    throw new Error("耐久生成身份不完整");
  }
}
