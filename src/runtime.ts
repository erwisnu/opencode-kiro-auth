import type { Config, Event, Provider, UserMessage } from "@opencode-ai/sdk";
import type { PluginInput } from "@opencode-ai/plugin";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { buildProviderModels } from "./models";
import { KiroDatabase } from "./database";
import { ensureConfigDirectory, loadPluginConfig } from "./config";
import { selectAccount } from "./selection";
import { classifyFailure, computeBackoffMs, delay } from "./retry";
import {
  resolveSessionToken,
  syncFromAwsSso,
  syncFromKiroCli,
  syncFromManualImport,
} from "./services/sync";
import type {
  AccountSnapshot,
  KiroPluginConfig,
  ManualImportPayload,
  ProviderFailure,
  ResolvedSessionMaterial,
  SyncReport,
} from "./types";

type SessionBinding = {
  accountId: string;
  model: string;
  selectedAt: number;
};

export class KiroPluginRuntime {
  private readonly ctx: PluginInput;
  private readonly watchers: FSWatcher[] = [];
  private readonly sessionBindings = new Map<string, SessionBinding>();
  private config!: KiroPluginConfig;
  private db!: KiroDatabase;
  private initPromise: Promise<void> | null = null;

  constructor(ctx: PluginInput) {
    this.ctx = ctx;
  }

  async init() {
    if (!this.initPromise) {
      this.initPromise = this.initInternal();
    }
    await this.initPromise;
  }

  private async initInternal() {
    this.config = await loadPluginConfig();
    await ensureConfigDirectory(this.config);
    this.db = new KiroDatabase(this.config.database_path!);
    await this.syncAll();
    this.startWatchers();
  }

  dispose() {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers.length = 0;
    this.db?.close();
  }

  async applyConfig(config: Config) {
    await this.init();
    const target = config as Config & {
      provider?: Record<string, unknown>;
      command?: Record<string, unknown>;
    };
    target.provider ??= {};
    target.command ??= {};

    target.provider.kiro = {
      id: "kiro",
      name: "Kiro AI",
      api: this.config.provider_api_id,
      npm: this.config.provider_npm_package,
      models: buildProviderModels(this.config.thinking_budget_tokens),
      options: {
        baseURL: this.config.provider_base_url,
        timeout: 300_000,
      },
    };

    target.command["kiro:accounts"] = {
      description: "List registered Kiro accounts and current routing status.",
      template: "Use the kiro_accounts tool and summarize the result.",
    };
    target.command["kiro:quota"] = {
      description: "Show Kiro quota and token usage for all accounts.",
      template: "Use the kiro_quota tool and summarize the result.",
    };
    target.command["kiro:sync"] = {
      description: "Force sync Kiro accounts from cache sources.",
      template: "Use the kiro_sync tool and summarize the result.",
    };
    target.command["kiro:add"] = {
      description: "Import a Kiro account from JSON or environment-backed metadata.",
      template: "Use the kiro_add tool with the user-provided details.",
    };
    target.command["kiro:switch"] = {
      description: "Override the selected Kiro account.",
      template: "Use the kiro_switch tool with the requested account id.",
    };
  }

  async syncAll(): Promise<SyncReport[]> {
    const reports: SyncReport[] = [];
    if (this.config.auto_sync_kiro_cli) {
      reports.push(await syncFromKiroCli(this.db, this.config));
    }
    if (this.config.auto_sync_aws_sso) {
      reports.push(await syncFromAwsSso(this.db, this.config));
    }
    return reports;
  }

  async syncSource(source?: "kiro-cli" | "aws-sso" | "all"): Promise<SyncReport[]> {
    await this.init();
    if (!source || source === "all") {
      return this.syncAll();
    }
    if (source === "kiro-cli") {
      return [await syncFromKiroCli(this.db, this.config)];
    }
    return [await syncFromAwsSso(this.db, this.config)];
  }

  listAccounts() {
    return this.db.listAccountSnapshots();
  }

  async importManual(payload: ManualImportPayload | ManualImportPayload[]) {
    await this.init();
    return syncFromManualImport(this.db, payload, this.config.default_region);
  }

  async importFromKiroAuthFile(path?: string) {
    await this.init();
    const payload = {
      id: path ? `manual:${path}` : undefined,
      sessionFile: path,
      tokenField: "accessToken",
      expiresField: "expiresAt",
    };
    return syncFromManualImport(this.db, payload, this.config.default_region);
  }

  async switchAccount(accountId: string | null) {
    await this.init();
    if (accountId !== null) {
      const existing = this.db.getAccountSnapshot(accountId);
      if (!existing) {
        throw new Error(`Account ${accountId} is not registered.`);
      }
    }
    this.db.setManualSelection(accountId);
    return {
      activeAccountId: accountId,
      strategy: this.config.account_selection_strategy,
    };
  }

  async getQuotaSummary() {
    await this.init();
    return this.db.listAccountSnapshots().map((account) => ({
      id: account.id,
      email: account.email,
      source: account.source,
      creditsRemaining: account.creditsRemaining,
      creditsTotal: account.creditsTotal,
      quotaExpiresAt: account.quotaExpiresAt,
      usage: account.usage,
    }));
  }

  async prepareChatHeaders(input: {
    sessionID: string;
    agent: string;
    model: { id: string; providerID: string };
    provider: { info: Provider; options?: Record<string, unknown> };
    message: UserMessage;
  }): Promise<Record<string, string>> {
    await this.init();
    if (input.provider.info.id !== "kiro") {
      return {};
    }

    try {
      const selection = await this.selectAndResolveAccount(
        input.sessionID,
        input.model.id,
      );
      this.db.markAccountUsed(selection.accountId);
      return {
        ...selection.headers,
        "x-kiro-account-id": selection.accountId,
        "x-kiro-model-id": input.model.id,
        ...this.config.provider_headers,
      };
    } catch {
      const accessToken =
        typeof input.provider.options?.accessToken === "string"
          ? input.provider.options.accessToken
          : typeof input.provider.options?.access === "string"
            ? input.provider.options.access
            : null;
      if (!accessToken) {
        throw new Error(
          "No eligible Kiro account is available. Run `opencode auth login`, /kiro:sync, or /kiro:add.",
        );
      }
      return {
        authorization: `Bearer ${accessToken}`,
        "x-kiro-model-id": input.model.id,
        ...this.config.provider_headers,
      };
    }
  }

  async prepareChatParams(modelID: string, options: Record<string, unknown>) {
    await this.init();
    if (!modelID.endsWith("-thinking")) {
      return options;
    }
    return {
      ...options,
      thinking: {
        type: "enabled",
        budget_tokens: this.config.thinking_budget_tokens,
      },
    };
  }

  async handleEvent(event: Event) {
    await this.init();
    if (event.type === "session.created") {
      await this.syncAll();
      return;
    }

    if (event.type === "message.updated") {
      const info = event.properties.info;
      if (info.role !== "assistant" || info.providerID !== "kiro") {
        return;
      }
      const binding = this.sessionBindings.get(info.sessionID);
      if (!binding || !this.config.usage_tracking_enabled) {
        return;
      }
      this.db.touchUsage(binding.accountId, {
        model: binding.model,
        inputTokens: info.tokens.input,
        outputTokens: info.tokens.output,
        reasoningTokens: info.tokens.reasoning,
        creditsUsed: info.cost,
        timestamp: info.time.completed ?? info.time.created,
      });
    }
  }

  async recordToolFailure(accountId: string, error: unknown, attempt: number) {
    const failure = classifyFailure(error);
    const cooldownUntil =
      failure.classification === "rate-limit"
        ? Date.now() +
          computeBackoffMs(this.config.rate_limit_retry_delay_ms, attempt)
        : null;
    this.db.markAccountFailure(
      accountId,
      failure.classification,
      failure.message,
      cooldownUntil,
    );
    return failure;
  }

  async executeWithFailover<T>(
    operation: (session: ResolvedSessionMaterial) => Promise<T>,
    modelID: string,
    sessionID = "tool",
  ): Promise<T> {
    await this.init();
    const failures: ProviderFailure[] = [];
    const tried = new Set<string>();

    for (
      let attempt = 1;
      attempt <= this.config.rate_limit_max_retries + 1;
      attempt += 1
    ) {
      const resolved = await this.selectAndResolveAccount(sessionID, modelID, tried);
      tried.add(resolved.accountId);
      try {
        const result = await operation(resolved);
        this.db.markAccountHealthy(resolved.accountId);
        return result;
      } catch (error) {
        const failure = await this.recordToolFailure(
          resolved.accountId,
          error,
          attempt,
        );
        failures.push({
          accountId: resolved.accountId,
          classification: failure.classification,
          message: failure.message,
          statusCode: failure.statusCode,
        });
        if (
          failure.classification === "rate-limit" ||
          failure.classification === "transient" ||
          failure.classification === "auth-expired"
        ) {
          await delay(
            computeBackoffMs(this.config.rate_limit_retry_delay_ms, attempt),
          );
          continue;
        }
        break;
      }
    }

    throw new Error(
      `All Kiro accounts failed.\n${failures
        .map(
          (failure) =>
            `- ${failure.accountId}: ${failure.classification}${
              failure.statusCode ? ` (${failure.statusCode})` : ""
            } ${failure.message}`,
        )
        .join("\n")}`,
    );
  }

  private async selectAndResolveAccount(
    sessionID: string,
    modelID: string,
    excludeAccountIds: Set<string> = new Set(),
  ): Promise<ResolvedSessionMaterial> {
    const now = Date.now();
    const snapshots = this.db
      .listAccountSnapshots()
      .filter((account) => !excludeAccountIds.has(account.id));
    const manualOverride = this.db.getPluginState("manual_override_account_id");
    const stickyAccount = this.db.getPluginState("sticky_account_id");
    const selection = selectAccount(
      snapshots,
      this.config.account_selection_strategy,
      now,
      stickyAccount,
      manualOverride,
    );
    if (!selection.account || !selection.account.session) {
      throw new Error(
        "No eligible Kiro account is available. Run /kiro:sync or /kiro:add.",
      );
    }
    const material = await this.resolveSessionMaterial(selection.account);
    this.sessionBindings.set(sessionID, {
      accountId: selection.account.id,
      model: modelID,
      selectedAt: now,
    });
    return material;
  }

  private async resolveSessionMaterial(
    account: AccountSnapshot,
  ): Promise<ResolvedSessionMaterial> {
    if (!account.session) {
      throw new Error(`Account ${account.id} does not have a session source.`);
    }
    const resolved = await resolveSessionToken(account.session.sourcePointer);
    if (!resolved.token) {
      throw new Error(
        `Credential source for ${account.id} no longer provides an access token.`,
      );
    }
    const expiresAt = resolved.expiresAt ?? account.session.expiresAt;
    const headers: Record<string, string> = {
      authorization: `Bearer ${resolved.token}`,
      "x-aws-region":
        resolved.region ?? account.region ?? this.config.default_region,
      "x-kiro-account-email": resolved.email ?? account.email,
    };
    if (resolved.arn ?? account.arn) {
      headers["x-aws-arn"] = resolved.arn ?? account.arn!;
    }
    return {
      accountId: account.id,
      token: resolved.token,
      expiresAt,
      headers,
      source: account.session.sourcePointer.kind,
    };
  }

  private startWatchers() {
    const watchedPaths = [
      ...(this.config.auto_sync_kiro_cli ? this.config.kiro_cli_db_paths : []),
      ...(this.config.auto_sync_kiro_cli ? this.config.kiro_cli_auth_paths : []),
    ];
    for (const path of watchedPaths) {
      if (!existsSync(path)) {
        continue;
      }
      this.watchers.push(
        watch(path, { persistent: false }, () => {
          void this.syncAll();
        }),
      );
    }
    if (
      this.config.auto_sync_aws_sso &&
      this.config.aws_sso_cache_dir &&
      existsSync(this.config.aws_sso_cache_dir)
    ) {
      this.watchers.push(
        watch(this.config.aws_sso_cache_dir, { persistent: false }, () => {
          void this.syncSource("aws-sso");
        }),
      );
    }
  }
}

export async function readManualImportSource(input: {
  file?: string;
  json?: string;
}): Promise<ManualImportPayload | ManualImportPayload[]> {
  if (input.file) {
    const raw = await readFile(input.file, "utf8");
    return JSON.parse(raw) as ManualImportPayload | ManualImportPayload[];
  }
  if (input.json) {
    return JSON.parse(input.json) as ManualImportPayload | ManualImportPayload[];
  }
  throw new Error("Manual import requires either file or json input.");
}

export function formatAccountSummary(accounts: AccountSnapshot[]): string {
  if (accounts.length === 0) {
    return "No Kiro accounts registered.";
  }
  return accounts
    .map((account) => {
      const cooldown =
        account.state.cooldownUntil && account.state.cooldownUntil > Date.now()
          ? ` cooldown-until=${new Date(account.state.cooldownUntil).toISOString()}`
          : "";
      const expiry = account.session?.expiresAt
        ? ` expires=${new Date(account.session.expiresAt).toISOString()}`
        : "";
      return `${account.id}
  email=${account.email}
  source=${account.source}
  status=${account.status}/${account.health}
  region=${account.region ?? "unknown"}${cooldown}${expiry}
  manual=${account.manualSelected}
  credits=${account.creditsRemaining ?? "?"}/${account.creditsTotal ?? "?"}`;
    })
    .join("\n\n");
}

export function formatQuotaSummary(
  quota: Awaited<ReturnType<KiroPluginRuntime["getQuotaSummary"]>>,
): string {
  if (quota.length === 0) {
    return "No Kiro quota information is available.";
  }
  return quota
    .map((entry) => {
      const usageLines = entry.usage.length
        ? entry.usage
            .map(
              (usage) =>
                `  - ${usage.model} ${usage.periodKey}: credits=${usage.creditsUsed}, input=${usage.inputTokensEstimated}, output=${usage.outputTokensEstimated}, requests=${usage.requestCount}`,
            )
            .join("\n")
        : "  - no usage tracked";
      return `${entry.id} (${entry.email})
credits=${entry.creditsRemaining ?? "?"}/${entry.creditsTotal ?? "?"}
quota_expires=${entry.quotaExpiresAt ? new Date(entry.quotaExpiresAt).toISOString() : "unknown"}
${usageLines}`;
    })
    .join("\n\n");
}

export function formatSyncReports(reports: SyncReport[]): string {
  return reports
    .map(
      (report) =>
        `${report.source}: imported=${report.imported} updated=${report.updated} skipped=${report.skipped}${
          report.warnings.length
            ? `\nwarnings:\n- ${report.warnings.join("\n- ")}`
            : ""
        }`,
    )
    .join("\n\n");
}
