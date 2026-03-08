import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getDefaultAwsSsoCacheDir } from "./utils/paths";

type DeviceLoginInput = {
  region?: string;
  startUrl?: string;
};

const KIRO_AUTH_BASE = "https://prod.us-east-1.auth.desktop.kiro.dev";

async function registerClient(region: string) {
  const response = await fetch(`https://oidc.${region}.amazonaws.com/client/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      clientName: "kiro-opencode-auth",
      clientType: "public",
      scopes: [
        "codewhisperer:completions",
        "codewhisperer:analysis",
        "codewhisperer:conversations",
      ],
      grantTypes: [
        "urn:ietf:params:oauth:grant-type:device_code",
        "refresh_token",
      ],
      issuerUrl: "https://identitycenter.amazonaws.com/ssoins-722374e8c3c8e6c6",
    }),
  });

  if (!response.ok) {
    throw new Error(`Kiro client registration failed (${response.status})`);
  }

  const data = (await response.json()) as {
    clientId: string;
    clientSecret: string;
  };

  return data;
}

async function startDeviceAuthorization(
  clientId: string,
  clientSecret: string,
  startUrl: string,
  region: string,
) {
  const response = await fetch(
    `https://oidc.${region}.amazonaws.com/device_authorization`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        clientId,
        clientSecret,
        startUrl,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Kiro device authorization failed (${response.status})`);
  }

  const data = (await response.json()) as {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete?: string;
    expiresIn: number;
    interval?: number;
  };

  return data;
}

async function pollDeviceToken(
  clientId: string,
  clientSecret: string,
  deviceCode: string,
  region: string,
  intervalSeconds: number,
  expiresInSeconds: number,
) {
  const deadline = Date.now() + expiresInSeconds * 1000;

  while (Date.now() < deadline) {
    const response = await fetch(`https://oidc.${region}.amazonaws.com/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        clientId,
        clientSecret,
        deviceCode,
        grantType: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    const data = (await response.json()) as {
      accessToken?: string;
      refreshToken?: string;
      expiresIn?: number;
      error?: string;
    };

    if (response.ok && data.accessToken) {
      return {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken ?? "",
        expiresIn: data.expiresIn ?? 3600,
      };
    }

    if (data.error && !["authorization_pending", "slow_down"].includes(data.error)) {
      return null;
    }

    await Bun.sleep(intervalSeconds * 1000);
  }

  return null;
}

function decodeJwtEmail(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return null;
    }
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      email?: string;
      preferred_username?: string;
      sub?: string;
    };
    return payload.email ?? payload.preferred_username ?? payload.sub ?? null;
  } catch {
    return null;
  }
}

export async function createKiroDeviceLogin(input: DeviceLoginInput = {}) {
  const region = input.region?.trim() || "us-east-1";
  const startUrl = input.startUrl?.trim() || "https://view.awsapps.com/start";
  const client = await registerClient(region);
  const device = await startDeviceAuthorization(
    client.clientId,
    client.clientSecret,
    startUrl,
    region,
  );

  return {
    url: device.verificationUriComplete ?? device.verificationUri,
    instructions:
      `Open the URL, complete Kiro login, then wait for authentication to finish.\n\n` +
      `User code: ${device.userCode}`,
    method: "auto" as const,
    async callback() {
      const token = await pollDeviceToken(
        client.clientId,
        client.clientSecret,
        device.deviceCode,
        region,
        device.interval ?? 5,
        device.expiresIn,
      );

      if (!token) {
        return { type: "failed" as const };
      }

      return {
        type: "success" as const,
        provider: "kiro",
        access: token.accessToken,
        refresh: token.refreshToken,
        expires: Date.now() + token.expiresIn * 1000,
        accountId: decodeJwtEmail(token.accessToken) ?? undefined,
      };
    },
  };
}

export async function findKiroAuthFile(explicitPath?: string) {
  if (explicitPath?.trim()) {
    return explicitPath.trim();
  }

  const cacheDir = getDefaultAwsSsoCacheDir();
  if (!existsSync(cacheDir)) {
    return null;
  }

  const entries = await readdir(cacheDir);
  if (entries.includes("kiro-auth-token.json")) {
    return join(cacheDir, "kiro-auth-token.json");
  }

  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const filePath = join(cacheDir, entry);
    try {
      const raw = JSON.parse(await readFile(filePath, "utf8")) as {
        refreshToken?: string;
      };
      if (raw.refreshToken?.startsWith("aorAAAAAG")) {
        return filePath;
      }
    } catch {
      continue;
    }
  }

  return null;
}

export async function refreshKiroSocialToken(refreshToken: string) {
  const response = await fetch(`${KIRO_AUTH_BASE}/refreshToken`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ refreshToken }),
  });

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as {
    accessToken?: string;
    refreshToken?: string;
    expiresIn?: number;
  };

  if (!data.accessToken) {
    return null;
  }

  return {
    access: data.accessToken,
    refresh: data.refreshToken ?? refreshToken,
    expires: Date.now() + (data.expiresIn ?? 3600) * 1000,
    accountId: decodeJwtEmail(data.accessToken) ?? undefined,
  };
}
