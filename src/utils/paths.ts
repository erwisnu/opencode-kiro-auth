import { join } from "node:path";

const isWindows = process.platform === "win32";

export function getHomeDirectory(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();
}

export function getConfigDirectory(): string {
  if (isWindows) {
    return (
      process.env.APPDATA ??
      join(getHomeDirectory(), "AppData", "Roaming", "opencode")
    );
  }
  return join(getHomeDirectory(), ".config", "opencode");
}

export function getDefaultDatabasePath(): string {
  return join(getConfigDirectory(), "kiro.db");
}

export function getDefaultConfigPath(): string {
  return join(getConfigDirectory(), "kiro.config.json");
}

export function getDefaultAwsSsoCacheDir(): string {
  return join(getHomeDirectory(), ".aws", "sso", "cache");
}

export function getKiroCliDatabaseCandidates(): string[] {
  const home = getHomeDirectory();
  const base = [
    join(home, ".local", "share", "kiro-cli", "cache.db"),
    join(home, ".config", "kiro", "cache.db"),
  ];
  if (isWindows) {
    base.push(join(home, "AppData", "Local", "kiro-cli", "cache.db"));
    base.push(join(home, "AppData", "Roaming", "kiro-cli", "cache.db"));
  }
  return [...new Set(base)];
}

export function getKiroAuthJsonCandidates(): string[] {
  const home = getHomeDirectory();
  const base = [
    join(home, ".config", "kiro", "kiro-auth-token.json"),
    join(home, ".kiro", "kiro-auth-token.json"),
  ];
  if (isWindows) {
    base.push(join(home, "AppData", "Roaming", "kiro", "kiro-auth-token.json"));
  }
  return [...new Set(base)];
}
