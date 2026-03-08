import { describe, expect, test } from "bun:test";
import { selectAccount } from "../src/selection";
import type { AccountSnapshot } from "../src/types";

function account(
  id: string,
  creditsRemaining: number | null,
  lastUsedAt: number | null,
): AccountSnapshot {
  return {
    id,
    source: "manual",
    email: `${id}@example.com`,
    arn: null,
    region: "us-east-1",
    status: "active",
    health: "healthy",
    manualSelected: false,
    placeholderEmail: false,
    creditsTotal: 100,
    creditsRemaining,
    quotaExpiresAt: null,
    createdAt: 0,
    updatedAt: 0,
    session: {
      accountId: id,
      sourcePointer: { kind: "env", tokenEnv: `TOKEN_${id}` },
      tokenFingerprint: null,
      refreshHint: null,
      expiresAt: Date.now() + 60_000,
      lastSyncAt: 0,
      lastRefreshAttemptAt: null,
      metadata: {},
    },
    state: {
      accountId: id,
      cooldownUntil: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      lastUsedAt,
      consecutiveFailures: 0,
    },
    usage: [],
  };
}

describe("selectAccount", () => {
  test("prefers the account with the most remaining credits", () => {
    const result = selectAccount(
      [account("a", 10, 10), account("b", 50, 5)],
      "lowest-usage",
      Date.now(),
      null,
      null,
    );
    expect(result.account?.id).toBe("b");
  });

  test("round-robin prefers the least recently used healthy account", () => {
    const result = selectAccount(
      [account("a", 10, 50), account("b", 10, 10)],
      "round-robin",
      Date.now(),
      null,
      null,
    );
    expect(result.account?.id).toBe("b");
  });

  test("sticky honors the sticky account when it stays eligible", () => {
    const result = selectAccount(
      [account("a", 10, 50), account("b", 10, 10)],
      "sticky",
      Date.now(),
      "a",
      null,
    );
    expect(result.account?.id).toBe("a");
  });

  test("manual override wins over strategy", () => {
    const result = selectAccount(
      [account("a", 10, 50), account("b", 99, 10)],
      "lowest-usage",
      Date.now(),
      null,
      "a",
    );
    expect(result.account?.id).toBe("a");
  });
});
