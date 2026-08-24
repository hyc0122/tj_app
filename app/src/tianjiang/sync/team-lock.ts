export interface ActiveTeamLock {
  lockId: string;
  fencingToken: number;
  expiresAt: number;
}

export interface TeamLockSnapshot {
  editable: boolean;
  lockId: string;
  fencingToken: number;
  readonlyReason: string;
  recoveryRequired: boolean;
}

export class TeamLockGuard {
  private lock: ActiveTeamLock | null = null;
  private readonlyReason = "lock_required";
  private recoveryRequired = false;

  constructor(private readonly now: () => number = Date.now) {}

  activate(lock: ActiveTeamLock): void {
    this.lock = { ...lock };
    this.readonlyReason = "";
    this.recoveryRequired = false;
  }

  canSubmit(lockId: string, fencingToken: number): boolean {
    return Boolean(
      this.lock &&
        this.lock.expiresAt > this.now() &&
        this.lock.lockId === lockId &&
        this.lock.fencingToken === fencingToken,
    );
  }

  onHeartbeatFailed(reason = "heartbeat_failed"): void {
    this.becomeReadonly(reason);
  }

  onSessionInvalid(): void {
    this.becomeReadonly("session_invalid");
  }

  onNetworkLost(reason = "network_disconnected"): void {
    this.becomeReadonly(reason);
  }

  snapshot(): TeamLockSnapshot {
    const editable = Boolean(this.lock && this.lock.expiresAt > this.now());
    if (!editable && this.lock) {
      this.becomeReadonly("lease_expired");
    }
    return {
      editable: Boolean(this.lock),
      lockId: this.lock?.lockId ?? "",
      fencingToken: this.lock?.fencingToken ?? 0,
      readonlyReason: this.readonlyReason,
      recoveryRequired: this.recoveryRequired,
    };
  }

  private becomeReadonly(reason: string): void {
    this.lock = null;
    this.readonlyReason = reason;
    this.recoveryRequired = true;
  }
}
