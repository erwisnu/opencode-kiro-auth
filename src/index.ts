import { tool, type Plugin } from "@opencode-ai/plugin";
import {
  KiroPluginRuntime,
  formatAccountSummary,
  formatQuotaSummary,
  formatSyncReports,
  readManualImportSource,
} from "./runtime";

export const KiroAuthPlugin: Plugin = async (ctx) => {
  const runtime = new KiroPluginRuntime(ctx);
  await runtime.init();

  return {
    async config(config) {
      await runtime.applyConfig(config);
    },

    async event({ event }) {
      await runtime.handleEvent(event);
    },

    async "chat.headers"(input, output) {
      const headers = await runtime.prepareChatHeaders({
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        provider: input.provider,
        message: input.message,
      });
      output.headers = {
        ...output.headers,
        ...headers,
      };
    },

    async "chat.params"(input, output) {
      output.options = await runtime.prepareChatParams(
        input.model.id,
        output.options,
      );
    },

    tool: {
      kiro_accounts: tool({
        description: "List all registered Kiro accounts and routing state.",
        args: {
          verbose: tool.schema.boolean().default(true),
        },
        async execute(args, context) {
          context.metadata({ title: "Kiro Accounts" });
          const accounts = runtime.listAccounts();
          return args.verbose
            ? formatAccountSummary(accounts)
            : JSON.stringify(accounts, null, 2);
        },
      }),

      kiro_quota: tool({
        description: "Show Kiro credits and estimated token usage by account.",
        args: {},
        async execute(_, context) {
          context.metadata({ title: "Kiro Quota" });
          return formatQuotaSummary(await runtime.getQuotaSummary());
        },
      }),

      kiro_sync: tool({
        description:
          "Force sync Kiro accounts from Kiro CLI and AWS SSO sources.",
        args: {
          source: tool.schema
            .enum(["all", "kiro-cli", "aws-sso"])
            .default("all"),
        },
        async execute(args, context) {
          context.metadata({ title: "Kiro Sync" });
          const reports = await runtime.syncSource(args.source);
          return formatSyncReports(reports);
        },
      }),

      kiro_add: tool({
        description:
          "Import a Kiro account manually from JSON text, file, or environment reference.",
        args: {
          file: tool.schema.string().optional(),
          json: tool.schema.string().optional(),
          email: tool.schema.string().optional(),
          arn: tool.schema.string().optional(),
          region: tool.schema.string().optional(),
          sessionFile: tool.schema.string().optional(),
          tokenEnv: tool.schema.string().optional(),
          creditsTotal: tool.schema.number().optional(),
          creditsRemaining: tool.schema.number().optional(),
          quotaExpiresAt: tool.schema.number().optional(),
        },
        async execute(args, context) {
          context.metadata({ title: "Kiro Add" });
          const payload =
            args.file || args.json
              ? await readManualImportSource({ file: args.file, json: args.json })
              : {
                  email: args.email,
                  arn: args.arn,
                  region: args.region,
                  sessionFile: args.sessionFile,
                  tokenEnv: args.tokenEnv,
                  creditsTotal: args.creditsTotal,
                  creditsRemaining: args.creditsRemaining,
                  quotaExpiresAt: args.quotaExpiresAt,
                };
          const report = await runtime.importManual(payload);
          return formatSyncReports([report]);
        },
      }),

      kiro_switch: tool({
        description: "Switch or clear the manually selected Kiro account.",
        args: {
          accountId: tool.schema.string().nullable().default(null),
        },
        async execute(args, context) {
          context.metadata({ title: "Kiro Switch" });
          const result = await runtime.switchAccount(args.accountId);
          return JSON.stringify(result, null, 2);
        },
      }),
    },
  };
};

export default KiroAuthPlugin;
