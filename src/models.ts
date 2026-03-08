type InputModality = "text" | "audio" | "image" | "video" | "pdf";
type OutputModality = InputModality;

const defaultInputModalities: InputModality[] = ["text", "image", "pdf"];
const defaultOutputModalities: OutputModality[] = ["text"];

type ModelDefinition = {
  id: string;
  name: string;
  reasoning: boolean;
  cost: {
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
  };
  options?: Record<string, unknown>;
};

export const KIRO_MODELS: Record<string, ModelDefinition> = {
  "claude-sonnet-4-5": {
    id: "claude-sonnet-4.5",
    name: "Claude Sonnet 4.5",
    reasoning: false,
    cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  },
  "claude-haiku-4-5": {
    id: "claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    reasoning: false,
    cost: { input: 0.8, output: 4, cache_read: 0.08, cache_write: 1 },
  },
};

export function buildProviderModels(thinkingBudgetTokens: number) {
  return Object.fromEntries(
    Object.entries(KIRO_MODELS).map(([id, definition]) => [
      id,
      {
        id: definition.id,
        name: definition.name,
        attachment: true,
        reasoning: definition.reasoning,
        temperature: true,
        tool_call: true,
        cost: definition.cost,
        limit: {
          context: 200_000,
          output: 64_000,
        },
        modalities: {
          input: [...defaultInputModalities],
          output: [...defaultOutputModalities],
        },
        options: definition.reasoning
          ? {
              ...(definition.options ?? {}),
              thinking: {
                type: "enabled",
                budget_tokens: thinkingBudgetTokens,
              },
            }
          : definition.options ?? {},
      },
    ]),
  );
}
