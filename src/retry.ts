import { ProviderFailure, RetryClassification } from "./types";

export function classifyFailure(error: unknown): {
  classification: RetryClassification;
  message: string;
  statusCode?: number;
} {
  const statusCode = getStatusCode(error);
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Unknown provider error";

  if (statusCode === 429) {
    return { classification: "rate-limit", message, statusCode };
  }
  if (statusCode === 401 || statusCode === 403) {
    return { classification: "auth-expired", message, statusCode };
  }
  if (statusCode === 402) {
    return { classification: "quota-exhausted", message, statusCode };
  }
  if (statusCode && statusCode >= 500) {
    return { classification: "transient", message, statusCode };
  }
  if (/timeout|network|temporar/i.test(message)) {
    return { classification: "transient", message, statusCode };
  }
  return { classification: "fatal", message, statusCode };
}

export function computeBackoffMs(baseDelayMs: number, attempt: number): number {
  const jitter = Math.floor(Math.random() * 250);
  return baseDelayMs * 2 ** Math.max(0, attempt - 1) + jitter;
}

export async function delay(ms: number) {
  await Bun.sleep(ms);
}

export function formatFailures(failures: ProviderFailure[]): string {
  if (failures.length === 0) {
    return "No provider failures recorded.";
  }
  return failures
    .map(
      (failure) =>
        `- ${failure.accountId}: ${failure.classification}${
          failure.statusCode ? ` (${failure.statusCode})` : ""
        } ${failure.message}`,
    )
    .join("\n");
}

function getStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  if ("status" in error && typeof error.status === "number") {
    return error.status;
  }
  if ("statusCode" in error && typeof error.statusCode === "number") {
    return error.statusCode;
  }
  if (
    "response" in error &&
    error.response &&
    typeof error.response === "object" &&
    "status" in error.response &&
    typeof error.response.status === "number"
  ) {
    return error.response.status;
  }
  return undefined;
}
