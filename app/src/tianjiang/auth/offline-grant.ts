export interface CachedOfflineGrant {
  grantId: string;
  userId: number;
  deviceUuid: string;
  expiresAt: string;
  revokedAt?: string | null;
}

export interface OfflineWriteContext {
  userId: number;
  deviceUuid: string;
  projectKind: "personal" | "team";
  projectOwnerId: number;
  now: Date;
}

export type OfflineWriteDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | "OFFLINE_GRANT_EXPIRED"
        | "OFFLINE_GRANT_REVOKED"
        | "OFFLINE_GRANT_IDENTITY_MISMATCH"
        | "OFFLINE_TEAM_PROJECT_FORBIDDEN"
        | "OFFLINE_NOT_PROJECT_OWNER";
    };

export function evaluateOfflineWrite(
  grant: CachedOfflineGrant,
  context: OfflineWriteContext,
): OfflineWriteDecision {
  if (grant.revokedAt) {
    return { allowed: false, reason: "OFFLINE_GRANT_REVOKED" };
  }
  if (Date.parse(grant.expiresAt) <= context.now.getTime()) {
    return { allowed: false, reason: "OFFLINE_GRANT_EXPIRED" };
  }
  if (grant.userId !== context.userId || grant.deviceUuid !== context.deviceUuid) {
    return { allowed: false, reason: "OFFLINE_GRANT_IDENTITY_MISMATCH" };
  }
  if (context.projectKind === "team") {
    return { allowed: false, reason: "OFFLINE_TEAM_PROJECT_FORBIDDEN" };
  }
  if (context.projectOwnerId !== context.userId) {
    return { allowed: false, reason: "OFFLINE_NOT_PROJECT_OWNER" };
  }
  return { allowed: true };
}
