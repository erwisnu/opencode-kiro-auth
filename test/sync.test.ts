import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KiroDatabase } from "../src/database";
import {
  resolveSessionToken,
  syncFromAwsSso,
  syncFromManualImport,
} from "../src/services/sync";

let tempRoot = "";

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = "";
  }
});

describe("sync services", () => {
  test("imports AWS SSO cache files", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "kiro-auth-"));
    const cacheDir = join(tempRoot, "cache");
    await mkdir(cacheDir);
    await writeFile(
      join(cacheDir, "sample.json"),
      JSON.stringify({
        accessToken: "token-123",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        region: "us-east-1",
        startUrl: "https://builder.aws",
      }),
    );

    const repo = new KiroDatabase(join(tempRoot, "kiro.db"));
    const report = await syncFromAwsSso(repo, {
      auto_sync_kiro_cli: false,
      auto_sync_aws_sso: true,
      account_selection_strategy: "lowest-usage",
      default_region: "us-east-1",
      rate_limit_retry_delay_ms: 5000,
      rate_limit_max_retries: 3,
      usage_tracking_enabled: true,
      low_quota_threshold_credits: 15,
      sync_interval_ms: 60000,
      provider_api_id: "openai-compatible",
      provider_npm_package: "@ai-sdk/openai-compatible",
      provider_headers: {},
      thinking_budget_tokens: 8192,
      origin: "AI_EDITOR",
      profile_arn: undefined,
      database_path: join(tempRoot, "kiro.db"),
      config_path: join(tempRoot, "kiro.config.json"),
      aws_sso_cache_dir: cacheDir,
      kiro_cli_db_paths: [],
      kiro_cli_auth_paths: [],
      provider_base_url:
        "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse",
    });
    expect(report.imported).toBe(1);
    expect(repo.listAccountSnapshots()).toHaveLength(1);
    repo.close();
  });

  test("imports manual env-backed accounts", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "kiro-manual-"));
    process.env.KIRO_MANUAL_TOKEN = "secret-token";
    const repo = new KiroDatabase(join(tempRoot, "kiro.db"));
    const report = await syncFromManualImport(
      repo,
      {
        email: "user@example.com",
        tokenEnv: "KIRO_MANUAL_TOKEN",
      },
      "us-east-1",
    );
    expect(report.imported).toBe(1);
    const account = repo.listAccountSnapshots()[0];
    const resolved = await resolveSessionToken(account.session!.sourcePointer);
    expect(resolved.token).toBe("secret-token");
    repo.close();
  });
});
