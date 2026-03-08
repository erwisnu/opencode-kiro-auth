import type { ResolvedSessionMaterial } from "../types";
import { randomUUID } from "node:crypto";

export type KiroRequestContext = {
  baseUrl: string;
  model: string;
  body: Record<string, unknown>;
  session: ResolvedSessionMaterial;
  additionalHeaders?: Record<string, string>;
  profileArn?: string;
  origin?: string;
};

type OpenAIMessage = {
  role: string;
  content?: string | Array<{ type?: string; text?: string; content?: unknown }>;
  tool_calls?: Array<{
    id?: string;
    function?: { name?: string; arguments?: string | Record<string, unknown> };
  }>;
  tool_call_id?: string;
};

function normalizeTextContent(content: OpenAIMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (typeof part.text === "string") {
        return part.text;
      }
      if (typeof part.content === "string") {
        return part.content;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function buildKiroPayload(
  model: string,
  body: Record<string, unknown>,
  profileArn?: string,
  origin = "AI_EDITOR",
) {
  const rawMessages = Array.isArray(body.messages)
    ? (body.messages as OpenAIMessage[])
    : [];
  const tools = Array.isArray(body.tools)
    ? (body.tools as Array<Record<string, unknown>>)
    : [];

  const history: Array<Record<string, unknown>> = [];
  let currentUserMessage = "continue";
  for (const message of rawMessages) {
    if (message.role === "assistant") {
      history.push({
        assistantResponseMessage: {
          content: normalizeTextContent(message.content) || "...",
          ...(message.tool_calls?.length
            ? {
                toolUses: message.tool_calls.map((toolCall) => ({
                  toolUseId: toolCall.id ?? randomUUID(),
                  name: toolCall.function?.name ?? "tool",
                  input:
                    typeof toolCall.function?.arguments === "string"
                      ? JSON.parse(toolCall.function.arguments)
                      : (toolCall.function?.arguments ?? {}),
                })),
              }
            : {}),
        },
      });
      continue;
    }

    const text = normalizeTextContent(message.content);
    currentUserMessage = text || currentUserMessage;
    history.push({
      userInputMessage: {
        content: text || "continue",
        modelId: model,
        ...(tools.length && history.length === 0
          ? {
              userInputMessageContext: {
                tools: tools.map((toolDef) => ({
                  toolSpecification: {
                    name:
                      (toolDef.function as { name?: string } | undefined)?.name ??
                      "tool",
                    description:
                      (toolDef.function as { description?: string } | undefined)
                        ?.description ?? "Tool",
                    inputSchema: {
                      json:
                        (toolDef.function as { parameters?: unknown } | undefined)
                          ?.parameters ?? {},
                    },
                  },
                })),
              },
            }
          : {}),
      },
    });
  }

  const payload: Record<string, unknown> = {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId: randomUUID(),
      currentMessage: {
        userInputMessage: {
          content: `[Context: Current time is ${new Date().toISOString()}]\n\n${currentUserMessage}`,
          modelId: model,
          origin,
        },
      },
      history,
    },
    inferenceConfig: {
      maxTokens:
        typeof body.max_tokens === "number"
          ? body.max_tokens
          : typeof body.max_completion_tokens === "number"
            ? body.max_completion_tokens
            : 32000,
      ...(typeof body.temperature === "number"
        ? { temperature: body.temperature }
        : {}),
      ...(typeof body.top_p === "number" ? { topP: body.top_p } : {}),
    },
  };

  if (profileArn) {
    payload.profileArn = profileArn;
  }

  return payload;
}

export function buildKiroRequest(context: KiroRequestContext): Request {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/vnd.amazon.eventstream",
    "X-Amz-Target":
      "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
    "User-Agent": "AWS-SDK-JS/3.0.0 kiro-ide/1.0.0",
    "X-Amz-User-Agent": "aws-sdk-js/3.0.0 kiro-ide/1.0.0",
    "Amz-Sdk-Request": "attempt=1; max=3",
    "Amz-Sdk-Invocation-Id": randomUUID(),
    ...context.session.headers,
    ...(context.additionalHeaders ?? {}),
  };
  return new Request(context.baseUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(
      buildKiroPayload(
        context.model,
        context.body,
        context.profileArn,
        context.origin,
      ),
    ),
  });
}
