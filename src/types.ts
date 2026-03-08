import { z } from "zod";

export const ACCOUNT_SELECTION_STRATEGIES = [
  "lowest-usage",
  "round-robin",
  "sticky",
] as const;

export const ACCOUNT_SOURCES = ["kiro-cli", "aws-sso", "manual"] as const;

export type AccountSelectionStrategy =
  (typeof ACCOUNT_SELECTION_STRATEGIES)[number];
export type KiroAccountSource = (typeof ACCOUNT_SOURCES)[number];

export type AccountHealth = "healthy" | "cooldown" | "expired" | "error";
export type AccountStatus = "active" | "disabled" | "offline";

export const pluginConfigSchema = z.object({
  auto_sync_kiro_cli: z.boolean().default(true),
  auto_sync_aws_sso: z.boolean().default(true),
  account_selection_strategy: z
    .enum(ACCOUNT_SELECTION_STRATEGIES)
    .default("lowest-usage"),
  default_region: z.string().default("us-east-1"),
  rate_limit_retry_delay_ms: z.number().int().positive().default(5000),
  rate_limit_max_retries: z.number().int().min(0).max(10).default(3),
  usage_tracking_enabled: z.boolean().default(true),
  low_quota_threshold_credits: z.number().nonnegative().default(15),
  sync_interval_ms: z.number().int().positive().default(60000),
  provider_base_url: z
    .string()
    .default(
      "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse",
    ),
  provider_api_id: z.string().default("openai-compatible"),
  provider_npm_package: z.string().default("@ai-sdk/openai-compatible"),
  provider_headers: z
    .record(z.string(), z.string())
    .default({
      Accept: "application/vnd.amazon.eventstream",
      "Content-Type": "application/json",
      "X-Amz-Target":
        "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
      "User-Agent": "AWS-SDK-JS/3.0.0 kiro-ide/1.0.0",
      "X-Amz-User-Agent": "aws-sdk-js/3.0.0 kiro-ide/1.0.0",
    }),
  thinking_budget_tokens: z.number().int().positive().default(8192),
  profile_arn: z.string().optional(),
  origin: z.string().default("AI_EDITOR"),
  config_path: z.string().optional(),
  database_path: z.string().optional(),
  aws_sso_cache_dir: z.string().optional(),
  kiro_cli_db_paths: z.array(z.string()).default([]),
  kiro_cli_auth_paths: z.array(z.string()).default([]),
});

export type KiroPluginConfig = z.infer<typeof pluginConfigSchema>;

export type AccountRecord = {
  id: string;
  source: KiroAccountSource;
  email: string;
  arn: string | null;
  region: string | null;
  status: AccountStatus;
  health: AccountHealth;
  manualSelected: boolean;
  placeholderEmail: boolean;
  creditsTotal: number | null;
  creditsRemaining: number | null;
  quotaExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type SessionPointer =
  | {
      kind: "aws-sso-file";
      path: string;
    }
  | {
      kind: "kiro-cli-db";
      path: string;
      table: string;
      keyColumn: string;
      keyValue: string;
      tokenColumn: string;
      expiresColumn?: string;
      emailColumn?: string;
      arnColumn?: string;
      regionColumn?: string;
    }
  | {
      kind: "json-file";
      path: string;
      tokenField?: string;
      expiresField?: string;
      emailField?: string;
      arnField?: string;
      regionField?: string;
    }
  | {
      kind: "env";
      tokenEnv: string;
      expiresAt?: number | null;
      email?: string | null;
      arn?: string | null;
      region?: string | null;
    };

export type SessionRecord = {
  accountId: string;
  sourcePointer: SessionPointer;
  tokenFingerprint: string | null;
  refreshHint: string | null;
  expiresAt: number | null;
  lastSyncAt: number;
  lastRefreshAttemptAt: number | null;
  metadata: Record<string, unknown>;
};

export type UsageWindowRecord = {
  accountId: string;
  model: string;
  periodKey: string;
  creditsUsed: number;
  inputTokensEstimated: number;
  outputTokensEstimated: number;
  requestCount: number;
  lastRequestAt: number | null;
};

export type AccountStateRecord = {
  accountId: string;
  cooldownUntil: number | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastUsedAt: number | null;
  consecutiveFailures: number;
};

export type AccountSnapshot = AccountRecord & {
  session: SessionRecord | null;
  state: AccountStateRecord;
  usage: UsageWindowRecord[];
};

export type SyncReport = {
  source: KiroAccountSource | "all";
  imported: number;
  updated: number;
  skipped: number;
  warnings: string[];
};

export type ResolvedSessionMaterial = {
  accountId: string;
  token: string;
  expiresAt: number | null;
  headers: Record<string, string>;
  source: SessionPointer["kind"];
};

export type UsageDelta = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  creditsUsed?: number;
  timestamp?: number;
};

export type RetryClassification =
  | "rate-limit"
  | "auth-expired"
  | "transient"
  | "quota-exhausted"
  | "fatal";

export type ProviderFailure = {
  accountId: string;
  classification: RetryClassification;
  message: string;
  statusCode?: number;
};

export type ManualImportPayload = {
  id?: string;
  email?: string;
  arn?: string;
  region?: string;
  creditsTotal?: number;
  creditsRemaining?: number;
  quotaExpiresAt?: number;
  sessionFile?: string;
  tokenField?: string;
  expiresField?: string;
  tokenEnv?: string;
};
