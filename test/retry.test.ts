import { describe, expect, test } from "bun:test";
import { classifyFailure, computeBackoffMs } from "../src/retry";

describe("retry helpers", () => {
  test("classifies rate limit errors", () => {
    const result = classifyFailure({ status: 429, message: "Too Many Requests" });
    expect(result.classification).toBe("rate-limit");
  });

  test("classifies auth errors", () => {
    const result = classifyFailure({ statusCode: 401, message: "Expired" });
    expect(result.classification).toBe("auth-expired");
  });

  test("backoff grows with attempt number", () => {
    const first = computeBackoffMs(100, 1);
    const second = computeBackoffMs(100, 2);
    expect(second).toBeGreaterThan(first);
  });
});
