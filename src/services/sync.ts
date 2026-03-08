import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { KiroDatabase, fingerprintToken } from "../database";
import {
  KiroPluginConfig,
  ManualImportPayload,
  SessionPointer,
  SyncReport,
} from "../types";

function placeholderEmail(seed: string) {
  const clean = seed.replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "unknown";
  return `${clean}@offline.kiro.local`;
}

function normalizeTimestamp(value: unknown): number | null {
  if (typeof value === "number") {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function extractScalar(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

function inferRegion(record: Record<string, unknown>, fallback: string) {
  return extractScalar(record, ["region", "awsRegion", "sso_region"]) ?? fallback;
}

function inferCredits(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

export async function syncFromAwsSso(
  repo: KiroDatabase,
  config: KiroPluginConfig,
): Promise<SyncReport> {
  const report: SyncReport = {
    source: "aws-sso",
    imported: 0,
    updated: 0,
    skipped: 0,
    warnings: [],
  };
  const cacheDir = config.aws_sso_cache_dir;
  if (!cacheDir || !existsSync(cacheDir)) {
    report.warnings.push("AWS SSO cache directory not found.");
    return report;
  }

  const entries = await readdir(cacheDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".json") {
      continue;
    }
    const filePath = `${cacheDir}/${entry.name}`.replace(/\\/g, "/");
    try {
      const raw = JSON.parse(await readFile(filePath, "utf8")) as Record<
        string,
        unknown
      >;
      const token = extractScalar(raw, ["accessToken"]);
      if (!token) {
        report.skipped += 1;
        continue;
      }
      const seed =
        extractScalar(raw, ["clientId", "startUrl", "region"]) ?? basename(filePath);
      const email =
        extractScalar(raw, ["email", "username", "subject", "clientName"]) ??
        placeholderEmail(seed);
      const accountId = `aws-sso:${seed}`;
      const expiresAt = normalizeTimestamp(raw.expiresAt);
      repo.upsertAccount({
        id: accountId,
        source: "aws-sso",
        email,
        arn: extractScalar(raw, ["arn"]),
        region: inferRegion(raw, config.default_region),
        status: "active",
        health: expiresAt && expiresAt <= Date.now() ? "expired" : "healthy",
        manualSelected: false,
        placeholderEmail: email.endsWith("@offline.kiro.local"),
        creditsTotal: inferCredits(raw, "creditsTotal"),
        creditsRemaining: inferCredits(raw, "creditsRemaining"),
        quotaExpiresAt: normalizeTimestamp(raw.quotaExpiresAt),
      });
      repo.upsertSession({
        accountId,
        sourcePointer: { kind: "aws-sso-file", path: filePath },
        tokenFingerprint: fingerprintToken(token),
        refreshHint: extractScalar(raw, ["refreshToken"]),
        expiresAt,
        lastSyncAt: Date.now(),
        lastRefreshAttemptAt: null,
        metadata: {
          startUrl: extractScalar(raw, ["startUrl"]),
          region: inferRegion(raw, config.default_region),
        },
      });
      report.imported += 1;
    } catch (error) {
      report.warnings.push(
        `Failed to parse AWS SSO cache ${filePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return report;
}

export async function syncFromManualImport(
  repo: KiroDatabase,
  payload: ManualImportPayload | ManualImportPayload[],
  defaultRegion: string,
): Promise<SyncReport> {
  const entries = Array.isArray(payload) ? payload : [payload];
  const report: SyncReport = {
    source: "manual",
    imported: 0,
    updated: 0,
    skipped: 0,
    warnings: [],
  };

  for (const entry of entries) {
    const seed =
      entry.email ??
      entry.arn ??
      entry.tokenEnv ??
      entry.sessionFile ??
      crypto.randomUUID();
    const id = entry.id ?? `manual:${seed}`;
    const email = entry.email ?? placeholderEmail(seed);
    let pointer: SessionPointer | null = null;

    if (entry.sessionFile) {
      pointer = {
        kind: "json-file",
        path: entry.sessionFile,
        tokenField: entry.tokenField ?? "accessToken",
        expiresField: entry.expiresField ?? "expiresAt",
      };
    } else if (entry.tokenEnv) {
      pointer = {
        kind: "env",
        tokenEnv: entry.tokenEnv,
        expiresAt: entry.quotaExpiresAt ?? null,
        email: entry.email ?? null,
        arn: entry.arn ?? null,
        region: entry.region ?? defaultRegion,
      };
    }

    if (!pointer) {
      report.skipped += 1;
      report.warnings.push(`Skipped ${id}: no session source provided.`);
      continue;
    }

    repo.upsertAccount({
      id,
      source: "manual",
      email,
      arn: entry.arn ?? null,
      region: entry.region ?? defaultRegion,
      status: "active",
      health: "healthy",
      manualSelected: false,
      placeholderEmail: !entry.email,
      creditsTotal: entry.creditsTotal ?? null,
      creditsRemaining: entry.creditsRemaining ?? null,
      quotaExpiresAt: entry.quotaExpiresAt ?? null,
    });
    repo.upsertSession({
      accountId: id,
      sourcePointer: pointer,
      tokenFingerprint: null,
      refreshHint: null,
      expiresAt: entry.quotaExpiresAt ?? null,
      lastSyncAt: Date.now(),
      lastRefreshAttemptAt: null,
      metadata: {},
    });
    report.imported += 1;
  }
  return report;
}

export async function syncFromKiroCli(
  repo: KiroDatabase,
  config: KiroPluginConfig,
): Promise<SyncReport> {
  const report: SyncReport = {
    source: "kiro-cli",
    imported: 0,
    updated: 0,
    skipped: 0,
    warnings: [],
  };

  for (const candidate of config.kiro_cli_auth_paths) {
    if (!existsSync(candidate)) {
      continue;
    }
    try {
      const raw = JSON.parse(await readFile(candidate, "utf8")) as Record<
        string,
        unknown
      >;
      const token = extractScalar(raw, ["accessToken", "token"]);
      const email =
        extractScalar(raw, ["email", "username"]) ?? placeholderEmail(candidate);
      const accountId = `kiro-cli:${candidate}`;
      const expiresAt = normalizeTimestamp(raw.expiresAt);
      repo.upsertAccount({
        id: accountId,
        source: "kiro-cli",
        email,
        arn: extractScalar(raw, ["arn"]),
        region: inferRegion(raw, config.default_region),
        status: "active",
        health: expiresAt && expiresAt <= Date.now() ? "expired" : "healthy",
        manualSelected: false,
        placeholderEmail: email.endsWith("@offline.kiro.local"),
        creditsTotal: inferCredits(raw, "creditsTotal"),
        creditsRemaining: inferCredits(raw, "creditsRemaining"),
        quotaExpiresAt: normalizeTimestamp(raw.quotaExpiresAt),
      });
      repo.upsertSession({
        accountId,
        sourcePointer: {
          kind: "json-file",
          path: candidate,
          tokenField: "accessToken",
          expiresField: "expiresAt",
        },
        tokenFingerprint: fingerprintToken(token),
        refreshHint: null,
        expiresAt,
        lastSyncAt: Date.now(),
        lastRefreshAttemptAt: null,
        metadata: {},
      });
      report.imported += 1;
    } catch (error) {
      report.warnings.push(
        `Failed to parse Kiro auth JSON ${candidate}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  for (const dbPath of config.kiro_cli_db_paths) {
    if (!existsSync(dbPath)) {
      continue;
    }
    try {
      const db = new Database(dbPath, { readonly: true });
      const tables = db
        .query(`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .all() as Array<{ name: string }>;
      for (const table of tables) {
        const tableName = table.name;
        const lower = tableName.toLowerCase();
        if (!/(session|auth|account|token)/.test(lower)) {
          continue;
        }
        const columns = db
          .query(`PRAGMA table_info(${tableName})`)
          .all() as Array<{ name: string }>;
        const names = columns.map((column) => column.name);
        const tokenColumn = names.find((name) => /access.*token|token/i.test(name));
        const keyColumn = names.find((name) => /id|key/i.test(name));
        if (!tokenColumn || !keyColumn) {
          continue;
        }
        const emailColumn = names.find((name) => /email|username/i.test(name));
        const arnColumn = names.find((name) => /arn/i.test(name));
        const regionColumn = names.find((name) => /region/i.test(name));
        const expiresColumn = names.find((name) => /expire/i.test(name));
        const rows = db
          .query(`SELECT * FROM ${tableName} LIMIT 25`)
          .all() as Array<Record<string, unknown>>;
        for (const row of rows) {
          const token =
            typeof row[tokenColumn] === "string"
              ? (row[tokenColumn] as string)
              : null;
          if (!token) {
            continue;
          }
          const keyValue = String(row[keyColumn]);
          const email =
            (emailColumn ? extractScalar(row, [emailColumn]) : null) ??
            placeholderEmail(keyValue);
          const accountId = `kiro-cli:${dbPath}:${tableName}:${keyValue}`;
          const expiresAt =
            expiresColumn ? normalizeTimestamp(row[expiresColumn]) : null;
          repo.upsertAccount({
            id: accountId,
            source: "kiro-cli",
            email,
            arn: arnColumn ? extractScalar(row, [arnColumn]) : null,
            region: regionColumn
              ? extractScalar(row, [regionColumn])
              : config.default_region,
            status: "active",
            health: expiresAt && expiresAt <= Date.now() ? "expired" : "healthy",
            manualSelected: false,
            placeholderEmail: email.endsWith("@offline.kiro.local"),
            creditsTotal: inferCredits(row, "creditsTotal"),
            creditsRemaining: inferCredits(row, "creditsRemaining"),
            quotaExpiresAt: inferCredits(row, "quotaExpiresAt"),
          });
          repo.upsertSession({
            accountId,
            sourcePointer: {
              kind: "kiro-cli-db",
              path: dbPath,
              table: tableName,
              keyColumn,
              keyValue,
              tokenColumn,
              expiresColumn,
              emailColumn,
              arnColumn,
              regionColumn,
            },
            tokenFingerprint: fingerprintToken(token),
            refreshHint: null,
            expiresAt,
            lastSyncAt: Date.now(),
            lastRefreshAttemptAt: null,
            metadata: {},
          });
          report.imported += 1;
        }
      }
      db.close();
    } catch (error) {
      report.warnings.push(
        `Failed to inspect Kiro CLI DB ${dbPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  if (report.imported === 0 && report.warnings.length === 0) {
    report.warnings.push("No Kiro CLI credential sources were found.");
  }
  return report;
}

export async function resolveSessionToken(pointer: SessionPointer): Promise<{
  token: string | null;
  expiresAt: number | null;
  email?: string | null;
  arn?: string | null;
  region?: string | null;
}> {
  if (pointer.kind === "env") {
    return {
      token: process.env[pointer.tokenEnv] ?? null,
      expiresAt: pointer.expiresAt ?? null,
      email: pointer.email ?? null,
      arn: pointer.arn ?? null,
      region: pointer.region ?? null,
    };
  }

  if (pointer.kind === "aws-sso-file" || pointer.kind === "json-file") {
    const raw = JSON.parse(await readFile(pointer.path, "utf8")) as Record<
      string,
      unknown
    >;
    const tokenField =
      pointer.kind === "json-file" ? pointer.tokenField ?? "accessToken" : "accessToken";
    const expiresField =
      pointer.kind === "json-file" ? pointer.expiresField ?? "expiresAt" : "expiresAt";
    return {
      token: extractScalar(raw, [tokenField]),
      expiresAt: normalizeTimestamp(raw[expiresField]),
      email:
        pointer.kind === "json-file"
          ? extractScalar(raw, [pointer.emailField ?? "email"])
          : extractScalar(raw, ["email", "username"]),
      arn:
        pointer.kind === "json-file"
          ? extractScalar(raw, [pointer.arnField ?? "arn"])
          : extractScalar(raw, ["arn"]),
      region:
        pointer.kind === "json-file"
          ? extractScalar(raw, [pointer.regionField ?? "region"])
          : extractScalar(raw, ["region"]),
    };
  }

  const db = new Database(pointer.path, { readonly: true });
  const row = db
    .query(`SELECT * FROM ${pointer.table} WHERE ${pointer.keyColumn} = ? LIMIT 1`)
    .get(pointer.keyValue) as Record<string, unknown> | null;
  db.close();
  if (!row) {
    return { token: null, expiresAt: null };
  }
  return {
    token:
      typeof row[pointer.tokenColumn] === "string"
        ? (row[pointer.tokenColumn] as string)
        : null,
    expiresAt: pointer.expiresColumn
      ? normalizeTimestamp(row[pointer.expiresColumn])
      : null,
    email: pointer.emailColumn ? extractScalar(row, [pointer.emailColumn]) : null,
    arn: pointer.arnColumn ? extractScalar(row, [pointer.arnColumn]) : null,
    region: pointer.regionColumn ? extractScalar(row, [pointer.regionColumn]) : null,
  };
}
