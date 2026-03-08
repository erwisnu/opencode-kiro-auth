import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KiroDatabase } from "../src/database";

let tempRoot = "";

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = "";
  }
});

describe("database", () => {
  test("stores account metadata without token material", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "kiro-db-"));
    const repo = new KiroDatabase(join(tempRoot, "kiro.db"));
    repo.upsertAccount({
      id: "manual:1",
      source: "manual",
      email: "user@example.com",
      arn: null,
      region: "us-east-1",
      status: "active",
      health: "healthy",
      manualSelected: false,
      placeholderEmail: false,
      creditsTotal: 100,
      creditsRemaining: 75,
      quotaExpiresAt: null,
    });
    repo.upsertSession({
      accountId: "manual:1",
      sourcePointer: { kind: "env", tokenEnv: "KIRO_TOKEN" },
      tokenFingerprint: "abcd1234",
      refreshHint: null,
      expiresAt: null,
      lastSyncAt: Date.now(),
      lastRefreshAttemptAt: null,
      metadata: {},
    });

    const raw = repo.db
      .query(`SELECT source_pointer, token_fingerprint FROM sessions WHERE account_id = ?`)
      .get("manual:1") as { source_pointer: string; token_fingerprint: string };
    expect(raw.source_pointer).toContain("tokenEnv");
    expect(raw.source_pointer).not.toContain("secret");
    expect(raw.token_fingerprint).toBe("abcd1234");
    repo.close();
  });
});
