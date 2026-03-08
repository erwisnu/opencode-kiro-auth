import { tool, type Plugin } from "@opencode-ai/plugin";
import {
  KiroPluginRuntime,
  formatAccountSummary,
  formatQuotaSummary,
  formatSyncReports,
  readManualImportSource,
} from "./runtime";
import {
  createKiroDeviceLogin,
  findKiroAuthFile,
  refreshKiroSocialToken,
} from "./auth";

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

    auth: {
      provider: "kiro",
      async loader(auth) {
        const credentials = await auth();
        if (credentials.type === "oauth") {
          return {
            accessToken: credentials.access,
            refreshToken: credentials.refresh,
            expiresAt: credentials.expires,
          };
        }
        if (credentials.type === "api") {
          return {
            importedAccount: credentials.key,
          };
        }
        return {};
      },
      methods: [
        {
          type: "oauth",
          label: "Login via Kiro Web",
          prompts: [
            {
              type: "select",
              key: "auth_method",
              message: "Choose Kiro login method",
              options: [
                {
                  label: "AWS Builder ID",
                  value: "builder-id",
                  hint: "Recommended for Kiro free tier",
                },
                {
                  label: "AWS IAM Identity Center",
                  value: "idc",
                  hint: "Use custom start URL and region",
                },
              ],
            },
            {
              type: "text",
              key: "start_url",
              message: "AWS start URL",
              placeholder: "https://view.awsapps.com/start",
              condition: (inputs) => inputs.auth_method === "idc",
            },
            {
              type: "text",
              key: "region",
              message: "AWS region",
              placeholder: "us-east-1",
              condition: (inputs) => inputs.auth_method === "idc",
            },
          ],
          async authorize(inputs) {
            return createKiroDeviceLogin({
              startUrl: inputs?.start_url,
              region: inputs?.region,
            });
          },
        },
        {
          type: "api",
          label: "Import from Kiro Auth",
          prompts: [
            {
              type: "text",
              key: "path",
              message: "Optional path to kiro-auth-token.json",
              placeholder: "~/.aws/sso/cache/kiro-auth-token.json",
            },
          ],
          async authorize(inputs) {
            const filePath = await findKiroAuthFile(inputs?.path);
            if (!filePath) {
              return { type: "failed" as const };
            }

            const report = await runtime.importFromKiroAuthFile(filePath);
            if (report.imported > 0) {
              return {
                type: "success" as const,
                key: filePath,
                provider: "kiro",
              };
            }

            return { type: "failed" as const };
          },
        },
        {
          type: "api",
          label: "Import Refresh Token",
          prompts: [
            {
              type: "text",
              key: "refresh_token",
              message: "Paste Kiro refresh token",
              placeholder: "aorAAAAAG...",
              validate: (value) =>
                value.startsWith("aorAAAAAG")
                  ? undefined
                  : "Kiro refresh token usually starts with aorAAAAAG",
            },
          ],
          async authorize(inputs) {
            const refreshToken = inputs?.refresh_token?.trim();
            if (!refreshToken) {
              return { type: "failed" as const };
            }

            const token = await refreshKiroSocialToken(refreshToken);
            if (!token) {
              return { type: "failed" as const };
            }

            return {
              type: "success" as const,
              key: refreshToken,
              provider: "kiro",
            };
          },
        },
      ],
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
