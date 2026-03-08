import { describe, expect, test } from "bun:test";
import type { Config } from "@opencode-ai/sdk";
import { KiroAuthPlugin } from "../src/index";

describe("plugin registration", () => {
  test("registers provider and tools", async () => {
    const plugin = await KiroAuthPlugin({
      client: {} as never,
      project: {} as never,
      directory: process.cwd(),
      worktree: process.cwd(),
      serverUrl: new URL("http://localhost"),
      $: {} as never,
    });

    const config = {} as Config;
    await plugin.config?.(config);
    const shaped = config as Config & {
      provider?: Record<string, unknown>;
      command?: Record<string, unknown>;
    };
    expect(shaped.provider?.kiro).toBeDefined();
    expect(plugin.tool?.kiro_accounts).toBeDefined();
    expect(shaped.command?.["kiro:quota"]).toBeDefined();
  });
});
