import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  getDefaultAwsSsoCacheDir,
  getDefaultConfigPath,
  getDefaultDatabasePath,
  getKiroAuthJsonCandidates,
  getKiroCliDatabaseCandidates,
} from "./utils/paths";
import { KiroPluginConfig, pluginConfigSchema } from "./types";

export async function loadPluginConfig(): Promise<KiroPluginConfig> {
  const configPath =
    process.env.KIRO_AUTH_CONFIG_PATH ?? getDefaultConfigPath();
  let fromDisk: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    const raw = await readFile(configPath, "utf8");
    fromDisk = JSON.parse(raw) as Record<string, unknown>;
  }

  const merged = {
    config_path: configPath,
    database_path: getDefaultDatabasePath(),
    aws_sso_cache_dir: getDefaultAwsSsoCacheDir(),
    kiro_cli_db_paths: getKiroCliDatabaseCandidates(),
    kiro_cli_auth_paths: getKiroAuthJsonCandidates(),
    ...fromDisk,
  };

  return pluginConfigSchema.parse(merged);
}

export async function ensureConfigDirectory(config: KiroPluginConfig) {
  const target = config.database_path ?? getDefaultDatabasePath();
  await mkdir(dirname(target), { recursive: true });
}
