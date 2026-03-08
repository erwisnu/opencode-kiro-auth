import { AccountSelectionStrategy, AccountSnapshot } from "./types";

export type SelectionResult =
  | {
      account: AccountSnapshot;
      reason: string;
    }
  | {
      account: null;
      reason: string;
    };

export function selectAccount(
  candidates: AccountSnapshot[],
  strategy: AccountSelectionStrategy,
  now: number,
  stickyAccountId: string | null,
  manualOverrideAccountId: string | null,
): SelectionResult {
  const eligible = candidates.filter((candidate) => isEligible(candidate, now));

  if (manualOverrideAccountId) {
    const manual = eligible.find((item) => item.id === manualOverrideAccountId);
    if (manual) {
      return { account: manual, reason: "manual-override" };
    }
  }

  if (eligible.length === 0) {
    return { account: null, reason: "no-eligible-accounts" };
  }

  if (strategy === "sticky" && stickyAccountId) {
    const sticky = eligible.find((item) => item.id === stickyAccountId);
    if (sticky) {
      return { account: sticky, reason: "sticky" };
    }
  }

  if (strategy === "round-robin") {
    const sorted = [...eligible].sort((a, b) => {
      const aLast = a.state.lastUsedAt ?? 0;
      const bLast = b.state.lastUsedAt ?? 0;
      if (aLast !== bLast) {
        return aLast - bLast;
      }
      return a.id.localeCompare(b.id);
    });
    return { account: sorted[0], reason: "round-robin" };
  }

  const sorted = [...eligible].sort((a, b) => {
    const aRemaining = a.creditsRemaining ?? Number.POSITIVE_INFINITY;
    const bRemaining = b.creditsRemaining ?? Number.POSITIVE_INFINITY;
    if (aRemaining !== bRemaining) {
      return bRemaining - aRemaining;
    }
    const aFailures = a.state.consecutiveFailures;
    const bFailures = b.state.consecutiveFailures;
    if (aFailures !== bFailures) {
      return aFailures - bFailures;
    }
    const aLast = a.state.lastUsedAt ?? 0;
    const bLast = b.state.lastUsedAt ?? 0;
    if (aLast !== bLast) {
      return aLast - bLast;
    }
    return a.id.localeCompare(b.id);
  });

  return {
    account: sorted[0],
    reason: strategy === "sticky" ? "sticky-fallback" : "lowest-usage",
  };
}

export function isEligible(candidate: AccountSnapshot, now: number): boolean {
  if (candidate.status !== "active") {
    return false;
  }
  if (!candidate.session) {
    return false;
  }
  if (candidate.session.expiresAt && candidate.session.expiresAt <= now) {
    return false;
  }
  if (candidate.state.cooldownUntil && candidate.state.cooldownUntil > now) {
    return false;
  }
  if (
    candidate.creditsRemaining !== null &&
    candidate.creditsRemaining <= 0
  ) {
    return false;
  }
  return true;
}
