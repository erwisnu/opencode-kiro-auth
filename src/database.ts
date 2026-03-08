import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  AccountRecord,
  AccountSnapshot,
  AccountStateRecord,
  SessionPointer,
  SessionRecord,
  UsageDelta,
  UsageWindowRecord,
} from "./types";

type AccountInput = Omit<AccountRecord, "createdAt" | "updatedAt"> & {
  createdAt?: number;
  updatedAt?: number;
};

const DEFAULT_STATE: AccountStateRecord = {
  accountId: "",
  cooldownUntil: null,
  lastErrorCode: null,
  lastErrorMessage: null,
  lastUsedAt: null,
  consecutiveFailures: 0,
};

export class KiroDatabase {
  readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        email TEXT NOT NULL,
        arn TEXT,
        region TEXT,
        status TEXT NOT NULL,
        health TEXT NOT NULL,
        manual_selected INTEGER NOT NULL DEFAULT 0,
        placeholder_email INTEGER NOT NULL DEFAULT 0,
        credits_total REAL,
        credits_remaining REAL,
        quota_expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        account_id TEXT PRIMARY KEY,
        source_pointer TEXT NOT NULL,
        token_fingerprint TEXT,
        refresh_hint TEXT,
        expires_at INTEGER,
        last_sync_at INTEGER NOT NULL,
        last_refresh_attempt_at INTEGER,
        metadata TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS usage_windows (
        account_id TEXT NOT NULL,
        model TEXT NOT NULL,
        period_key TEXT NOT NULL,
        credits_used REAL NOT NULL DEFAULT 0,
        input_tokens_est INTEGER NOT NULL DEFAULT 0,
        output_tokens_est INTEGER NOT NULL DEFAULT 0,
        request_count INTEGER NOT NULL DEFAULT 0,
        last_request_at INTEGER,
        PRIMARY KEY (account_id, model, period_key),
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS account_state (
        account_id TEXT PRIMARY KEY,
        cooldown_until INTEGER,
        last_error_code TEXT,
        last_error_message TEXT,
        last_used_at INTEGER,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS plugin_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  close() {
    this.db.close();
  }

  upsertAccount(input: AccountInput) {
    const now = input.updatedAt ?? Date.now();
    const createdAt = input.createdAt ?? now;
    this.db
      .query(`
        INSERT INTO accounts (
          id, source, email, arn, region, status, health, manual_selected,
          placeholder_email, credits_total, credits_remaining, quota_expires_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          source = excluded.source,
          email = excluded.email,
          arn = excluded.arn,
          region = excluded.region,
          status = excluded.status,
          health = excluded.health,
          manual_selected = excluded.manual_selected,
          placeholder_email = excluded.placeholder_email,
          credits_total = excluded.credits_total,
          credits_remaining = excluded.credits_remaining,
          quota_expires_at = excluded.quota_expires_at,
          updated_at = excluded.updated_at
      `)
      .run(
        input.id,
        input.source,
        input.email,
        input.arn,
        input.region,
        input.status,
        input.health,
        input.manualSelected ? 1 : 0,
        input.placeholderEmail ? 1 : 0,
        input.creditsTotal,
        input.creditsRemaining,
        input.quotaExpiresAt,
        createdAt,
        now,
      );
    this.ensureState(input.id);
  }

  upsertSession(input: SessionRecord) {
    this.db
      .query(`
        INSERT INTO sessions (
          account_id, source_pointer, token_fingerprint, refresh_hint, expires_at,
          last_sync_at, last_refresh_attempt_at, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET
          source_pointer = excluded.source_pointer,
          token_fingerprint = excluded.token_fingerprint,
          refresh_hint = excluded.refresh_hint,
          expires_at = excluded.expires_at,
          last_sync_at = excluded.last_sync_at,
          last_refresh_attempt_at = excluded.last_refresh_attempt_at,
          metadata = excluded.metadata
      `)
      .run(
        input.accountId,
        JSON.stringify(input.sourcePointer),
        input.tokenFingerprint,
        input.refreshHint,
        input.expiresAt,
        input.lastSyncAt,
        input.lastRefreshAttemptAt,
        JSON.stringify(input.metadata ?? {}),
      );
  }

  listAccountSnapshots(): AccountSnapshot[] {
    const accounts = this.db
      .query(`SELECT * FROM accounts ORDER BY updated_at DESC`)
      .all() as Array<Record<string, unknown>>;
    return accounts.map((row) => this.toSnapshot(row));
  }

  getAccountSnapshot(accountId: string): AccountSnapshot | null {
    const row = this.db
      .query(`SELECT * FROM accounts WHERE id = ?`)
      .get(accountId) as Record<string, unknown> | null;
    return row ? this.toSnapshot(row) : null;
  }

  listUsage(accountId: string): UsageWindowRecord[] {
    return this.db
      .query(
        `SELECT * FROM usage_windows WHERE account_id = ? ORDER BY period_key DESC, model ASC`,
      )
      .all(accountId)
      .map((row: unknown) => this.toUsage(row as Record<string, unknown>));
  }

  setPluginState(key: string, value: string | null) {
    if (value === null) {
      this.db.query(`DELETE FROM plugin_state WHERE key = ?`).run(key);
      return;
    }
    this.db
      .query(`
        INSERT INTO plugin_state (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `)
      .run(key, value);
  }

  getPluginState(key: string): string | null {
    const row = this.db
      .query(`SELECT value FROM plugin_state WHERE key = ?`)
      .get(key) as { value: string } | null;
    return row?.value ?? null;
  }

  setManualSelection(accountId: string | null) {
    this.db.exec(`UPDATE accounts SET manual_selected = 0`);
    if (accountId) {
      this.db.query(`UPDATE accounts SET manual_selected = 1 WHERE id = ?`).run(accountId);
      this.setPluginState("manual_override_account_id", accountId);
    } else {
      this.setPluginState("manual_override_account_id", null);
    }
  }

  touchUsage(accountId: string, delta: UsageDelta) {
    const timestamp = delta.timestamp ?? Date.now();
    const periodKey = toPeriodKey(timestamp);
    this.db
      .query(`
        INSERT INTO usage_windows (
          account_id, model, period_key, credits_used, input_tokens_est,
          output_tokens_est, request_count, last_request_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(account_id, model, period_key) DO UPDATE SET
          credits_used = usage_windows.credits_used + excluded.credits_used,
          input_tokens_est = usage_windows.input_tokens_est + excluded.input_tokens_est,
          output_tokens_est = usage_windows.output_tokens_est + excluded.output_tokens_est,
          request_count = usage_windows.request_count + 1,
          last_request_at = excluded.last_request_at
      `)
      .run(
        accountId,
        delta.model,
        periodKey,
        delta.creditsUsed ?? 0,
        delta.inputTokens,
        delta.outputTokens,
        timestamp,
      );
  }

  markAccountUsed(accountId: string, timestamp = Date.now()) {
    this.ensureState(accountId);
    this.db
      .query(`
        UPDATE account_state SET
          last_used_at = ?,
          cooldown_until = NULL,
          last_error_code = NULL,
          last_error_message = NULL,
          consecutive_failures = 0
        WHERE account_id = ?
      `)
      .run(timestamp, accountId);
    this.setPluginState("sticky_account_id", accountId);
  }

  markAccountFailure(
    accountId: string,
    code: string,
    message: string,
    cooldownUntil: number | null,
  ) {
    this.ensureState(accountId);
    this.db
      .query(`
        UPDATE account_state SET
          cooldown_until = ?,
          last_error_code = ?,
          last_error_message = ?,
          consecutive_failures = consecutive_failures + 1
        WHERE account_id = ?
      `)
      .run(cooldownUntil, code, message, accountId);
    this.db
      .query(`UPDATE accounts SET health = ? WHERE id = ?`)
      .run(cooldownUntil && cooldownUntil > Date.now() ? "cooldown" : "error", accountId);
  }

  markAccountHealthy(accountId: string) {
    this.ensureState(accountId);
    this.db.query(`UPDATE accounts SET health = 'healthy' WHERE id = ?`).run(accountId);
    this.db
      .query(`
        UPDATE account_state SET
          cooldown_until = NULL,
          last_error_code = NULL,
          last_error_message = NULL,
          consecutive_failures = 0
        WHERE account_id = ?
      `)
      .run(accountId);
  }

  private ensureState(accountId: string) {
    this.db
      .query(`
        INSERT INTO account_state (account_id, consecutive_failures)
        VALUES (?, 0)
        ON CONFLICT(account_id) DO NOTHING
      `)
      .run(accountId);
  }

  private toSnapshot(accountRow: Record<string, unknown>): AccountSnapshot {
    const account = this.toAccount(accountRow);
    const sessionRow = this.db
      .query(`SELECT * FROM sessions WHERE account_id = ?`)
      .get(account.id) as Record<string, unknown> | null;
    const stateRow = this.db
      .query(`SELECT * FROM account_state WHERE account_id = ?`)
      .get(account.id) as Record<string, unknown> | null;
    return {
      ...account,
      session: sessionRow ? this.toSession(sessionRow) : null,
      state: stateRow ? this.toState(stateRow) : { ...DEFAULT_STATE, accountId: account.id },
      usage: this.listUsage(account.id),
    };
  }

  private toAccount(row: Record<string, unknown>): AccountRecord {
    return {
      id: String(row.id),
      source: row.source as AccountRecord["source"],
      email: String(row.email),
      arn: nullableString(row.arn),
      region: nullableString(row.region),
      status: row.status as AccountRecord["status"],
      health: row.health as AccountRecord["health"],
      manualSelected: Boolean(row.manual_selected),
      placeholderEmail: Boolean(row.placeholder_email),
      creditsTotal: nullableNumber(row.credits_total),
      creditsRemaining: nullableNumber(row.credits_remaining),
      quotaExpiresAt: nullableNumber(row.quota_expires_at),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private toSession(row: Record<string, unknown>): SessionRecord {
    return {
      accountId: String(row.account_id),
      sourcePointer: JSON.parse(String(row.source_pointer)) as SessionPointer,
      tokenFingerprint: nullableString(row.token_fingerprint),
      refreshHint: nullableString(row.refresh_hint),
      expiresAt: nullableNumber(row.expires_at),
      lastSyncAt: Number(row.last_sync_at),
      lastRefreshAttemptAt: nullableNumber(row.last_refresh_attempt_at),
      metadata: JSON.parse(String(row.metadata ?? "{}")) as Record<string, unknown>,
    };
  }

  private toState(row: Record<string, unknown>): AccountStateRecord {
    return {
      accountId: String(row.account_id),
      cooldownUntil: nullableNumber(row.cooldown_until),
      lastErrorCode: nullableString(row.last_error_code),
      lastErrorMessage: nullableString(row.last_error_message),
      lastUsedAt: nullableNumber(row.last_used_at),
      consecutiveFailures: Number(row.consecutive_failures ?? 0),
    };
  }

  private toUsage(row: Record<string, unknown>): UsageWindowRecord {
    return {
      accountId: String(row.account_id),
      model: String(row.model),
      periodKey: String(row.period_key),
      creditsUsed: Number(row.credits_used ?? 0),
      inputTokensEstimated: Number(row.input_tokens_est ?? 0),
      outputTokensEstimated: Number(row.output_tokens_est ?? 0),
      requestCount: Number(row.request_count ?? 0),
      lastRequestAt: nullableNumber(row.last_request_at),
    };
  }
}

export function fingerprintToken(token: string | null | undefined): string | null {
  if (!token) {
    return null;
  }
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

export function toPeriodKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}
